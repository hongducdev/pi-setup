/**
 * `/goal new <goal>` — Orca "Multi-task" style: every goal gets its own worktree AND
 * its own Pi process whose cwd is that worktree (Pi cannot change a session's cwd).
 *
 * Flow: setupIsolation(worktree) → registry entry status "pending" (+ mode, git) →
 * launch `pi` in the worktree (Orca: `orca terminal create --worktree id:<id> --command pi`;
 * else a new console window on Windows; else print the command) → the new session's
 * goal-orch sees a pending goal for its cwd on session_start, claims it and starts planning.
 * The prompt is NOT passed on the command line, so it works for any Pi argv handling.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type GoalOrchConfig } from "./config.ts";
import { setupIsolation } from "./git.ts";
import { createOrcaTerminal } from "./orca.ts";
import { buildPlanKickoffMessage } from "./planner.ts";
import { claimPending, goalsInFolder, isLive, listGoals, patchGoal, realKey, type RegistryEntry } from "./registry.ts";
import { newRunId } from "./results.ts";
import { getState, persistState, setState } from "./state.ts";
import { emptyGoalState, type GoalMode, type GoalState } from "./types.ts";

export interface LaunchDeps {
  /** test hook: replaces spawning a console window */
  openWindow?: (cwd: string, command: string, title: string) => boolean;
}

function openConsoleWindow(cwd: string, command: string, title: string): boolean {
  if (process.platform !== "win32") return false;
  try {
    const child = spawn("cmd.exe", ["/c", "start", `"${title.replace(/"/g, "")}"`, "/D", `"${cwd}"`, "cmd", "/k", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function newGoal(
  cwd: string,
  goal: string,
  mode: GoalMode,
  modeFromUser: boolean,
  cfg: GoalOrchConfig = loadConfig(),
  deps: LaunchDeps = {},
): { ok: boolean; message: string; entry?: RegistryEntry } {
  const iso = setupIsolation(cwd, goal, "worktree", cfg);
  if (iso.error) return { ok: false, message: `Goal not started: ${iso.error}` };
  if (!iso.git) return { ok: false, message: "`/goal new` needs a git repo (it creates a worktree). Use `/goal --no-git <goal>` to run here instead." };
  const g = iso.git;
  patchGoal(g.id, { status: "pending", mode: modeFromUser ? mode : undefined, git: g });
  const title = `goal: ${path.basename(g.workdir)}`.slice(0, 60);
  const notes = [...iso.notes];
  let launcher = "manual";
  const want = cfg.newLauncher;
  if (g.orcaId && (want === "auto" || want === "orca")) {
    const t = createOrcaTerminal(g.orcaId, title, cfg.piCommand, cfg.orcaFocus);
    if (t.handle) {
      launcher = "orca";
      notes.push(`Orca: started \`${cfg.piCommand}\` in the worktree's terminal (${t.handle})${cfg.orcaFocus ? "" : " — open the worktree in Orca to watch"}.`);
    } else notes.push(`Orca: terminal create failed (${t.error}).`);
  }
  if (launcher === "manual" && (want === "auto" || want === "window")) {
    if ((deps.openWindow ?? openConsoleWindow)(g.workdir, cfg.piCommand, title)) {
      launcher = "window";
      notes.push(`Started \`${cfg.piCommand}\` in a new console window at ${g.workdir}.`);
    }
  }
  if (launcher === "manual") notes.push(`Start it yourself: \`cd "${g.workdir}"; ${cfg.piCommand}\` — the goal begins automatically in that session.`);
  patchGoal(g.id, { launcher });
  return {
    ok: true,
    message: `New goal → own Pi session in worktree \`${g.workdir}\` (branch \`${g.branch}\`). This session stays free.\n${notes.join("\n")}`,
    entry: { ...(listGoals().find((e) => e.id === g.id) as RegistryEntry) },
  };
}

/** session_start: if `/goal new` registered a pending goal for this cwd, take it and start planning. */
export function maybeStartPending(pi: ExtensionAPI, ctx: ExtensionContext, delayMs = 1500): GoalState | null {
  const cur = getState();
  if (cur.status === "running" || cur.status === "planning" || cur.status === "paused") return null;
  const cwd = ctx.cwd || process.cwd();
  const entry = claimPending(cwd);
  if (!entry?.git) return null;
  const mode: GoalMode = entry.mode ?? "AFK";
  const state: GoalState = {
    ...emptyGoalState(),
    status: "planning",
    goal: entry.goal,
    mode,
    modeSource: entry.mode ? "user" : "default",
    git: entry.git,
    workdir: entry.git.workdir,
    runId: newRunId(entry.goal),
  };
  setState(state);
  persistState(pi, state);
  const kick = () => {
    try {
      ctx.ui?.notify?.(`pi-goal-orch: starting goal from \`/goal new\` in this worktree (${entry.git!.branch}).`, "info");
    } catch {
      /* no UI */
    }
    pi.sendUserMessage(buildPlanKickoffMessage(pi, entry.goal, mode), { deliverAs: "followUp" });
  };
  if (delayMs > 0) setTimeout(kick, delayMs).unref?.();
  else kick();
  return state;
}

/** 4a: another live goal already works in this folder → refuse (returns the message). */
export function folderBusy(dir: string, exceptId?: string): string | null {
  const busy = goalsInFolder(dir, exceptId);
  if (!busy.length) return null;
  const b = busy[0];
  return `Another goal is already running in ${dir} (${b.status}${b.branch ? `, branch ${b.branch}` : ""}, pid ${b.pid}): "${b.goal.slice(0, 80)}". Two goals in one folder share the index and files (index.lock / overwritten work). Use \`/goal new <goal>\` (own worktree + own Pi) or \`/goal --worktree <goal>\`, or finish/cancel the other goal first.`;
}

export function formatGoalList(): string {
  const all = listGoals().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!all.length) return "No goals in the registry.";
  const icon: Record<string, string> = { pending: "…", active: "→", merging: "⇄", merged: "✓", done: "✓", abandoned: "✗" };
  const lines = all.slice(0, 20).map((g) => {
    const live = isLive(g);
    const st = g.status === "active" || g.status === "merging" ? (live ? g.status : `${g.status}, session gone`) : g.status;
    const when = new Date(g.updatedAt).toLocaleString("sv-SE").slice(5, 16);
    return `  ${icon[g.status] ?? "?"} [${st}] ${g.branch || "(no git)"} — ${g.goal.slice(0, 60)}\n      ${g.workdir}${g.launcher ? ` · ${g.launcher}` : ""} · ${when}${g.files?.length ? ` · ${g.files.length} files` : ""}`;
  });
  return `Goals (${all.length}${all.length > 20 ? ", newest 20" : ""}):\n${lines.join("\n")}`;
}

/** cd targets in a shell command (cd / Set-Location / pushd / git -C), WSL /mnt/x paths mapped. */
export function cdTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[;&|(]\s*|&&\s*)(?:cd|Set-Location|sl|pushd|chdir)\s+(?:-LiteralPath\s+|-Path\s+|\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|)]+)|\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/gi;
  for (const m of command.matchAll(re)) {
    let p = (m[1] ?? m[2] ?? "").replace(/^["']|["']$/g, "");
    if (!p || p === "-" || p.startsWith("$") || p.startsWith("%")) continue;
    const w = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
    if (w) p = `${w[1].toUpperCase()}:/${w[2]}`;
    if (p.startsWith("~")) continue;
    out.push(path.resolve(cwd, p));
  }
  return out;
}

/** realKey of the deepest existing ancestor + the rest (cd targets may not exist yet) */
function keyOf(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return realKey(p);
    rest.unshift(path.basename(cur));
    cur = up;
  }
  const tail = rest.join("/");
  return tail ? `${realKey(cur)}/${process.platform === "win32" ? tail.toLowerCase() : tail}` : realKey(cur);
}
export const insideDir = (p: string, dir: string) => {
  if (!p || !dir) return false;
  const a = keyOf(p), b = keyOf(dir);
  return a === b || a.startsWith(b + "/");
};

/** 4c: warn when a goal's shell command leaves its worktree (main tree / another goal's folder). */
export function strayCdWarning(state: GoalState, command: string, cwd: string): string | null {
  if (state.status !== "running" && state.status !== "planning") return null;
  const home = state.git?.workdir ?? state.workdir;
  if (!home) return null;
  const myId = state.git?.id ?? state.regId;
  for (const t of cdTargets(command, cwd)) {
    if (insideDir(t, home)) continue;
    const other = listGoals().find((g) => g.id !== myId && isLive(g) && insideDir(t, g.workdir));
    if (other) return `⚠ goal command enters another goal's folder ${other.workdir} ("${other.goal.slice(0, 50)}") — this goal works in ${home}.`;
    if (state.git && insideDir(t, state.git.repo)) return `⚠ goal command enters the main checkout ${t} — this goal's worktree is ${home} (the main tree may hold the user's uncommitted work).`;
  }
  return null;
}

export function registerStrayCdGuard(pi: ExtensionAPI): void {
  const warned = new Set<string>();
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      const command = event?.input?.command;
      if (typeof command !== "string" || !/^(bash|powershell)$/.test(event?.toolName ?? "")) return;
      const w = strayCdWarning(getState(), command, ctx?.cwd ?? process.cwd());
      if (!w || warned.has(w)) return;
      warned.add(w);
      ctx?.ui?.notify?.(`pi-goal-orch: ${w}`, "warning");
    } catch {
      /* never block tools */
    }
  });
}

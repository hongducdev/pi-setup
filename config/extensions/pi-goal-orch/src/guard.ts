/**
 * Hard worktree guard (tool_call hook). While a goal is active, mutating work must
 * stay inside the goal's folder (worktree). Prompt instructions alone were ignored
 * by models (observed: every command `cd D:\CrosSen` = main checkout), so this BLOCKS:
 *   - shell commands whose effective cwd (session cwd, or cd / Set-Location / pushd /
 *     git -C, WSL /mnt/<x>/ paths) is outside the worktree — unless every segment is
 *     clearly read-only (git log/status/diff/show…, ls, cat, rg…), no redirection;
 *   - write/edit/other file-writing tools whose target path is outside the worktree.
 * Reads (read/grep/find/ls tools) are always allowed. Paths compare via realpath
 * (Windows 8.3 short names, case-insensitive).
 */
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cdTargets, insideDir } from "./launch.ts";
import { getState } from "./state.ts";
import type { GoalState } from "./types.ts";

let sessionCwd = process.cwd();
export function setSessionCwd(cwd?: string): void {
  if (cwd) sessionCwd = cwd;
}
export function getSessionCwd(): string {
  return sessionCwd;
}

const SHELL_TOOLS = /^(bash|powershell|pwsh|shell|cmd|exec|terminal)$/i;
const READ_TOOLS = /^(read|grep|find|ls|glob|search|view|lsp.*|web.*|fetch|agent|get_.*|list_.*|submit_goal_plan|goal_.*|ask.*)$/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file", "target", "destination", "dest", "to"];

const READONLY_SEG =
  /^\s*(cd|chdir|set-location|sl|pushd|popd|pwd|get-location|ls|dir|gci|get-childitem|cat|type|gc|get-content|head|tail|wc|rg|grep|findstr|select-string|echo|write-output|test-path|resolve-path|stat|file|which|where|get-command|git\s+(-C\s+("[^"]+"|'[^']+'|\S+)\s+)?(--no-pager\s+)?(log|status|diff|show|rev-parse|branch\s*(--list|-a|-r|-v|$)|ls-files|ls-tree|blame|grep|shortlog|describe|cat-file|merge-base|remote\s+-v|worktree\s+list|config\s+--get))\b/i;

/** Active goal's home folder (null = no guard). */
export function goalHome(state: GoalState): string | null {
  if (state.status !== "running" && state.status !== "planning" && state.status !== "paused") return null;
  return state.git?.workdir ?? state.workdir ?? null;
}

export function isReadOnlyCommand(command: string): boolean {
  if (/(^|[^0-9&|])>{1,2}|\b(Out-File|Set-Content|Add-Content|tee|Remove-Item|rm|del|mv|cp|Move-Item|Copy-Item|robocopy|xcopy)\b/i.test(command)) return false;
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => READONLY_SEG.test(s));
}

const allowedScratch = (p: string) => insideDir(p, os.tmpdir());

/** Map a path in the main checkout onto the worktree (same relative path). */
function mapToHome(p: string, state: GoalState, home: string): string {
  const repo = state.git?.repo;
  if (repo && insideDir(p, repo) && !insideDir(p, home)) {
    const rel = path.relative(path.resolve(repo), path.resolve(p));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return path.join(home, rel);
  }
  return home;
}

function rewriteCommand(command: string, cwd: string, state: GoalState, home: string): string {
  const re = /((?:^|[;&|(]\s*|&&\s*)(?:cd|Set-Location|sl|pushd|chdir)\s+(?:-LiteralPath\s+|-Path\s+|\/d\s+)?)("[^"]+"|'[^']+'|[^\s;&|)]+)|(\bgit\s+-C\s+)("[^"]+"|'[^']+'|\S+)/gi;
  let changed = false;
  const out = command.replace(re, (m, pre1, p1, pre2, p2) => {
    const pre = pre1 ?? pre2;
    const tok = p1 ?? p2;
    const t = cdTargets(`cd ${tok}`, cwd)[0];
    if (!t || insideDir(t, home)) return m;
    changed = true;
    return `${pre}"${mapToHome(t, state, home)}"`;
  });
  return changed ? out : `cd "${home}" && ${command}`;
}

/** null = allow; string = block reason. */
export function guardDecision(state: GoalState, toolName: string, input: any, cwd: string): string | null {
  const home = goalHome(state);
  if (!home) return null;
  const tag = `pi-goal-orch: BLOCKED — this goal works only in its worktree ${home}${state.git?.branch ? ` (branch ${state.git.branch})` : ""}.`;
  if (SHELL_TOOLS.test(toolName) && typeof input?.command === "string") {
    const command: string = input.command;
    const targets = cdTargets(command, cwd);
    const startsInHome = targets.length > 0 && insideDir(targets[0], home) && /^\s*(cd|Set-Location|sl|pushd|chdir)\b/i.test(command);
    const effective = [...(startsInHome ? [] : [input.cwd ? path.resolve(cwd, input.cwd) : cwd]), ...targets];
    const outside = effective.filter((d) => !insideDir(d, home) && !allowedScratch(d));
    if (!outside.length || isReadOnlyCommand(command)) return null;
    return `${tag} The command would run in ${outside[0]} (outside the worktree — main checkout / user's folder). Only read-only commands (git log/status/diff, ls, cat, rg) may look outside. Re-run it as:\n${rewriteCommand(command, cwd, state, home)}`;
  }
  if (READ_TOOLS.test(toolName)) return null;
  for (const k of PATH_KEYS) {
    const v = input?.[k];
    if (typeof v !== "string" || !v) continue;
    const p = path.resolve(cwd, v.replace(/^\/mnt\/([a-z])\//i, (_m, d: string) => `${d.toUpperCase()}:/`));
    if (insideDir(p, home) || allowedScratch(p)) continue;
    return `${tag} ${toolName} targets ${p}, outside the worktree. Use the same file inside the worktree instead: ${mapToHome(p, state, home)}`;
  }
  return null;
}

export function registerWorktreeGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      const reason = guardDecision(getState(), String(event?.toolName ?? ""), event?.input, ctx?.cwd ?? sessionCwd);
      if (!reason) return;
      try {
        ctx?.ui?.notify?.(reason.split("\n")[0], "warning");
      } catch {
        /* no UI */
      }
      return { block: true, reason };
    } catch {
      return; // guard bug must never break tools
    }
  });
}

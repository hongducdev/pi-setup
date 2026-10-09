/**
 * Optional Orca (github.com/stablyai/orca) integration through its CLI.
 * Verified against Orca 1.4.209 CLI + source: `orca worktree create --json`
 * returns { result: { worktree: { id: "<repoId>::<path>", path, branch } } };
 * worktrees made by plain `git worktree add` are hidden in Orca's UI by
 * default (externalWorktreeVisibility), so goals use Orca when it is running.
 * Every function degrades to null/false when Orca is missing or not running.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normPath } from "./registry.ts";

let cachedExe: string | null | undefined;

export function orcaExe(): string | null {
  if (cachedExe !== undefined) return cachedExe;
  if (process.env.GOAL_ORCH_ORCA === "off") return (cachedExe = null);
  const candidates: string[] = [];
  if (process.env.ORCA_CLI_COMMAND) candidates.push(process.env.ORCA_CLI_COMMAND);
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "orca", "resources", "bin", "orca.exe"));
    candidates.push("orca");
  } else if (process.platform === "darwin") {
    candidates.push("orca");
  } else {
    candidates.push("orca-ide"); // bare `orca` on Linux is the GNOME screen reader
  }
  for (const c of candidates) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    if (r.status === 0) return (cachedExe = c);
  }
  return (cachedExe = null);
}

export function _resetOrcaCache() {
  cachedExe = undefined;
}

function run(args: string[], timeout = 60_000): { ok: boolean; result?: any; error?: string } {
  const exe = orcaExe();
  if (!exe) return { ok: false, error: "orca CLI not found" };
  const r = spawnSync(exe, [...args, "--json"], { encoding: "utf8", timeout, windowsHide: true });
  const out = (r.stdout || "").trim();
  try {
    const j = JSON.parse(out.slice(out.indexOf("{")));
    if (j.ok) return { ok: true, result: j.result };
    return { ok: false, error: j.error?.message || JSON.stringify(j.error ?? j) };
  } catch {
    return { ok: false, error: (r.stderr || out || String(r.error ?? "orca failed")).trim().slice(0, 300) };
  }
}

/** True when the Orca app/runtime answers. */
export function orcaRunning(): boolean {
  if (!orcaExe()) return false;
  return run(["repo", "list"], 15_000).ok;
}

export function findOrcaRepo(repoPath: string): string | null {
  const r = run(["repo", "list"], 15_000);
  if (!r.ok) return null;
  const want = normPath(repoPath);
  const hit = (r.result?.repos ?? []).find((x: { path?: string }) => x.path && normPath(x.path) === want);
  return hit?.id ?? null;
}

export function addOrcaRepo(repoPath: string): { id?: string; error?: string } {
  const r = run(["repo", "add", "--path", repoPath], 30_000);
  if (!r.ok) return { error: r.error };
  return { id: r.result?.repo?.id ?? findOrcaRepo(repoPath) ?? undefined };
}

// Note: Orca 1.4.209's CLI has no `repo rm` — removing a project is GUI-only.

export interface OrcaWorktree {
  id: string;
  path: string;
  branch?: string;
}

export function createOrcaWorktree(opts: {
  repoId: string;
  name: string;
  base: string;
  comment: string;
  setup: "inherit" | "run" | "skip";
}): { wt?: OrcaWorktree; error?: string } {
  const r = run(
    [
      "worktree", "create",
      "--repo", `id:${opts.repoId}`,
      "--name", opts.name,
      "--base-branch", opts.base,
      "--no-parent",
      "--setup", opts.setup,
      "--comment", opts.comment.slice(0, 200),
    ],
    180_000,
  );
  if (!r.ok) return { error: r.error };
  const w = r.result?.worktree;
  const wtPath = w?.path ?? w?.git?.path ?? (typeof w?.id === "string" ? w.id.split("::").slice(1).join("::") : undefined);
  if (!w?.id || !wtPath) return { error: "unexpected orca worktree create output" };
  return { wt: { id: w.id, path: wtPath, branch: w.branch ?? w.git?.branch } };
}

export function setOrcaWorktree(id: string, opts: { comment?: string; status?: string }): boolean {
  const args = ["worktree", "set", "--worktree", `id:${id}`];
  if (opts.comment) args.push("--comment", opts.comment.slice(0, 200));
  if (opts.status) args.push("--workspace-status", opts.status);
  return run(args, 20_000).ok;
}

/** Remove an Orca worktree (never --force). */
export function removeOrcaWorktree(id: string): { ok: boolean; error?: string } {
  const r = run(["worktree", "rm", "--worktree", `id:${id}`], 60_000);
  return { ok: r.ok, error: r.error };
}

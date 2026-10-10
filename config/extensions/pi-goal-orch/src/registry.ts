/**
 * Cross-session registry of active goals (~/.pi/agent/goal-orch-registry.json)
 * + per-repo merge lock (~/.pi/agent/goal-orch-locks/<hash>.lock).
 * Lets several Pi sessions run goals in parallel without sharing a branch /
 * worktree, serializes merges into the base branch and detects file overlap.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { orchHome } from "./config.ts";
import type { GoalGit, GoalMode } from "./types.ts";

export interface RegistryEntry {
  id: string;
  repo: string;
  branch: string;
  workdir: string;
  base: string;
  goal: string;
  /** pending = created by `/goal new`, waiting for the Pi launched in its worktree to claim it */
  status: "pending" | "active" | "merging" | "merged" | "abandoned" | "done";
  files: string[];
  pid: number;
  updatedAt: string;
  /** pending goals: what the launched session needs to start the goal */
  mode?: GoalMode;
  git?: GoalGit;
  /** how the session was launched (orca terminal / window / manual) */
  launcher?: string;
}

interface RegistryFile {
  goals: Record<string, RegistryEntry>;
}

export function normPath(p: string): string {
  const s = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** normPath of the real path (expands Windows 8.3 short names like HONGDU~1) — for folder comparisons only. */
export function realKey(p: string): string {
  try {
    return normPath(fs.realpathSync.native(p));
  } catch {
    return normPath(p);
  }
}

function registryPath(): string {
  return path.join(orchHome(), "goal-orch-registry.json");
}

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Short exclusive lock around read-modify-write of the registry file. */
function withRegistryLock<T>(fn: () => T): T {
  const lock = registryPath() + ".lock";
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; i < 100; i++) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        fs.rmSync(lock, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true });
      } catch {
        /* ignore */
      }
      sleepMs(50);
    }
  }
  return fn(); // give up locking rather than block forever
}

function read(): RegistryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    if (raw && typeof raw.goals === "object") return raw as RegistryFile;
  } catch {
    /* empty */
  }
  return { goals: {} };
}

function write(r: RegistryFile) {
  const tmp = registryPath() + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, registryPath());
}

export function listGoals(): RegistryEntry[] {
  return Object.values(read().goals);
}

export function upsertGoal(e: Omit<RegistryEntry, "updatedAt" | "pid"> & { pid?: number }): void {
  withRegistryLock(() => {
    const r = read();
    r.goals[e.id] = { ...r.goals[e.id], ...e, pid: e.pid ?? process.pid, updatedAt: new Date().toISOString() } as RegistryEntry;
    // drop finished entries older than 7 days
    const cutoff = Date.now() - 7 * 864e5;
    for (const [k, v] of Object.entries(r.goals)) {
      if ((v.status === "merged" || v.status === "abandoned" || v.status === "done") && Date.parse(v.updatedAt) < cutoff) delete r.goals[k];
    }
    write(r);
  });
}

export function patchGoal(id: string, patch: Partial<RegistryEntry>): void {
  withRegistryLock(() => {
    const r = read();
    if (!r.goals[id]) return;
    r.goals[id] = { ...r.goals[id], ...patch, updatedAt: new Date().toISOString() };
    write(r);
  });
}

/** Branch / worktree names already claimed by active goals of this repo. */
export function claimedNames(repo: string): { branches: Set<string>; workdirs: Set<string> } {
  const branches = new Set<string>();
  const workdirs = new Set<string>();
  for (const g of listGoals()) {
    if (normPath(g.repo) !== normPath(repo) || g.status === "merged" || g.status === "abandoned" || g.status === "done") continue;
    branches.add(g.branch);
    workdirs.add(normPath(g.workdir));
  }
  return { branches, workdirs };
}

/** Files touched by this goal that other active goals in the same repo also touch. */
export function overlaps(id: string, repo: string, files: string[]): Array<{ goal: RegistryEntry; files: string[] }> {
  const mine = new Set(files);
  const out: Array<{ goal: RegistryEntry; files: string[] }> = [];
  for (const g of listGoals()) {
    if (g.id === id || normPath(g.repo) !== normPath(repo)) continue;
    if (g.status !== "active" && g.status !== "merging") continue;
    const common = (g.files ?? []).filter((f) => mine.has(f));
    if (common.length) out.push({ goal: g, files: common });
  }
  return out;
}

// ---------------- merge lock ----------------

function lockFile(repo: string): string {
  const h = crypto.createHash("sha1").update(normPath(repo)).digest("hex").slice(0, 16);
  return path.join(orchHome(), "goal-orch-locks", `${h}.lock`);
}

/** Pending entries older than this are ignored (the launched Pi never claimed them). */
const PENDING_TTL_MS = 30 * 60_000;

/** An entry still owned by a live session (or a fresh pending launch). */
export function isLive(g: RegistryEntry): boolean {
  if (g.status === "pending") return Date.now() - Date.parse(g.updatedAt) < PENDING_TTL_MS;
  return (g.status === "active" || g.status === "merging") && pidAlive(g.pid);
}

/** Live goals whose working folder is `dir` (other than `exceptId`). */
export function goalsInFolder(dir: string, exceptId?: string): RegistryEntry[] {
  const want = realKey(dir);
  return listGoals().filter((g) => g.id !== exceptId && isLive(g) && realKey(g.workdir) === want);
}

/** Atomically take the pending goal registered for `dir` (set by `/goal new`). */
export function claimPending(dir: string): RegistryEntry | null {
  const want = realKey(dir);
  return withRegistryLock(() => {
    const r = read();
    const hit = Object.values(r.goals).find((g) => g.status === "pending" && isLive(g) && realKey(g.workdir) === want);
    if (!hit) return null;
    r.goals[hit.id] = { ...hit, status: "active", pid: process.pid, updatedAt: new Date().toISOString() };
    write(r);
    return r.goals[hit.id];
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockInfo {
  id: string;
  pid: number;
  at: string;
  branch: string;
}

/** Try to take the repo's merge lock. Returns null on success, or the current holder. */
export function acquireMergeLock(repo: string, info: Omit<LockInfo, "pid" | "at">, staleMinutes: number): LockInfo | null {
  const f = lockFile(repo);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const mine: LockInfo = { ...info, pid: process.pid, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(f, JSON.stringify(mine), { flag: "wx" });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: LockInfo | undefined;
      try {
        holder = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        /* unreadable → stale */
      }
      if (holder && holder.id === info.id) {
        fs.writeFileSync(f, JSON.stringify(mine)); // re-entrant
        return null;
      }
      const stale =
        !holder ||
        !pidAlive(holder.pid) ||
        Date.now() - Date.parse(holder.at) > staleMinutes * 60_000;
      if (!stale) return holder!;
      fs.rmSync(f, { force: true });
    }
  }
  return { id: "?", pid: 0, at: "", branch: "?" };
}

export function releaseMergeLock(repo: string, id: string): void {
  const f = lockFile(repo);
  try {
    const holder = JSON.parse(fs.readFileSync(f, "utf8")) as LockInfo;
    if (holder.id !== id) return;
  } catch {
    /* missing */
  }
  fs.rmSync(f, { force: true });
}

/**
 * Settings: ~/.pi/agent/goal-orch.json (all keys optional).
 * GOAL_ORCH_HOME overrides the directory (used by tests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitMode } from "./types.ts";

export interface GoalOrchConfig {
  /** default isolation when cwd is a git repo */
  git: GitMode;
  /** auto = merge after review PASS; ask = pause before merge (/goal merge) */
  merge: "auto" | "ask";
  /** keep the goal branch after a successful merge */
  keepBranch: boolean;
  /** worktree parent dir; default <repoParent>/.worktrees */
  worktreeRoot?: string;
  /** auto = use Orca when its CLI answers; off = never */
  orca: "auto" | "off";
  orcaSetup: "inherit" | "run" | "skip";
  orcaAutoAddRepo: boolean;
  reviewSkill: string;
  fixSkill: string;
  maxFixLoops: number;
  /** minutes after which a merge lock is considered stale */
  lockStaleMinutes: number;
}

export const DEFAULT_CONFIG: GoalOrchConfig = {
  git: "worktree",
  merge: "auto",
  keepBranch: false,
  orca: "auto",
  orcaSetup: "inherit",
  orcaAutoAddRepo: true,
  reviewSkill: "ck-code-review",
  fixSkill: "ck-fix",
  maxFixLoops: 2,
  lockStaleMinutes: 30,
};

export function orchHome(): string {
  return process.env.GOAL_ORCH_HOME || path.join(os.homedir(), ".pi", "agent");
}

export function loadConfig(): GoalOrchConfig {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(orchHome(), "goal-orch.json"), "utf8"));
    if (["worktree", "branch", "none"].includes(raw.git)) cfg.git = raw.git;
    if (raw.merge === "auto" || raw.merge === "ask") cfg.merge = raw.merge;
    if (typeof raw.keepBranch === "boolean") cfg.keepBranch = raw.keepBranch;
    if (typeof raw.worktreeRoot === "string" && raw.worktreeRoot) cfg.worktreeRoot = raw.worktreeRoot;
    if (raw.orca === "auto" || raw.orca === "off") cfg.orca = raw.orca;
    if (["inherit", "run", "skip"].includes(raw.orcaSetup)) cfg.orcaSetup = raw.orcaSetup;
    if (typeof raw.orcaAutoAddRepo === "boolean") cfg.orcaAutoAddRepo = raw.orcaAutoAddRepo;
    if (typeof raw.reviewSkill === "string" && raw.reviewSkill) cfg.reviewSkill = raw.reviewSkill;
    if (typeof raw.fixSkill === "string" && raw.fixSkill) cfg.fixSkill = raw.fixSkill;
    if (Number.isInteger(raw.maxFixLoops) && raw.maxFixLoops >= 0) cfg.maxFixLoops = raw.maxFixLoops;
    if (typeof raw.lockStaleMinutes === "number" && raw.lockStaleMinutes > 0) cfg.lockStaleMinutes = raw.lockStaleMinutes;
  } catch {
    /* missing / invalid file → defaults */
  }
  return cfg;
}

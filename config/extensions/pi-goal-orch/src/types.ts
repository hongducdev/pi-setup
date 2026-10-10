/** Shared types for pi-goal-orch */

export type GoalMode = "AFK" | "HITL";

/** Who decided the mode. Absent in state written by older versions. */
export type GoalModeSource = "default" | "user";

/** Why the runner paused. Absent in state written by older versions. */
export type PauseReason =
  | "hitl"
  | "checkpoint"
  | "anti-signal"
  /** review FAIL after max fix loops, or no verdict reported */
  | "review"
  /** last test stage failed — merge blocked */
  | "test"
  /** merge: ask — waiting for /goal merge */
  | "merge-ask"
  /** merge refused / conflict / base not checked out */
  | "merge"
  /** another goal holds the merge lock; retried automatically */
  | "merge-wait";

/** Role of a stage in the git finish phase. Absent = ordinary stage. */
export type StageRole = "review" | "fix" | "test";

export type GitMode = "worktree" | "branch" | "none";

export interface GoalReport {
  verdict: "PASS" | "FAIL";
  blocking?: number;
  summary?: string;
  /** stage index that reported */
  index: number;
  /** HEAD of the goal branch when reported */
  sha?: string;
}

/** Git isolation info. Absent in state written by older versions = no git management. */
export interface GoalGit {
  mode: "worktree" | "branch";
  /** main working tree (top level) */
  repo: string;
  /** directory the agent must work in (worktree path, or repo in branch mode) */
  workdir: string;
  branch: string;
  base: string;
  /** base commit when the goal started / last synced */
  baseSha: string;
  /** Orca worktree id (<repoId>::<path>) when created through Orca */
  orcaId?: string;
  orcaRepoId?: string;
  /** registry key */
  id: string;
  fixLoops: number;
  lastReview?: GoalReport;
  lastTest?: GoalReport;
  merged?: boolean;
  mergeSha?: string;
  cleanedUp?: boolean;
  abandoned?: boolean;
  /** branch mode: branch the user was on before (to restore after merge) */
  previousBranch?: string;
}

export type GoalStatus =
  | "idle"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export interface GoalStage {
  /** Skill slash-command name (without leading slash), e.g. "ak-brainstorm" */
  skill: string;
  /** Optional per-stage instruction for the soft-prompt */
  instruction?: string;
  /**
   * Optional: pause after this stage even in AFK so the user can approve its
   * output (e.g. approve a plan before code changes). Absent = false.
   */
  checkpoint?: boolean;
  /** git finish-phase role (review / fix / test) */
  role?: StageRole;
  /** appended automatically by the extension (not by the planner) */
  auto?: boolean;
  status?: "pending" | "running" | "done" | "skipped" | "failed";
}

export interface GoalState {
  status: GoalStatus;
  goal: string;
  mode: GoalMode;
  /** "user" only when the user explicitly chose the mode (/goal --hitl, /goal hitl, /goal auto). */
  modeSource?: GoalModeSource;
  stages: GoalStage[];
  /** Index of the stage currently running / about to run */
  currentIndex: number;
  /** ISO timestamp of last mutation */
  updatedAt: string;
  /** Why the goal is paused (only meaningful when status === "paused") */
  pauseReason?: PauseReason;
  /** Last assistant text snippet used for anti-signal checks */
  lastAssistantText?: string;
  /** git isolation (absent = old state / --no-git) */
  git?: GoalGit;
  /** folder the goal works in (git: = git.workdir; no-git: the session cwd) */
  workdir?: string;
  /** stable id for this run: stage results go to <workdir>/.pi-goal/<runId>/stage-N.md */
  runId?: string;
  /** registry id for goals without git isolation */
  regId?: string;
  /** worktree goal deliberately run in a session whose cwd is NOT the worktree (`/goal --here`) */
  here?: boolean;
}

export const ENTRY_TYPE = "goal-orch-state" as const;

/** Max checkpoint stages accepted from the planner. */
export const MAX_CHECKPOINTS = 2;

export function emptyGoalState(): GoalState {
  return {
    status: "idle",
    goal: "",
    mode: "AFK",
    modeSource: "default",
    stages: [],
    currentIndex: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * True when a stage instruction explicitly asks for the user's approval
 * (e.g. "Chờ tôi duyệt plan", "wait for my approval"). Such stages are treated
 * as checkpoints when `checkpoint` is not set explicitly — this covers goals
 * planned before `checkpoint` existed.
 */
export function instructionRequestsApproval(instruction?: string): boolean {
  if (!instruction) return false;
  return /(chờ|đợi)\s+(tôi|mình|anh|bạn|user|người dùng)\s+(duyệt|phê duyệt|xác nhận|approve)|wait(ing)?\s+for\s+(my|the user'?s?|user)\s+(approval|sign-?off|confirmation)|(requires?|needs?)\s+(my|the user'?s?|user)\s+approval/i.test(
    instruction,
  );
}

const PAUSE_REASONS: PauseReason[] = ["hitl", "checkpoint", "anti-signal", "review", "test", "merge-ask", "merge", "merge-wait"];
const STATUSES: GoalStatus[] = ["idle", "planning", "running", "paused", "completed", "cancelled"];
const STAGE_STATUSES = ["pending", "running", "done", "skipped", "failed"] as const;

/**
 * Normalize a persisted state entry (possibly written by an older version
 * without modeSource / pauseReason / checkpoint) into a valid GoalState.
 * Never throws; unknown fields are dropped, missing fields get safe defaults.
 */
export function normalizeGoalState(raw: unknown): GoalState {
  const base = emptyGoalState();
  if (!raw || typeof raw !== "object") return base;
  const d = raw as Record<string, unknown>;
  const stages: GoalStage[] = Array.isArray(d.stages)
    ? (d.stages as unknown[])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => {
          const st: GoalStage = { skill: String(s.skill ?? "").replace(/^\//, "") };
          if (typeof s.instruction === "string") st.instruction = s.instruction;
          if (s.checkpoint === true) st.checkpoint = true;
          else if (s.checkpoint === undefined && instructionRequestsApproval(st.instruction)) {
            st.checkpoint = true;
          }
          if (s.role === "review" || s.role === "fix" || s.role === "test") st.role = s.role;
          if (s.auto === true) st.auto = true;
          if (STAGE_STATUSES.includes(s.status as (typeof STAGE_STATUSES)[number])) {
            st.status = s.status as GoalStage["status"];
          }
          return st;
        })
        .filter((s) => s.skill)
    : [];
  const status = STATUSES.includes(d.status as GoalStatus) ? (d.status as GoalStatus) : base.status;
  const idx = Number.isInteger(d.currentIndex) ? Math.max(0, d.currentIndex as number) : 0;
  const out: GoalState = {
    status,
    goal: typeof d.goal === "string" ? d.goal : "",
    mode: d.mode === "HITL" ? "HITL" : "AFK",
    stages,
    currentIndex: idx,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : base.updatedAt,
  };
  if (d.modeSource === "user" || d.modeSource === "default") out.modeSource = d.modeSource;
  if (PAUSE_REASONS.includes(d.pauseReason as PauseReason)) out.pauseReason = d.pauseReason as PauseReason;
  const g = d.git as Record<string, unknown> | undefined;
  if (g && typeof g === "object" && (g.mode === "worktree" || g.mode === "branch") && typeof g.branch === "string" && typeof g.repo === "string") {
    out.git = { ...(g as unknown as GoalGit), fixLoops: Number.isInteger(g.fixLoops) ? (g.fixLoops as number) : 0 };
  }
  if (typeof d.lastAssistantText === "string") out.lastAssistantText = d.lastAssistantText;
  for (const k of ["workdir", "runId", "regId"] as const) if (typeof d[k] === "string") out[k] = d[k] as string;
  if (d.here === true) out.here = true;
  return out;
}

/**
 * Pause reason, inferring it for paused states written by older versions:
 * old HITL pauses bumped currentIndex (current stage pending, previous done);
 * old anti-signal pauses left the current stage "running".
 */
export function effectivePauseReason(state: GoalState): PauseReason | undefined {
  if (state.status !== "paused") return undefined;
  if (state.pauseReason) return state.pauseReason;
  const cur = state.stages[state.currentIndex];
  if (cur?.status === "running") return "anti-signal";
  const prev = state.stages[state.currentIndex - 1];
  if (prev?.checkpoint) return "checkpoint";
  return "hitl";
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Absolute or package-relative path to SKILL.md when known */
  skillMdPath?: string;
}

export interface DiscoveredTool {
  name: string;
  description: string;
}

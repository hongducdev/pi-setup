/** Shared types for pi-goal-orch */

export type GoalMode = "AFK" | "HITL";

/** Who decided the mode. Absent in state written by older versions. */
export type GoalModeSource = "default" | "user";

/** Why the runner paused. Absent in state written by older versions. */
export type PauseReason = "hitl" | "checkpoint" | "anti-signal";

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
  if (d.pauseReason === "hitl" || d.pauseReason === "checkpoint" || d.pauseReason === "anti-signal") {
    out.pauseReason = d.pauseReason;
  }
  if (typeof d.lastAssistantText === "string") out.lastAssistantText = d.lastAssistantText;
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

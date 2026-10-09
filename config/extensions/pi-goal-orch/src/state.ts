/**
 * GoalState persistence via pi.appendEntry + restore from session branch.
 * Custom entry type: "goal-orch-state"
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ENTRY_TYPE,
  effectivePauseReason,
  emptyGoalState,
  normalizeGoalState,
  type GoalState,
} from "./types.ts";

let current: GoalState = emptyGoalState();

export function getState(): GoalState {
  return current;
}

export function setState(next: GoalState): void {
  current = { ...next, updatedAt: new Date().toISOString() };
}

/** Persist state outside model context; reconstruct from branch later. */
export function persistState(pi: ExtensionAPI, state?: GoalState): GoalState {
  const next = state ?? current;
  const stamped: GoalState = { ...next, updatedAt: new Date().toISOString() };
  current = stamped;
  try {
    pi.appendEntry(ENTRY_TYPE, stamped);
  } catch (err) {
    // appendEntry may be unavailable in some modes; keep in-memory copy
    console.warn("[pi-goal-orch] appendEntry failed:", err);
  }
  return stamped;
}

/**
 * Walk the active session branch and take the latest goal-orch-state entry.
 * Call from session_start / session_tree.
 */
export function restoreFromBranch(ctx: ExtensionContext): GoalState {
  let restored = emptyGoalState();
  try {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
        restored = normalizeGoalState(entry.data);
      }
      // Some Pi builds store customType at top level of custom entries differently;
      // also accept a plain customType match without type === "custom".
      if (
        (entry as { customType?: string }).customType === ENTRY_TYPE &&
        (entry as { data?: unknown }).data
      ) {
        restored = normalizeGoalState((entry as { data: unknown }).data);
      }
    }
  } catch (err) {
    console.warn("[pi-goal-orch] restoreFromBranch failed:", err);
  }
  current = restored;
  return current;
}

function modeLabel(state: GoalState): string {
  if (state.modeSource === "user") return `${state.mode} (chosen by user)`;
  if (state.mode === "HITL") return "HITL (legacy, planner-chosen — `/goal auto` to switch to AFK)";
  return `${state.mode} (default)`;
}

const PAUSE_TEXT: Record<string, string> = {
  hitl: "HITL — stage finished",
  checkpoint: "checkpoint — review the previous stage's output",
  "anti-signal": "the model asked a question / needs input",
};

export function formatStatus(state: GoalState = current): string {
  if (state.status === "idle" || !state.goal) {
    return "No active goal. Start with `/goal <description>` (AFK) or `/goal --hitl <description>`.";
  }
  const lines = [
    `Goal: ${state.goal}`,
    `Status: ${state.status}`,
    `Mode: ${modeLabel(state)}`,
    `Stage: ${state.currentIndex + 1}/${state.stages.length || "?"}`,
  ];
  const reason = effectivePauseReason(state);
  if (reason) {
    lines.push(`Paused because: ${PAUSE_TEXT[reason]} — \`/goal next\` to continue, \`/goal auto\` to continue in AFK`);
  }
  if (state.stages.length) {
    lines.push("Stages (⏸ = checkpoint: pauses for approval after it finishes):");
    state.stages.forEach((s, i) => {
      const mark =
        s.status === "done"
          ? "✓"
          : s.status === "running"
            ? "→"
            : s.status === "skipped"
              ? "↷"
              : s.status === "failed"
                ? "✗"
                : "·";
      const cp = s.checkpoint ? " ⏸" : "";
      const cur = i === state.currentIndex ? " (current)" : "";
      const instr = s.instruction ? ` — ${s.instruction}` : "";
      lines.push(`  ${mark} [${i + 1}] ${s.skill}${cp}${instr}${cur}`);
    });
  }
  if (state.updatedAt) lines.push(`Updated: ${state.updatedAt}`);
  return lines.join("\n");
}

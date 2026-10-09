/**
 * /goal command router
 *
 *   /goal <description>         — discover skills, plan via submit_goal_plan, run AFK (default)
 *   /goal --hitl <description>  — same, but pause after every stage (also: /goal hitl <description>)
 *   /goal | /goal status        — show status (⏸ marks checkpoint stages)
 *   /goal skills                — list discovered skills
 *   /goal next                  — continue after a pause (HITL / checkpoint / question)
 *   /goal auto                  — switch the current goal to AFK; if paused, continue now
 *   /goal hitl                  — switch the current goal to HITL (pause after every stage)
 *   /goal skip                  — skip current stage
 *   /goal retry                 — re-run current stage
 *   /goal cancel                — halt
 *   /goal help                  — show this help
 *
 * The mode is the user's decision; the planner's `mode` argument is ignored.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills, formatSkillsList } from "./discover.ts";
import { buildPlanKickoffMessage } from "./planner.ts";
import { cancelGoal, kickoffStage, retryCurrent, skipCurrent } from "./runner.ts";
import { formatStatus, getState, persistState, setState } from "./state.ts";
import { effectivePauseReason, emptyGoalState, type GoalMode, type GoalState } from "./types.ts";

const HELP = [
  "/goal <mô tả>            — lập kế hoạch + chạy AFK (tự chuyển stage)",
  "/goal --hitl <mô tả>     — chạy HITL (dừng sau mỗi stage)",
  "/goal status             — trạng thái (⏸ = stage checkpoint)",
  "/goal next               — tiếp tục sau khi dừng",
  "/goal auto               — chuyển goal hiện tại sang AFK (đang dừng thì chạy tiếp ngay)",
  "/goal hitl               — chuyển goal hiện tại sang HITL",
  "/goal skip | retry | cancel | skills | help",
].join("\n");

function isActive(state: GoalState): boolean {
  return state.status === "running" || state.status === "planning" || state.status === "paused";
}

/** Strip --hitl / --afk / --auto flags; return the requested mode (if any) and the remaining text. */
function parseModeFlags(raw: string): { mode?: GoalMode; text: string } {
  let mode: GoalMode | undefined;
  const text = raw
    .replace(/(^|\s)--(hitl|afk|auto)(?=\s|$)/gi, (_m, pre: string, flag: string) => {
      mode = flag.toLowerCase() === "hitl" ? "HITL" : "AFK";
      return pre;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { mode, text };
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
) {
  try {
    ctx.ui?.notify?.(message, level);
  } catch {
    /* non-TUI modes */
  }
}

export function registerGoalCommand(pi: ExtensionAPI): void {
  pi.registerCommand("goal", {
    description:
      "Orchestrate installed skills as stages toward a goal (<desc>|--hitl <desc>|status|next|auto|hitl|skip|retry|cancel|skills|help)",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const [head] = raw.split(/\s+/);
      const sub = (head ?? "").toLowerCase();
      const rest = raw.slice(head?.length ?? 0).trim();

      if (!raw || sub === "status") {
        notify(ctx, formatStatus(getState()), "info");
        return;
      }

      if (sub === "skills") {
        const skills = discoverSkills(pi);
        const body =
          skills.length === 0
            ? "No skills discovered (getCommands source=skill)."
            : `Discovered skills (${skills.length}):\n${formatSkillsList(skills)}`;
        notify(ctx, body, "info");
        return;
      }

      if (sub === "next") {
        const state = getState();
        if (state.status !== "paused" && state.status !== "running") {
          notify(ctx, "Nothing to advance. Start a goal first.", "warning");
          return;
        }
        if (state.currentIndex >= state.stages.length) {
          notify(ctx, "All stages done.", "info");
          return;
        }
        const next = { ...state, status: "running" as const, pauseReason: undefined };
        setState(next);
        persistState(pi, next);
        kickoffStage(pi, next);
        notify(
          ctx,
          `Resuming stage ${next.currentIndex + 1}: ${next.stages[next.currentIndex]?.skill}`,
          "info",
        );
        return;
      }

      if ((sub === "auto" || sub === "afk" || sub === "hitl") && !rest) {
        const mode: GoalMode = sub === "hitl" ? "HITL" : "AFK";
        const state = getState();
        if (!isActive(state)) {
          notify(
            ctx,
            `No active goal. Start one with \`/goal ${mode === "HITL" ? "--hitl " : ""}<description>\`.`,
            "warning",
          );
          return;
        }
        const reason = effectivePauseReason(state);
        const switched: GoalState = { ...state, mode, modeSource: "user" };
        // /goal auto on a stage-finished pause (HITL or checkpoint) continues right away.
        if (mode === "AFK" && state.status === "paused" && reason !== "anti-signal") {
          if (state.currentIndex >= state.stages.length) {
            setState(switched);
            persistState(pi, switched);
            notify(ctx, "Mode: AFK. All stages done.", "info");
            return;
          }
          const next: GoalState = { ...switched, status: "running", pauseReason: undefined };
          setState(next);
          persistState(pi, next);
          kickoffStage(pi, next);
          notify(
            ctx,
            `Mode: AFK. Continuing with stage ${next.currentIndex + 1}: ${next.stages[next.currentIndex]?.skill}`,
            "info",
          );
          return;
        }
        setState(switched);
        persistState(pi, switched);
        const tail =
          state.status === "paused"
            ? " The goal is waiting for your answer to the model's question — reply, or use `/goal next` / `/goal skip`."
            : state.status === "planning"
              ? " Applies when the plan is submitted."
              : mode === "AFK"
                ? " Stages will auto-advance (checkpoint stages still pause)."
                : " The goal will pause after the current stage.";
        notify(ctx, `Mode: ${mode}.${tail}`, "info");
        return;
      }

      if (sub === "help" && !rest) {
        notify(ctx, HELP, "info");
        return;
      }

      if (sub === "skip") {
        const state = getState();
        if (
          state.status === "idle" ||
          state.status === "cancelled" ||
          state.status === "completed"
        ) {
          notify(ctx, "No active stage to skip.", "warning");
          return;
        }
        skipCurrent(pi);
        notify(ctx, `Skipped. Now:\n${formatStatus(getState())}`, "info");
        return;
      }

      if (sub === "retry") {
        const state = getState();
        if (!state.stages.length || state.status === "idle") {
          notify(ctx, "No active stage to retry.", "warning");
          return;
        }
        retryCurrent(pi);
        const s = getState();
        notify(ctx, `Retrying stage ${s.currentIndex + 1}: ${s.stages[s.currentIndex]?.skill}`, "info");
        return;
      }

      if (sub === "cancel") {
        cancelGoal(pi);
        notify(ctx, "Goal cancelled.", "warning");
        return;
      }

      // --- start new goal: /goal [--hitl] <description>  (also /goal hitl|auto <description>) ---
      let requested = parseModeFlags(raw);
      if ((sub === "hitl" || sub === "auto" || sub === "afk") && rest) {
        const inner = parseModeFlags(rest);
        requested = { mode: inner.mode ?? (sub === "hitl" ? "HITL" : "AFK"), text: inner.text };
      }
      const goalText = requested.text;
      if (!goalText) {
        notify(ctx, `Missing goal description.\n${HELP}`, "warning");
        return;
      }
      const existing = getState();
      if (
        existing.status === "running" ||
        existing.status === "planning" ||
        existing.status === "paused"
      ) {
        notify(
          ctx,
          `A goal is already active (${existing.status}). Use \`/goal status\`, \`/goal next\`, \`/goal auto\`, or \`/goal cancel\`.\n${formatStatus(existing)}`,
          "warning",
        );
        return;
      }

      const skills = discoverSkills(pi);
      if (skills.length === 0) {
        notify(
          ctx,
          "No skills installed/discovered. Install skills first, then retry `/goal <description>`.",
          "error",
        );
        return;
      }

      const mode: GoalMode = requested.mode ?? "AFK";
      const planning: GoalState = {
        ...emptyGoalState(),
        status: "planning",
        goal: goalText,
        mode,
        modeSource: requested.mode ? "user" : "default",
      };
      setState(planning);
      persistState(pi, planning);

      pi.sendUserMessage(buildPlanKickoffMessage(pi, goalText, mode));
      notify(
        ctx,
        `Planning goal (${mode}) with ${skills.length} skill(s). Model should call submit_goal_plan…`,
        "info",
      );
    },
  });
}

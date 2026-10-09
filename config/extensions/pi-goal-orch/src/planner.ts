/**
 * Plan kickoff soft-prompt + submit_goal_plan tool registration.
 * Preferred path: model calls submit_goal_plan with ordered stages.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverSkills, formatSkillsList } from "./discover.ts";
import { getState, persistState, setState } from "./state.ts";
import {
  instructionRequestsApproval,
  MAX_CHECKPOINTS,
  type GoalMode,
  type GoalStage,
} from "./types.ts";
import { startRunner } from "./runner.ts";

const SubmitGoalPlanParams = Type.Object({
  stages: Type.Array(
    Type.Object({
      skill: Type.String({ description: "Installed skill name (slash command without /)" }),
      instruction: Type.Optional(
        Type.String({ description: "Optional stage-specific instruction" }),
      ),
      checkpoint: Type.Optional(
        Type.Boolean({
          description:
            "Set true ONLY when the user must approve this stage's output before the goal continues (e.g. approve a plan before any code changes). Use sparingly: at most 1-2 per plan; omit otherwise.",
        }),
      ),
    }),
    { minItems: 1, description: "Ordered stages to complete the goal" },
  ),
  mode: Type.Optional(
    Type.String({
      description:
        "Deprecated / ignored: the run mode is decided by the user (/goal --hitl, /goal hitl, /goal auto), not the planner. Omit it.",
    }),
  ),
});

/** Build the planning soft-prompt listing available skills + goal text. */
export function buildPlanKickoffMessage(
  pi: ExtensionAPI,
  goalText: string,
  mode: GoalMode = "AFK",
): string {
  const skills = discoverSkills(pi);
  const list = formatSkillsList(skills);

  return [
    "You are planning a multi-stage goal for the pi-goal-orch extension.",
    "",
    `## User goal`,
    goalText,
    "",
    `## Run mode (chosen by the user — do not change)`,
    mode === "HITL"
      ? "HITL: the goal pauses after every stage for the user."
      : "AFK: stages auto-advance; it pauses only after `checkpoint` stages or when a stage ends with a genuine question to the user.",
    "",
    `## Available skills`,
    list,
    "",
    "## Instructions",
    "1. Choose an ordered sequence of skills that best completes the goal.",
    "2. Prefer AgentKit-style skills when present (e.g. ak-brainstorm, ak-plan, ak-cook), but use any installed skill that fits — do not invent skill names.",
    "3. Call the tool `submit_goal_plan` exactly once with:",
    '   - `stages`: array of `{ skill, instruction?, checkpoint? }`',
    "   - Do NOT set `mode`: the user decides it (stages auto-advance unless the user asked for HITL). A `mode` you pass is ignored.",
    `   - \`checkpoint: true\` pauses the goal after that stage so the user can approve its output (a stage whose instruction asks to wait for the user's approval is treated as a checkpoint automatically). Use it ONLY where approval is genuinely needed (typically: approve the plan before code changes) — at most ${MAX_CHECKPOINTS} stages, usually 0 or 1.`,
    "4. Do not start executing stages yourself — submit_goal_plan will start the runner.",
    "5. Stages run back-to-back; do not ask the user to confirm between stages unless the stage is a checkpoint.",
  ].join("\n");
}

/** Register submit_goal_plan; on success persist plan and start the runner. */
export function registerPlannerTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_goal_plan",
    label: "Submit Goal Plan",
    description:
      "Submit an ordered multi-skill plan for the active /goal. Persists stages and starts the goal runner.",
    parameters: SubmitGoalPlanParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const state = getState();
      if (!state.goal && state.status === "idle") {
        return {
          content: [
            {
              type: "text",
              text: "No active goal. User must start with `/goal <description>` first.",
            },
          ],
          details: { ok: false, reason: "no_active_goal" },
        };
      }

      let checkpoints = 0;
      let droppedCheckpoints = 0;
      const stages: GoalStage[] = (params.stages ?? []).map(
        (s: { skill: string; instruction?: string; checkpoint?: boolean }) => {
          const stage: GoalStage = {
            skill: String(s.skill).replace(/^\//, ""),
            instruction: s.instruction,
            status: "pending" as const,
          };
          const wantsCheckpoint =
            s.checkpoint === true ||
            (s.checkpoint === undefined && instructionRequestsApproval(s.instruction));
          if (wantsCheckpoint) {
            if (checkpoints < MAX_CHECKPOINTS) {
              stage.checkpoint = true;
              checkpoints++;
            } else {
              droppedCheckpoints++;
            }
          }
          return stage;
        },
      );

      if (stages.length === 0) {
        return {
          content: [{ type: "text", text: "Error: stages array must be non-empty." }],
          details: { ok: false, reason: "empty_stages" },
        };
      }

      // The user decides the mode. HITL only if the user explicitly asked
      // (/goal --hitl <desc> or /goal hitl while planning); planner's `mode` is ignored.
      const mode: GoalMode =
        state.modeSource === "user" && state.mode === "HITL" ? "HITL" : "AFK";
      const notes: string[] = [];
      if (params.mode && String(params.mode).toUpperCase() !== mode) {
        notes.push(`Requested mode "${params.mode}" ignored — the user decides the mode (${mode}).`);
      }
      if (droppedCheckpoints) {
        notes.push(`Only ${MAX_CHECKPOINTS} checkpoint stages allowed; ${droppedCheckpoints} extra checkpoint flag(s) dropped.`);
      }

      const next = {
        ...state,
        status: "running" as const,
        mode,
        modeSource: state.modeSource ?? ("default" as const),
        pauseReason: undefined,
        stages,
        currentIndex: 0,
      };
      setState(next);
      persistState(pi, next);

      // Kick off first stage asynchronously so the tool result returns cleanly.
      queueMicrotask(() => {
        try {
          startRunner(pi);
        } catch (err) {
          console.warn("[pi-goal-orch] startRunner after plan failed:", err);
        }
      });

      const summary = stages
        .map(
          (s, i) =>
            `${i + 1}. ${s.skill}${s.checkpoint ? " ⏸ checkpoint" : ""}${s.instruction ? ` — ${s.instruction}` : ""}`,
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Plan accepted (${mode}). Starting runner.\n${summary}${notes.length ? `\n${notes.join("\n")}` : ""}`,
          },
        ],
        details: { ok: true, mode, stages },
      };
    },
  });
}

/**
 * Fallback: try to parse a JSON plan from free-form assistant text
 * if the model forgot to call the tool (best-effort, not preferred).
 */
export function tryParseStagesFromText(text: string): GoalStage[] | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  try {
    const parsed = JSON.parse(raw.trim());
    const arr = Array.isArray(parsed) ? parsed : parsed?.stages;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((s: { skill?: string; name?: string; instruction?: string }) => ({
      skill: String(s.skill ?? s.name ?? "").replace(/^\//, ""),
      instruction: s.instruction,
      status: "pending" as const,
    })).filter((s: GoalStage) => s.skill);
  } catch {
    return null;
  }
}

/**
 * pi-goal-orch — Pi extension entry
 *
 * Adds `/goal` to discover installed skills and soft-prompt them as stages.
 * Pi has no invokeSkill(); skills are activated via sendUserMessage + SKILL.md path.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "../src/commands.ts";
import { registerPlannerTool } from "../src/planner.ts";
import { registerRunnerEvents } from "../src/runner.ts";
import { restoreFromBranch } from "../src/state.ts";
import { registerReportTool } from "../src/finish.ts";
import { maybeStartPending, registerStrayCdGuard } from "../src/launch.ts";

export default function (pi: ExtensionAPI) {
  // Restore branch-local state when a session starts or the tree changes
  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
    // `/goal new` launched this Pi inside a fresh worktree → pick up its goal
    try {
      maybeStartPending(pi, ctx);
    } catch (err) {
      console.warn("[pi-goal-orch] pending goal start failed:", err);
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  registerPlannerTool(pi);
  registerReportTool(pi);
  registerRunnerEvents(pi);
  registerGoalCommand(pi);
  registerStrayCdGuard(pi);
}

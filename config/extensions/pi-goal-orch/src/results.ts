/**
 * Stage results on disk: <workdir>/.pi-goal/<runId>/stage-N.md
 * Kept out of git via the repo's info/exclude, so a crashed / restarted session
 * (or a later stage) never loses what an earlier stage produced.
 */
import fs from "node:fs";
import path from "node:path";
import { git, slugify, stamp } from "./git.ts";
import type { GoalState } from "./types.ts";

export const RESULTS_DIRNAME = ".pi-goal";
const PER_STAGE_CHARS = 1800;
const TOTAL_CHARS = 6000;

export function newRunId(goal: string): string {
  return `${slugify(goal)}-${stamp()}`;
}

export function resultsDir(state: GoalState): string | null {
  const base = state.git?.workdir ?? state.workdir;
  if (!base) return null;
  const id = state.runId ?? (state.git ? state.git.branch.replace(/^goal\//, "").replace(/[\\/]/g, "-") : slugify(state.goal || "goal"));
  return path.join(base, RESULTS_DIRNAME, id);
}

/** Add `/.pi-goal/` to the repo's info/exclude (works in worktrees: --git-path resolves the common dir). */
export function ensureExcluded(dir: string): void {
  try {
    const r = git(dir, ["rev-parse", "--git-path", "info/exclude"], 15_000);
    if (!r.ok || !r.out) return;
    const file = path.resolve(dir, r.out);
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (/^\/?\.pi-goal\/?\s*$/m.test(cur)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# pi-goal-orch stage results\n/${RESULTS_DIRNAME}/\n`);
  } catch {
    /* not a repo / read-only: results still written */
  }
}

export function stageFile(state: GoalState, index: number): string | null {
  const d = resultsDir(state);
  return d ? path.join(d, `stage-${index + 1}.md`) : null;
}

/** Persist what stage `index` produced (overwrites: the latest text of the stage wins). */
export function writeStageResult(state: GoalState, index: number, text: string): string | null {
  const stage = state.stages[index];
  const file = stageFile(state, index);
  if (!stage || !file || !text.trim()) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ensureExcluded(path.dirname(path.dirname(path.dirname(file))));
    const head = [
      `# Stage ${index + 1}/${state.stages.length}: ${stage.skill}`,
      "",
      `- Goal: ${state.goal}`,
      stage.instruction ? `- Instruction: ${stage.instruction}` : "",
      `- Saved: ${new Date().toISOString()}`,
      "",
      "## Result (last assistant output of the stage)",
      "",
    ].filter((l, i) => l || i !== 3).join("\n");
    fs.writeFileSync(file, `${head}\n${text.trim()}\n`, "utf8");
    return file;
  } catch {
    return null;
  }
}

/** Prompt block with earlier stages' results (tail of each, plus the file to read in full). */
export function previousResultsBlock(state: GoalState): string {
  const parts: string[] = [];
  let budget = TOTAL_CHARS;
  for (let i = state.currentIndex - 1; i >= 0 && budget > 200; i--) {
    const f = stageFile(state, i);
    if (!f || !fs.existsSync(f)) continue;
    let body = "";
    try {
      body = fs.readFileSync(f, "utf8").split("## Result (last assistant output of the stage)").pop()!.trim();
    } catch {
      continue;
    }
    const take = Math.min(PER_STAGE_CHARS, budget);
    const snip = body.length > take ? "…" + body.slice(-take) : body;
    budget -= snip.length;
    parts.unshift(`### Stage ${i + 1}: ${state.stages[i].skill} — full text: ${f}\n${snip}`);
  }
  if (!parts.length) return "";
  return ["", "## Results of previous stages (saved by pi-goal-orch; read the files for full detail)", ...parts].join("\n");
}

/**
 * Git finish phase: role tagging, review → fix loop, merge queue, cleanup,
 * overlap warnings and the `goal_report` tool (review / test verdicts).
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { discoverSkills } from "./discover.ts";
import * as G from "./git.ts";
import * as orca from "./orca.ts";
import { acquireMergeLock, overlaps, patchGoal, releaseMergeLock } from "./registry.ts";
import { formatStatus, getState, persistState, setState } from "./state.ts";
import type { GoalGit, GoalReport, GoalStage, GoalState, PauseReason } from "./types.ts";

let lastCtx: ExtensionContext | undefined;
let warnedOverlap = "";
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** ms between merge-lock retries (tests lower it) */
export let MERGE_RETRY_MS = 15_000;
export function _setMergeRetryMs(ms: number) {
  MERGE_RETRY_MS = ms;
}

export function rememberCtx(ctx?: ExtensionContext) {
  if (ctx) lastCtx = ctx;
}

function notify(msg: string, level: "info" | "warning" | "error" = "info") {
  try {
    lastCtx?.ui?.notify?.(msg, level);
  } catch {
    /* ignore */
  }
}

// ---------------- roles / plan shaping ----------------

const REVIEW_RE = /(code-?review|(^|-)review($|-))/i;
const TEST_RE = /(^|-)test(s|ing)?($|-)/i;
const FIX_RE = /(^|-)fix($|-)/i;

/** Tag review/test/fix roles and append a review stage at the end (git goals only). */
export function shapeStagesForGit(pi: ExtensionAPI, stages: GoalStage[]): GoalStage[] {
  const out = stages.map((s) => {
    if (s.role) return s;
    if (REVIEW_RE.test(s.skill)) return { ...s, role: "review" as const };
    if (TEST_RE.test(s.skill)) return { ...s, role: "test" as const };
    if (FIX_RE.test(s.skill)) return { ...s, role: "fix" as const };
    return s;
  });
  if (out[out.length - 1]?.role !== "review") out.push(reviewStage(pi, "Final code review of the whole goal branch before merge."));
  return out;
}

function pickSkill(pi: ExtensionAPI, preferred: string, re: RegExp): string {
  const names = discoverSkills(pi).map((s) => s.name);
  if (names.includes(preferred)) return preferred;
  return names.find((n) => re.test(n)) ?? preferred;
}

function reviewStage(pi: ExtensionAPI, instruction: string): GoalStage {
  return { skill: pickSkill(pi, loadConfig().reviewSkill, REVIEW_RE), role: "review", auto: true, status: "pending", instruction };
}

function fixStage(pi: ExtensionAPI, summary: string): GoalStage {
  return {
    skill: pickSkill(pi, loadConfig().fixSkill, FIX_RE),
    role: "fix",
    auto: true,
    status: "pending",
    instruction: `Fix the BLOCKING review findings, then commit: ${summary || "(see the previous review stage)"}`,
  };
}

function testStageFrom(state: GoalState): GoalStage | undefined {
  const t = [...state.stages].reverse().find((s) => s.role === "test");
  return t ? { skill: t.skill, role: "test", auto: true, status: "pending", instruction: "Re-run build/tests after syncing with the latest base." } : undefined;
}

// ---------------- prompt text ----------------

export function gitPromptBlock(state: GoalState, stage: GoalStage): string {
  const g = state.git;
  if (!g) return "";
  const q = `"${g.workdir}"`;
  const lines = [
    "",
    "## Git isolation (pi-goal-orch)",
    `Work ONLY in ${g.workdir} — branch \`${g.branch}\`, base \`${g.base}\`.`,
    `- Start every shell command with \`cd ${q} && …\`; read/edit/write files only via absolute paths under ${g.workdir}.`,
  ];
  if (g.mode === "worktree") lines.push(`- Do not touch the main checkout ${g.repo} (the user may have uncommitted work there).`);
  lines.push(
    `- Commit on \`${g.branch}\` whenever this stage changes files (\`git -C ${q} add -A && git -C ${q} commit -m "<type>: <what>"\`, conventional messages; follow AGENTS.md git rules).`,
    "- Never push, never switch branches, never merge/rebase/reset — pi-goal-orch reviews and merges at the end.",
  );
  if (stage.role === "review") {
    lines.push(
      "",
      "## Review stage",
      `1. Commit any leftover changes first. 2. Review the full goal diff: \`git -C ${q} diff ${g.base}...HEAD\` (and \`git -C ${q} log --oneline ${g.base}..HEAD\`).`,
      "3. Classify findings as BLOCKING (bugs, broken build, security, data loss, missing required behaviour) or non-blocking. Do not fix anything in this stage.",
      '4. Call the tool `goal_report` with kind="review", verdict "PASS" (no blocking findings) or "FAIL", blocking=<count>, summary=<short list of blocking findings>.',
      "   If the tool is unavailable, end your message with a line `VERDICT: PASS` or `VERDICT: FAIL`.",
    );
  } else if (stage.role === "test") {
    lines.push(
      "",
      "## Test stage",
      `Build and run the project's tests inside ${g.workdir}. Then call \`goal_report\` with kind="test", verdict "PASS" or "FAIL" and a short summary (or end with \`TESTS: PASS\` / \`TESTS: FAIL\`). A FAIL blocks the merge.`,
    );
  } else if (stage.role === "fix") {
    lines.push("", "Fix only the blocking findings, commit, and stop — the review runs again automatically.");
  }
  return lines.join("\n");
}

// ---------------- goal_report tool ----------------

export function registerReportTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "goal_report",
    label: "Goal Report",
    description:
      "Report the verdict of a pi-goal-orch review or test stage (kind: review|test, verdict: PASS|FAIL). Only call it in such a stage.",
    parameters: Type.Object({
      kind: Type.String({ description: "review | test" }),
      verdict: Type.String({ description: "PASS | FAIL" }),
      blocking: Type.Optional(Type.Number({ description: "number of blocking findings (review)" })),
      summary: Type.Optional(Type.String({ description: "short summary of blocking findings / failures" })),
    }),
    async execute(_id, params) {
      const state = getState();
      const kind = String(params.kind).toLowerCase();
      const verdict = String(params.verdict).toUpperCase() === "PASS" ? "PASS" : "FAIL";
      if (!state.git || (kind !== "review" && kind !== "test")) {
        return { content: [{ type: "text", text: "No git goal / unknown kind — nothing recorded." }], details: { ok: false } };
      }
      const rep: GoalReport = {
        verdict,
        blocking: typeof params.blocking === "number" ? params.blocking : undefined,
        summary: params.summary,
        index: state.currentIndex,
        sha: G.headSha(state.git.workdir),
      };
      const git: GoalGit = kind === "review" ? { ...state.git, lastReview: rep } : { ...state.git, lastTest: rep };
      const next = { ...state, git };
      setState(next);
      persistState(pi, next);
      return { content: [{ type: "text", text: `Recorded ${kind} ${verdict}. Finish your message; the goal continues automatically.` }], details: { ok: true } };
    },
  });
}

function parseVerdict(text: string, word: RegExp): "PASS" | "FAIL" | undefined {
  const m = text.match(word);
  return m ? (m[1].toUpperCase() as "PASS" | "FAIL") : undefined;
}

// ---------------- stage outcome ----------------

export type RoleOutcome = { state: GoalState; pause?: { reason: PauseReason; message: string } };

/** Called when a stage finished (before HITL/checkpoint/advance handling). */
export function handleRoleOutcome(pi: ExtensionAPI, state: GoalState, finalText: string): RoleOutcome {
  const g = state.git;
  const stage = state.stages[state.currentIndex];
  if (!g || !stage?.role) return { state };
  const idx = state.currentIndex;
  if (stage.role === "review") {
    let rep = g.lastReview?.index === idx ? g.lastReview : undefined;
    if (!rep) {
      const v = parseVerdict(finalText, /VERDICT:\s*(PASS|FAIL)/i);
      if (v) rep = { verdict: v, index: idx, sha: G.headSha(g.workdir), summary: finalText.slice(-400) };
    }
    if (!rep) {
      return { state, pause: { reason: "review", message: "Review stage ended without a verdict (goal_report / VERDICT line). Re-run with `/goal retry`, or `/goal merge` to review again." } };
    }
    const git = { ...g, lastReview: rep };
    if (rep.verdict === "PASS") return { state: { ...state, git } };
    const max = loadConfig().maxFixLoops;
    if (g.fixLoops >= max) {
      return {
        state: { ...state, git },
        pause: { reason: "review", message: `Review FAIL after ${g.fixLoops} fix loop(s): ${rep.summary ?? ""}\nFix it yourself (or tell the agent), then \`/goal merge\` to review again, or \`/goal abandon\`.` },
      };
    }
    const stages = [...state.stages];
    stages.splice(idx + 1, 0, fixStage(pi, rep.summary ?? ""), reviewStage(pi, `Re-review after fix loop ${g.fixLoops + 1}.`));
    return { state: { ...state, stages, git: { ...git, fixLoops: g.fixLoops + 1 } } };
  }
  if (stage.role === "test") {
    let rep = g.lastTest?.index === idx ? g.lastTest : undefined;
    if (!rep) {
      const v = parseVerdict(finalText, /TESTS?:\s*(PASS|FAIL)/i);
      if (v) rep = { verdict: v, index: idx, sha: G.headSha(g.workdir), summary: finalText.slice(-300) };
    }
    return { state: rep ? { ...state, git: { ...g, lastTest: rep } } : state };
  }
  return { state };
}

// ---------------- pauses ----------------

const NEXT_HINT: Partial<Record<PauseReason, string>> = {
  review: "`/goal merge` = review again, `/goal abandon` = stop and keep the branch",
  test: "fix the tests, then `/goal merge`",
  "merge-ask": "`/goal merge` to merge now, `/goal abandon` to keep the branch unmerged",
  merge: "fix the cause, then `/goal merge`; `/goal abandon` keeps the branch",
  "merge-wait": "retrying automatically",
};

export function pauseGit(pi: ExtensionAPI, state: GoalState, reason: PauseReason, message: string, opts: { bumpIndex: boolean }) {
  let next: GoalState = { ...state, status: "paused", pauseReason: reason };
  if (opts.bumpIndex) {
    next = {
      ...next,
      stages: next.stages.map((s, i) => (i === state.currentIndex ? { ...s, status: "done" as const } : s)),
      currentIndex: state.currentIndex + 1,
    };
  }
  setState(next);
  persistState(pi, next);
  if (next.git?.orcaId && reason !== "merge-wait") orca.setOrcaWorktree(next.git.orcaId, { comment: `paused: ${reason}` });
  notify(`[pi-goal-orch] ${message}\n→ ${NEXT_HINT[reason] ?? "`/goal next`"}\n${formatStatus(next)}`, "warning");
}

// ---------------- overlap ----------------

export function checkOverlap(state: GoalState): string | undefined {
  const g = state.git;
  if (!g) return;
  let files: string[] = [];
  try {
    files = G.changedFiles(g);
    patchGoal(g.id, { files });
  } catch {
    return;
  }
  const hits = overlaps(g.id, g.repo, files);
  if (!hits.length) return;
  const text = hits.map((h) => `\`${h.goal.branch}\` (${h.goal.goal.slice(0, 40)}): ${h.files.slice(0, 6).join(", ")}${h.files.length > 6 ? ", …" : ""}`).join("\n");
  if (text === warnedOverlap) return text;
  warnedOverlap = text;
  notify(`[pi-goal-orch] ⚠ Overlapping files with other active goals — expect merge conflicts:\n${text}`, "warning");
  return text;
}

// ---------------- merge flow ----------------

export interface FinishDeps {
  kickoff: (state: GoalState) => void;
  complete: (state: GoalState, note: string) => void;
}

/**
 * Review gate → test gate → (ask) → merge lock → sync base (re-review if moved) → merge --no-ff → cleanup.
 * `manual` = triggered by /goal merge (skips `merge: ask`).
 */
export function runFinish(pi: ExtensionAPI, input: GoalState, deps: FinishDeps, opts: { manual?: boolean } = {}): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  const cfg = loadConfig();
  let state = { ...input, currentIndex: Math.min(input.currentIndex, input.stages.length) };
  const g = state.git;
  if (!g || g.merged || g.abandoned) {
    deps.complete(state, "");
    return;
  }
  if (!G.branchExists(g.repo, g.branch)) {
    pauseGit(pi, state, "merge", `Branch \`${g.branch}\` no longer exists — nothing to merge.`, { bumpIndex: false });
    return;
  }

  const head = G.headSha(g.workdir);
  const appendAndRun = (extra: GoalStage[], why: string) => {
    const stages = [...state.stages, ...extra];
    const next: GoalState = { ...state, stages, currentIndex: state.stages.length, status: "running", pauseReason: undefined };
    notify(`[pi-goal-orch] ${why}`, "info");
    deps.kickoff(next);
  };

  if (G.dirtyFiles(g.workdir).length && g.mode === "worktree") {
    // uncommitted work in the goal worktree → let a review stage commit + review it
    appendAndRun([reviewStage(pi, "The worktree has uncommitted changes: commit them first, then review.")], "Goal worktree has uncommitted changes → review stage (commit + review).");
    return;
  }
  if (G.commitsAhead(g) === 0) {
    const notes = G.cleanup(g, cfg.keepBranch);
    patchGoal(g.id, { status: "merged" });
    deps.complete({ ...state, git: { ...g, merged: true, cleanedUp: true } }, `Nothing to merge (no commits on \`${g.branch}\`). ${notes.join(" ")}`);
    return;
  }
  if (!g.lastReview || g.lastReview.verdict !== "PASS" || g.lastReview.sha !== head) {
    if (g.lastReview?.verdict === "FAIL" && g.lastReview.sha === head && !opts.manual) {
      pauseGit(pi, state, "review", `Review FAIL: ${g.lastReview.summary ?? ""}`, { bumpIndex: false });
      return;
    }
    appendAndRun([reviewStage(pi, "Review the goal branch before merge.")], "No passing review for the current branch HEAD → running review stage.");
    return;
  }
  const hadTest = state.stages.some((s) => s.role === "test");
  if (hadTest && g.lastTest?.verdict === "FAIL") {
    pauseGit(pi, state, "test", `Last test stage FAILED — not merging. ${g.lastTest.summary ?? ""}`, { bumpIndex: false });
    return;
  }
  if (cfg.merge === "ask" && !opts.manual) {
    pauseGit(pi, state, "merge-ask", `Review PASS. merge: ask — ready to merge \`${g.branch}\` into \`${g.base}\`.`, { bumpIndex: false });
    return;
  }

  const holder = acquireMergeLock(g.repo, { id: g.id, branch: g.branch }, cfg.lockStaleMinutes);
  if (holder) {
    if (state.pauseReason !== "merge-wait") {
      pauseGit(pi, state, "merge-wait", `Merge queue: \`${holder.branch}\` is merging into this repo — waiting for the lock.`, { bumpIndex: false });
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      const cur = getState();
      if (cur.status === "paused" && cur.pauseReason === "merge-wait") runFinish(pi, cur, deps, { ...opts, manual: true });
    }, MERGE_RETRY_MS);
    return;
  }
  try {
    patchGoal(g.id, { status: "merging" });
    if (g.orcaId) orca.setOrcaWorktree(g.orcaId, { status: "in-review", comment: "merging" });
    checkOverlap(state);
    const sync = G.syncWithBase(g);
    if (sync.kind === "conflict") {
      patchGoal(g.id, { status: "active" });
      pauseGit(
        pi,
        state,
        "merge",
        `\`${g.base}\` moved and conflicts with this goal in: ${sync.files.join(", ")}. Merge was aborted, nothing changed.\nResolve: \`git -C "${g.workdir}" merge ${g.base}\`, fix + commit (or ask the agent), then \`/goal merge\`.`,
        { bumpIndex: false },
      );
      return;
    }
    if (sync.kind === "error") {
      patchGoal(g.id, { status: "active" });
      pauseGit(pi, state, "merge", `Could not sync with \`${g.base}\`: ${sync.message}`, { bumpIndex: false });
      return;
    }
    if (sync.kind === "synced") {
      patchGoal(g.id, { status: "active" });
      state = { ...state, git: { ...g, baseSha: sync.newBase, lastReview: undefined, lastTest: undefined } };
      const extra = [reviewStage(pi, `\`${g.base}\` moved; it was merged into the goal branch — review again (focus on the integration).`)];
      const t = testStageFrom(state);
      if (t) extra.unshift(t);
      appendAndRun(extra, `\`${g.base}\` moved → merged it into \`${g.branch}\`; re-running ${t ? "tests + " : ""}review before merging.`);
      return;
    }
    const res = G.mergeIntoBase(g, state.goal);
    if (res.kind !== "merged") {
      patchGoal(g.id, { status: "active" });
      pauseGit(pi, state, "merge", `Merge not done: ${res.message}${res.kind === "conflict" ? ` Files: ${res.files.join(", ")}` : ""}`, { bumpIndex: false });
      return;
    }
    const notes = G.cleanup(g, cfg.keepBranch);
    patchGoal(g.id, { status: "merged" });
    const git: GoalGit = { ...g, merged: true, mergeSha: res.sha, cleanedUp: !G.branchExists(g.repo, g.branch) || cfg.keepBranch };
    deps.complete({ ...state, git }, `Merged \`${g.branch}\` into \`${g.base}\` (--no-ff, ${res.sha.slice(0, 7)}; not pushed). ${notes.join(" ")}`);
  } finally {
    releaseMergeLock(g.repo, g.id);
  }
}

export function _resetFinishMemory() {
  warnedOverlap = "";
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}

/**
 * Stage runner: soft-prompt each skill via sendUserMessage, then advance on
 * agent_settled (agent_end only as a fallback for runtimes without it).
 *
 * Pausing rules (the user decides the mode; the planner cannot force HITL):
 *   - HITL mode            → pause after every stage.
 *   - AFK + checkpoint     → pause after a stage marked `checkpoint: true`.
 *   - AFK + anti-signal    → pause when the stage's FINAL assistant message
 *                            genuinely asks the user something (see below).
 *   - otherwise            → auto-advance.
 *
 * Critical: Pi has NO invokeSkill(). We inject the skill name (+ optional
 * SKILL.md path) into a user message so the model follows the skill.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "./discover.ts";
import { formatStatus, getState, persistState, setState } from "./state.ts";
import type { GoalStage, GoalState, PauseReason } from "./types.ts";
import { checkOverlap, gitPromptBlock, handleRoleOutcome, pauseGit, rememberCtx, runFinish } from "./finish.ts";
import { patchGoal } from "./registry.ts";
import { previousResultsBlock, stageFile, writeStageResult } from "./results.ts";

/**
 * Explicit requests for user input. Only checked against the TAIL of the
 * stage's final assistant message (code blocks / inline code stripped).
 * Approval-style phrases ("chờ bạn duyệt", "waiting for approval") are NOT
 * here on purpose: approval pauses are what `checkpoint` stages are for.
 */
const ANTI_SIGNAL_PATTERNS: RegExp[] = [
  /\b(need|needs|require|requires) (your )?clarification\b/i,
  /\b(could|can|would) you (please )?(clarify|confirm|choose|tell me|let me know)\b/i,
  /\bplease (clarify|choose|select|tell me|let me know)\b/i,
  /\bwaiting for (your|user) (input|answer|reply|response|decision|choice)\b/i,
  /\bI (cannot|can't|can not) proceed\b/i,
  /\bvui lòng (làm rõ|cho (tôi|mình) biết|chọn|trả lời)\b/i,
  /\b(cần|xin) bạn (làm rõ|cho biết|chọn|trả lời)\b/i,
];

/** Characters of the final message tail that are inspected. */
const TAIL_CHARS = 600;

/** Text of the most recent assistant message that contained text (this stage). */
let lastFinalText = "";
/** Rolling buffer kept for persisted `lastAssistantText` (diagnostics only). */
let lastAssistantBuffer = "";
/** Guard against double advance from agent_end + agent_settled. */
let lastAdvanceKey = "";
let advancing = false;
/** Once agent_settled has been observed, agent_end is ignored. */
let sawSettled = false;
let settledSeq = 0;

function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/**
 * True when the final assistant message genuinely asks the user something:
 * one of its last non-empty lines (outside code) ends with "?" / "？", or the
 * tail contains an explicit request for input. Question marks inside code,
 * URLs, or earlier in a long report do not count.
 */
export function hasAntiSignals(text: string): boolean {
  if (!text || !text.trim()) return false;
  const tail = stripCode(text).slice(-TAIL_CHARS);
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.replace(/[*_>#\s]+$/g, "").trim())
    .filter((l) => l.length > 0);
  if (lines.slice(-2).some((l) => /[?？]$/.test(l))) return true;
  return ANTI_SIGNAL_PATTERNS.some((re) => re.test(tail));
}

function skillPathFor(pi: ExtensionAPI, skillName: string): string | undefined {
  return discoverSkills(pi).find((s) => s.name === skillName)?.skillMdPath;
}

function remainingStages(state: GoalState): string {
  return (
    state.stages
      .slice(state.currentIndex + 1)
      .map((s, i) => `${state.currentIndex + 2 + i}. ${s.skill}${s.checkpoint ? " (checkpoint)" : ""}`)
      .join(", ") || "(none)"
  );
}

function markStage(state: GoalState, index: number, status: GoalStage["status"]): GoalState {
  const stages = state.stages.map((st, i) => (i === index ? { ...st, status } : st));
  return { ...state, stages };
}

function completeGoal(pi: ExtensionAPI, state: GoalState, note = ""): void {
  const next: GoalState = { ...state, status: "completed", pauseReason: undefined };
  setState(next);
  persistState(pi, next);
  if (!next.git && next.regId) patchGoal(next.regId, { status: "done" });
  try {
    pi.sendUserMessage(`[pi-goal-orch] Goal completed.${note ? ` ${note}` : ""}\n${formatStatus(next)}`, {
      deliverAs: "followUp",
    });
  } catch {
    /* ignore */
  }
}

/** All stages done: git goals go through review/merge; others complete. */
export function finishGoal(pi: ExtensionAPI, state: GoalState, opts: { manual?: boolean } = {}): void {
  if (state.git && !state.git.merged && !state.git.abandoned) {
    runFinish(pi, { ...state, currentIndex: state.stages.length }, {
      kickoff: (s) => {
        setState(s);
        persistState(pi, s);
        kickoffStage(pi, s);
      },
      complete: (s, note) => completeGoal(pi, s, note),
    }, opts);
    return;
  }
  legacyFinish(pi, state);
}

function legacyFinish(pi: ExtensionAPI, state: GoalState): void {
  const next: GoalState = { ...state, status: "completed", pauseReason: undefined };
  setState(next);
  persistState(pi, next);
  if (!next.git && next.regId) patchGoal(next.regId, { status: "done" });
  try {
    pi.sendUserMessage(`[pi-goal-orch] Goal completed.\n${formatStatus(next)}`, {
      deliverAs: "followUp",
    });
  } catch {
    /* ignore */
  }
}

function pauseForUser(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: GoalState,
  reason: PauseReason,
  message: string,
  opts: { bumpIndex: boolean },
): void {
  let next: GoalState = {
    ...state,
    status: "paused",
    pauseReason: reason,
    lastAssistantText: lastAssistantBuffer,
  };
  if (opts.bumpIndex) {
    next = markStage(next, state.currentIndex, "done");
    next = { ...next, currentIndex: state.currentIndex + 1 };
    if (next.currentIndex >= next.stages.length) {
      finishGoal(pi, { ...next, status: "running" });
      return;
    }
  }
  setState(next);
  persistState(pi, next);
  const msg = `${message} Run \`/goal next\` to continue (\`/goal auto\` = continue and stop pausing between stages).\n${formatStatus(next)}`;
  try {
    ctx.ui?.notify?.(msg, "warning");
  } catch {
    try {
      pi.sendUserMessage(`[pi-goal-orch] ${msg}`, { deliverAs: "followUp" });
    } catch {
      /* ignore */
    }
  }
}

/** Soft-prompt the model to use the current stage's skill. */
export function kickoffStage(pi: ExtensionAPI, state?: GoalState): void {
  const s = state ?? getState();
  if (s.status !== "running" && s.status !== "paused") return;
  const stage = s.stages[s.currentIndex];
  if (!stage) {
    finishGoal(pi, s);
    return;
  }

  const next = markStage(
    { ...s, status: "running", pauseReason: undefined },
    s.currentIndex,
    "running",
  );
  setState(next);
  persistState(pi, next);

  const path = skillPathFor(pi, stage.skill);
  const pathClause = path ? ` at ${path}` : "";
  const instr = stage.instruction ? `\nSpecific instruction: ${stage.instruction}` : "";
  const ending = stage.checkpoint
    ? "This is a CHECKPOINT stage: finish it, then summarize the result for the user's approval — the goal pauses after it."
    : next.mode === "HITL"
      ? "Complete this stage thoroughly. If you need clarification from the user, ask clearly and stop; otherwise finish the stage work."
      : "Complete this stage thoroughly; the next stage starts automatically. Do not ask for confirmation to continue — only ask a question (and stop) if you genuinely cannot proceed without the user's answer.";

  const message = [
    `Use the skill "${stage.skill}". Read and follow its SKILL.md${pathClause}.`,
    `Goal: ${s.goal}`,
    `Stage ${s.currentIndex + 1}/${s.stages.length}: ${stage.skill}`,
    `Remaining stages: ${remainingStages(s)}`,
    instr.trim(),
    "",
    ending,
    gitPromptBlock(s, stage),
    previousResultsBlock(s),
    stageFile(s, s.currentIndex) ? `\n(pi-goal-orch saves this stage's final message to ${stageFile(s, s.currentIndex)} — end the stage with a self-contained summary of what you found/did, file paths and decisions, so later stages can rely on it.)` : "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  lastAssistantBuffer = "";
  lastFinalText = "";
  lastAdvanceKey = "";
  if (s.git) checkOverlap(next);
  pi.sendUserMessage(message, { deliverAs: "followUp" });
}

/**
 * Advance to the next stage (AFK) or pause (HITL / checkpoint / anti-signal).
 */
export function maybeAdvance(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: "agent_settled" | "agent_end",
): void {
  if (advancing) return;
  rememberCtx(ctx);
  let state = getState();
  if (state.status === "paused" && state.pauseReason === "anti-signal" && lastFinalText) {
    // The user answered the model's question and the stage continued: evaluate it again.
    state = { ...state, status: "running", pauseReason: undefined };
  } else if (state.status !== "running") {
    return;
  }

  const finalText = lastFinalText || state.lastAssistantText || "";
  const key = `${state.currentIndex}:${state.updatedAt}:${source}`;

  // Deduplicate: if settled already advanced this stage, ignore end (and vice versa).
  if (lastAdvanceKey.startsWith(`${state.currentIndex}:${state.updatedAt}:`)) return;

  // Idle / pending guards when available
  try {
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
    const pending = ctx.hasPendingMessages;
    if (typeof pending === "function" ? pending() : pending) return;
  } catch {
    /* ignore */
  }

  // Persist the stage's output before any pause / advance (survives restarts, feeds later stages).
  writeStageResult(state, state.currentIndex, finalText.length > 400 ? finalText : (lastAssistantBuffer || finalText));

  // Git finish-phase roles (review verdict → fix loop / pause; test verdict).
  if (state.git && state.stages[state.currentIndex]?.role) {
    const outcome = handleRoleOutcome(pi, state, finalText);
    state = outcome.state;
    if (outcome.pause) {
      lastFinalText = "";
      pauseGit(pi, state, outcome.pause.reason, outcome.pause.message, { bumpIndex: true });
      return;
    }
  }

  const stage = state.stages[state.currentIndex];

  // Pause branches don't set lastAdvanceKey: the pause flips status, so a
  // duplicate end/settled event returns early anyway, and keying on updatedAt
  // (ms resolution) could swallow the next legitimate settle.
  if (hasAntiSignals(finalText)) {
    lastFinalText = "";
    pauseForUser(
      pi,
      ctx,
      state,
      "anti-signal",
      "The model is asking you something. Answer it — the goal resumes by itself when the stage finishes without another question. Or",
      { bumpIndex: false },
    );
    return;
  }

  if (state.mode === "HITL") {
    pauseForUser(pi, ctx, state, "hitl", "HITL mode — stage finished. Paused.", { bumpIndex: true });
    return;
  }

  if (stage?.checkpoint) {
    pauseForUser(
      pi,
      ctx,
      state,
      "checkpoint",
      `Checkpoint — stage ${state.currentIndex + 1} (${stage.skill}) finished; review/approve its output.`,
      { bumpIndex: true },
    );
    return;
  }

  // AFK auto-advance
  advancing = true;
  lastAdvanceKey = key;
  try {
    const doneState = markStage(state, state.currentIndex, "done");
    const nextIndex = state.currentIndex + 1;
    if (nextIndex >= state.stages.length) {
      finishGoal(pi, doneState);
      return;
    }
    const next: GoalState = {
      ...doneState,
      currentIndex: nextIndex,
      status: "running",
      pauseReason: undefined,
      lastAssistantText: "",
    };
    setState(next);
    persistState(pi, next);
    kickoffStage(pi, next);
  } finally {
    advancing = false;
  }
}

/** Start (or resume) running from currentIndex. */
export function startRunner(pi: ExtensionAPI): void {
  const state = getState();
  if (!state.stages.length) return;
  if (state.currentIndex >= state.stages.length) {
    finishGoal(pi, state);
    return;
  }
  const next: GoalState = { ...state, status: "running", pauseReason: undefined };
  setState(next);
  persistState(pi, next);
  kickoffStage(pi, next);
}

export function skipCurrent(pi: ExtensionAPI): void {
  const state = getState();
  if (state.status !== "running" && state.status !== "paused") return;
  const skipped = markStage(state, state.currentIndex, "skipped");
  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.stages.length) {
    finishGoal(pi, skipped);
    return;
  }
  const next: GoalState = { ...skipped, currentIndex: nextIndex, status: "running", pauseReason: undefined };
  setState(next);
  persistState(pi, next);
  kickoffStage(pi, next);
}

export function retryCurrent(pi: ExtensionAPI): void {
  const state = getState();
  if (!state.stages.length) return;
  const next = markStage(
    { ...state, status: "running", pauseReason: undefined },
    state.currentIndex,
    "pending",
  );
  setState(next);
  persistState(pi, next);
  kickoffStage(pi, next);
}

export function cancelGoal(pi: ExtensionAPI): void {
  const state = getState();
  const next: GoalState = {
    ...state,
    status: "cancelled",
    pauseReason: undefined,
    git: state.git && !state.git.merged ? { ...state.git, abandoned: true } : state.git,
  };
  if (next.git?.abandoned) patchGoal(next.git.id, { status: "abandoned" });
  if (!next.git && next.regId) patchGoal(next.regId, { status: "abandoned" });
  setState(next);
  persistState(pi, next);
}

/** Record an assistant message's text: final-message tracking + rolling buffer. */
export function noteAssistantText(text: string): void {
  if (!text || !text.trim()) return;
  lastFinalText = text;
  lastAssistantBuffer = (lastAssistantBuffer + "\n" + text).slice(-8000);
}

/** Test hook: reset module-level runner memory. */
export function _resetRunnerMemory(): void {
  lastFinalText = "";
  lastAssistantBuffer = "";
  lastAdvanceKey = "";
  advancing = false;
  sawSettled = false;
  settledSeq = 0;
}

export function registerRunnerEvents(pi: ExtensionAPI): void {
  pi.on("message_end", async (event) => {
    const msg = event?.message ?? event;
    if (msg?.role !== "assistant") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c: { type?: string; text?: string }) => c?.type === "text" && c.text)
        .map((c: { text: string }) => c.text)
        .join("\n");
    }
    noteAssistantText(text);
  });

  // Settled = Pi will not continue automatically (after retries/compaction/queued work).
  pi.on("agent_settled", async (_event, ctx) => {
    sawSettled = true;
    settledSeq++;
    maybeAdvance(pi, ctx, "agent_settled");
  });
  // Fallback for runtimes without agent_settled. agent_end can be followed by
  // retries / compaction / queued messages, so wait and defer to settled.
  pi.on("agent_end", async (_event, ctx) => {
    if (sawSettled) return;
    const seq = settledSeq;
    setTimeout(() => {
      if (sawSettled || settledSeq !== seq) return;
      try {
        maybeAdvance(pi, ctx, "agent_end");
      } catch (err) {
        console.warn("[pi-goal-orch] agent_end advance failed:", err);
      }
    }, 1500);
  });
}

/**
 * model-router — pick a model per task from the models available in Pi.
 *
 * Tiers: plan (read/plan/review/research) · code (edit/implement/fix) ·
 *        hard (deep debugging, architecture, large refactors) · quick (trivial edits).
 * Per tier: configured preference list first, then an automatic pick among
 * `modelRegistry.getAvailable()` (logged-in providers) using registry metadata
 * (reasoning, context window, cost, name hints). Skips models in cooldown after a
 * 429/402 (15 min) and models lacking a needed capability (images).
 *
 * Applies to:
 *   - main session skill invocations: `/skill:<name>`, `/<skill>`, pi-goal-orch stages
 *     ("Use the skill …"), the model reading …/<skill>/SKILL.md. Plain chat is untouched.
 *     Previous model restored when the agent settles (not if you picked one meanwhile).
 *   - @tintinweb `Agent` tool calls WITHOUT an explicit `model`: subagent_type mapping,
 *     else tools / task text (`description` + `prompt`) keywords. Explicit models untouched.
 *
 * Safety: the session model is only switched at turn boundaries (input while idle,
 * before_agent_start). A skill detected mid-turn (SKILL.md read inside a running turn)
 * is deferred to the next turn — switching provider mid tool-use breaks
 * tool_use/tool_result pairing on some backends.
 * `allow` (exact refs or provider/prefix* globs) restricts preferences AND auto picks.
 *
 * Config: ~/.pi/agent/model-router.json   Command: /router [status|on|off|reload]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Tier = "plan" | "code" | "hard" | "quick";
const TIERS: Tier[] = ["plan", "code", "hard", "quick"];

export interface RouterConfig {
  enabled: boolean;
  /** preference list per tier (provider/id), tried in order before the automatic pick */
  tiers: Record<Tier, string[]>;
  /** if non-empty: only these may be picked (provider/id, provider/prefix*, provider/*) */
  allow: string[];
  /** never auto-pick these (provider/id or provider/*) */
  exclude: string[];
  /** skill-name regexes per tier (hard/quick checked on the prompt text too) */
  rules: { plan: string[]; code: string[] };
  /** exact skill name → tier */
  skills: Record<string, Tier | "none">;
  /** subagent_type → tier | "auto" (classify by task) | "none"; "*" = fallback */
  subagents: Record<string, Tier | "auto" | "none">;
  /** keyword regex sources for task classification (Unicode-aware word start) */
  subagentRules: { read: string[]; write: string[]; hard: string[]; quick: string[] };
  cooldownMinutes: number;
  restore: boolean;
}

export const DEFAULTS: RouterConfig = {
  enabled: true,
  tiers: {
    plan: ["antigravity/gemini-3.8-flash"],
    code: ["antigravity/gemini-3.8-flash"],
    hard: [],
    quick: [],
  },
  allow: [],
  exclude: [],
  rules: {
    plan: ["review", "plan", "scout", "brainstorm", "(^|-)ask($|-)", "research", "audit", "explore", "analy", "spec", "design", "investigat"],
    code: ["cook", "fix", "implement", "code", "build", "refactor", "debug", "test", "migrat", "frontend", "backend"],
  },
  skills: {},
  subagents: { Plan: "plan", Explore: "plan", "general-purpose": "auto", "*": "auto" },
  subagentRules: {
    read: [
      "review", "audit", "investigat", "find", "search", "explor", "analy[sz]", "explain", "plan", "research",
      "read", "check", "summari[sz]", "list", "locate", "compare", "inspect",
      "xem", "tìm", "kiểm tra", "đọc", "phân tích", "lập plan", "so sánh", "tóm tắt",
    ],
    write: [
      "implement", "fix", "edit", "write", "refactor", "add", "create", "update", "change", "patch", "migrat", "rename", "delete",
      "sửa", "viết", "thêm", "tạo", "cập nhật", "đổi", "xóa", "xoá",
    ],
    hard: [
      "root cause", "race condition", "deadlock", "memory leak", "architect", "redesign", "large refactor", "whole (repo|codebase)",
      "entire (repo|codebase)", "performance", "concurren", "security audit", "complex", "tricky",
      "nguyên nhân gốc", "kiến trúc", "phức tạp", "toàn bộ (repo|dự án|codebase)", "khó",
    ],
    quick: ["typo", "trivial", "quick", "one-?liner", "small", "rename", "format", "nhanh", "đơn giản", "nhỏ", "lỗi chính tả"],
  },
  cooldownMinutes: 15,
  restore: true,
};

const CONFIG_PATH = path.join(process.env.MODEL_ROUTER_HOME || path.join(os.homedir(), ".pi", "agent"), "model-router.json");

export function loadConfig(): RouterConfig {
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* defaults */
  }
  const tiers = { ...DEFAULTS.tiers, ...(raw.tiers ?? {}) };
  // legacy { models: { plan, code } }
  for (const k of ["plan", "code"] as Tier[]) {
    const m = raw.models?.[k];
    if (typeof m === "string" && !raw.tiers?.[k]) tiers[k] = [m];
  }
  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    tiers,
    allow: Array.isArray(raw.allow) ? raw.allow : DEFAULTS.allow,
    exclude: raw.exclude ?? DEFAULTS.exclude,
    rules: { ...DEFAULTS.rules, ...(raw.rules ?? {}) },
    skills: { ...(raw.skills ?? {}) },
    subagents: { ...DEFAULTS.subagents, ...(raw.subagents ?? {}) },
    subagentRules: { ...DEFAULTS.subagentRules, ...(raw.subagentRules ?? {}) },
    cooldownMinutes: raw.cooldownMinutes ?? DEFAULTS.cooldownMinutes,
    restore: raw.restore ?? DEFAULTS.restore,
  };
}

function saveEnabled(enabled: boolean) {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* new */
  }
  raw.enabled = enabled;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
}

// ---------------- classification ----------------

function hits(text: string, words: string[]): string[] {
  // \b is ASCII-only → explicit "start of word" that also works for Vietnamese
  return words.filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])(${w})`, "iu").test(text));
}

/** hard/quick refinement from the task text; null = keep base tier */
function refine(text: string, cfg: RouterConfig): { tier: Tier; why: string } | null {
  const h = hits(text, cfg.subagentRules.hard);
  if (h.length || text.length > 6000) return { tier: "hard", why: h[0] ?? "long task" };
  const q = hits(text, cfg.subagentRules.quick);
  if (q.length && text.length < 300) return { tier: "quick", why: q[0] };
  return null;
}

export function classifySkill(name: string, cfg: RouterConfig, text = ""): { tier: Tier; why: string } | null {
  const n = name.toLowerCase().replace(/^\//, "").replace(/^skill:/, "");
  const exact = cfg.skills[n];
  if (exact === "none") return null;
  let base: Tier | null = exact ?? null;
  if (!base) {
    for (const k of ["plan", "code"] as const) if (cfg.rules[k].some((r) => new RegExp(r, "i").test(n))) { base = k; break; }
  }
  if (!base) return null;
  const args = text.replace(/^\S+/, "");
  const r = base === "code" || base === "plan" ? refine(args, cfg) : null;
  // quick only makes sense for code work
  if (r && !(r.tier === "quick" && base !== "code")) return { tier: r.tier, why: `${n}: ${r.why}` };
  return { tier: base, why: n };
}

export function classifySubagent(input: any, cfg: RouterConfig): { tier: Tier | null; why: string } {
  const type = String(input?.subagent_type ?? "");
  const mapped = cfg.subagents[type] ?? cfg.subagents["*"] ?? "auto";
  if (mapped === "none") return { tier: null, why: "none" };
  if (mapped !== "auto") return { tier: mapped, why: type };
  const text = `${input?.description ?? ""}\n${input?.prompt ?? ""}`;
  const tools = input?.tools;
  if (tools !== undefined) {
    const list = (Array.isArray(tools) ? tools : String(tools).split(/[\s,]+/)).map((t: unknown) => String(t).toLowerCase()).filter(Boolean);
    if (list.length && !list.some((t: string) => /edit|write|bash|powershell|^\*$|^all$/.test(t))) {
      return { tier: refine(text, cfg)?.tier === "hard" ? "hard" : "plan", why: "read-only tools" };
    }
  }
  const r = refine(text, cfg);
  const w = hits(text, cfg.subagentRules.write);
  if (r?.tier === "hard") return { tier: "hard", why: r.why };
  if (w.length) return r?.tier === "quick" ? { tier: "quick", why: r.why } : { tier: "code", why: w[0] };
  const rd = hits(text, cfg.subagentRules.read);
  if (rd.length) return { tier: "plan", why: rd[0] };
  return { tier: "code", why: "default" };
}

export function skillFromText(text: string, knownSkills: Set<string>): string | null {
  const t = text.trim();
  let m = t.match(/^\/skill:([\w.:-]+)/i);
  if (m) return m[1];
  m = t.match(/^Use the skill "([\w.:-]+)"/);
  if (m) return m[1];
  m = t.match(/^\/([\w.:-]+)/);
  if (m && knownSkills.has(m[1].toLowerCase())) return m[1];
  return null;
}

function skillFromPath(p: string): string | null {
  const m = String(p).replace(/\\/g, "/").match(/\/([^/]+)\/SKILL\.md$/i);
  return m ? m[1] : null;
}

// ---------------- model choice ----------------

const key = (m: any) => (m ? `${m.provider}/${m.id}` : "(none)");
const cost = (m: any) => (m?.cost ? (Number(m.cost.input) || 0) + 3 * (Number(m.cost.output) || 0) : NaN);
const STRONG = /(^|[-_.])(pro|opus|max|ultra|large|plus|k3|thinking)($|[-_.\d])/i;
const LIGHT = /(flash|lite|mini|nano|haiku|small|free|tiny|air)/i;
const EXPERIMENTAL = /(preview|exp|contributor|vision-exp)/i;

export interface Need {
  images?: boolean;
}

export function matchRef(k: string, pat: string): boolean {
  return pat.endsWith("*") ? k.startsWith(pat.slice(0, -1)) : k === pat;
}

export function allowed(m: any, cfg: RouterConfig): boolean {
  return !cfg.allow?.length || cfg.allow.some((p) => matchRef(key(m), p));
}

export function eligible(m: any, cfg: RouterConfig, cooldown: Map<string, number>, need: Need): string | null {
  if (!m || (m.type && m.type !== "chat")) return "not a chat model";
  const k = key(m);
  if (!allowed(m, cfg)) return "not in allow list";
  if (cfg.exclude.some((e) => matchRef(k, e))) return "excluded";
  const until = cooldown.get(k);
  if (until && until > Date.now()) return `cooldown ${Math.ceil((until - Date.now()) / 60000)}m (429/402)`;
  if (need.images && Array.isArray(m.input) && !m.input.includes("image")) return "no image input";
  return null;
}

/** automatic score per tier — higher is better */
export function autoScore(m: any, tier: Tier): number {
  const id = String(m.id);
  const c = cost(m);
  const ctxw = Math.log2(Math.max(1, Number(m.contextWindow) || 1));
  const strong = STRONG.test(id) ? 1 : 0;
  const light = LIGHT.test(id) ? 1 : 0;
  const exp = EXPERIMENTAL.test(id) ? 1 : 0;
  const reasoning = m.reasoning ? 1 : 0;
  switch (tier) {
    case "hard":
      return reasoning * 50 + strong * 30 - light * 25 + (Number.isFinite(c) ? Math.min(c, 100) / 2 : 0) + ctxw - exp * 10;
    case "quick":
      return light * 30 - strong * 20 - (Number.isFinite(c) ? Math.min(c, 100) : 5) - exp * 20 + (/free/i.test(id) ? 3 : 0);
    default:
      // plan / code: capable but light
      return reasoning * 20 + light * 15 - strong * 5 - (Number.isFinite(c) ? Math.min(c, 100) / 4 : 0) + ctxw - exp * 10;
  }
}

export interface Pick {
  model?: any;
  why: string;
}

export function pickModel(available: any[], tier: Tier, cfg: RouterConfig, cooldown: Map<string, number>, need: Need = {}): Pick {
  const skipped: string[] = [];
  for (const ref of cfg.tiers[tier] ?? []) {
    const m = available.find((x) => key(x) === ref);
    if (!m) {
      skipped.push(`${ref}: unavailable`);
      continue;
    }
    const bad = eligible(m, cfg, cooldown, need);
    if (bad) {
      skipped.push(`${ref}: ${bad}`);
      continue;
    }
    return { model: m, why: `preferred${skipped.length ? ` (skipped ${skipped.join("; ")})` : ""}` };
  }
  const ok = available.filter((m) => !eligible(m, cfg, cooldown, need));
  if (!ok.length) return { why: `no eligible model${skipped.length ? ` (${skipped.join("; ")})` : ""}` };
  const best = [...ok].sort((a, b) => autoScore(b, tier) - autoScore(a, tier) || key(a).localeCompare(key(b)))[0];
  return { model: best, why: `auto ${tier}${skipped.length ? ` (skipped ${skipped.join("; ")})` : ""}` };
}

// ---------------- extension ----------------

/** process-wide: the UI (parent) router instance; no-UI instances beside it are subagent children */
const G = globalThis as any;
let SEQ = (G.__modelRouterSeq ??= 0);

export default function (pi: ExtensionAPI) {
  const me = (G.__modelRouterSeq = ++SEQ);
  /** child session of a subagent: keep the model the subagent was started with */
  const isChild = (ctx: any) => ctx?.hasUI === false && G.__modelRouterParent && G.__modelRouterParent !== me;
  const claim = (ctx: any) => {
    if (ctx?.hasUI === true) G.__modelRouterParent = me;
  };
  pi.on("session_start", async (_e: any, ctx: any) => claim(ctx));
  let cfg = loadConfig();
  const cooldown: Map<string, number> = (G.__modelRouterCooldown ??= new Map());
  let saved: any;
  let routedTo: string | null = null;
  let routedTier: Tier | null = null;
  let routedWhy = "";
  let settingModel = false;
  let runSeq = 0;
  let lastNote = "";
  /** skill detected mid-turn → applied at the next before_agent_start */
  let pending: { tier: Tier; why: string; need: Need } | null = null;
  const idle = (ctx: any) => {
    try {
      return typeof ctx?.isIdle === "function" ? !!ctx.isIdle() : true;
    } catch {
      return true;
    }
  };

  function notify(ctx: ExtensionContext | undefined, msg: string, level: "info" | "warning" = "info") {
    try {
      ctx?.ui?.notify?.(`[router] ${msg}`, level);
    } catch {
      /* non-TUI */
    }
  }
  const short = (m: any) => (m ? String(m.id) : "?");

  function available(ctx: ExtensionContext): any[] {
    try {
      const reg = (ctx as any).modelRegistry;
      const list = reg?.getAvailable?.() ?? [];
      return reg?.hasConfiguredAuth ? list.filter((m: any) => reg.hasConfiguredAuth(m)) : list;
    } catch {
      return [];
    }
  }

  function knownSkills(): Set<string> {
    try {
      return new Set(pi.getCommands().filter((c: any) => c.source === "skill").map((c: any) => String(c.name).toLowerCase()));
    } catch {
      return new Set();
    }
  }

  async function route(ctx: ExtensionContext, tier: Tier, why: string, need: Need) {
    if (!cfg.enabled) return;
    const current = (ctx as any).model;
    const pick = pickModel(available(ctx), tier, cfg, cooldown, need);
    if (!pick.model) {
      const note = `${why} → ${tier}: ${pick.why}; staying on ${key(current)}`;
      if (note !== lastNote) notify(ctx, note, "warning");
      lastNote = note;
      return;
    }
    routedTier = tier;
    routedWhy = why;
    if (key(current) === key(pick.model)) return;
    settingModel = true;
    let ok = false;
    try {
      ok = await pi.setModel(pick.model);
    } catch {
      ok = false;
    } finally {
      settingModel = false;
    }
    if (!ok) {
      notify(ctx, `${why} → ${tier}: could not switch to ${key(pick.model)}; staying on ${key(current)}`, "warning");
      return;
    }
    if (saved === undefined) saved = current ?? null;
    routedTo = key(pick.model);
    notify(ctx, `${why} → ${tier}: ${short(pick.model)} (${pick.why})`);
  }

  pi.on("input", async (event: any, ctx) => {
    claim(ctx);
    if (!cfg.enabled || typeof event?.text !== "string" || isChild(ctx)) return { action: "continue" };
    const skill = skillFromText(event.text, knownSkills());
    const c = skill ? classifySkill(skill, cfg, event.text) : null;
    if (c) {
      const need = { images: Array.isArray(event.images) && event.images.length > 0 };
      if (idle(ctx)) await route(ctx, c.tier, c.why, need);
      else pending = { tier: c.tier, why: c.why, need }; // steer/followUp while streaming → next turn
    }
    return { action: "continue" };
  });

  pi.on("tool_call", async (event: any, ctx) => {
    if (!cfg.enabled) return;
    const name = String(event?.toolName ?? "");
    const input = event?.input;
    if (!input || typeof input !== "object") return;
    if (name === "read") {
      if (isChild(ctx)) return;
      const skill = skillFromPath(input.path ?? input.file_path ?? "");
      const c = skill ? classifySkill(skill, cfg) : null;
      // inside a running turn: never switch now (tool_use/tool_result pairing) → defer
      if (c) pending = { tier: c.tier, why: `${c.why} (deferred)`, need: {} };
      return;
    }
    if (name === "Agent" && !input.model && typeof input.subagent_type === "string") {
      const c = classifySubagent(input, cfg);
      if (!c.tier) return;
      const pick = pickModel(available(ctx), c.tier, cfg, cooldown);
      if (!pick.model) return;
      input.model = key(pick.model); // mutate in place (Pi API: tool_call may modify event.input)
      notify(ctx, `subagent ${input.subagent_type} → ${short(pick.model)} (${c.tier}: ${c.why})`);
    }
  });

  // 429 / 402 on the main session's model → cooldown
  pi.on("after_provider_response", async (event: any, ctx) => {
    const st = Number(event?.status);
    if (st !== 429 && st !== 402) return;
    const m = (ctx as any).model;
    if (!m) return;
    cooldown.set(key(m), Date.now() + cfg.cooldownMinutes * 60_000);
    notify(ctx, `${key(m)} returned ${st} → skipped for ${cfg.cooldownMinutes} min`, "warning");
  });

  pi.on("before_agent_start", async (_e: any, ctx: any) => {
    if (!pending || isChild(ctx)) return;
    const p = pending;
    pending = null;
    await route(ctx, p.tier, p.why, p.need);
  });

  pi.on("agent_start", async () => {
    runSeq++;
  });

  pi.on("model_select", async (event: any) => {
    if (!settingModel && routedTo && key(event?.model) !== routedTo) {
      saved = undefined; // user / pi-model-fallback picked a model → don't restore over it
      routedTo = null;
      routedTier = null;
    }
  });

  pi.on("agent_settled", async (_e, ctx) => {
    if (!cfg.restore || saved === undefined || !routedTo) return;
    const seq = runSeq;
    setTimeout(async () => {
      if (runSeq !== seq || saved === undefined || !routedTo) return;
      if (key((ctx as any).model) !== routedTo) return;
      const back = saved;
      saved = undefined;
      routedTo = null;
      routedTier = null;
      if (!back) return;
      settingModel = true;
      try {
        if (await pi.setModel(back)) notify(ctx, `restored ${key(back)}`);
      } catch {
        /* ignore */
      } finally {
        settingModel = false;
      }
    }, 400);
  });

  pi.registerCommand("router", {
    description: "Model router: status | on | off | reload",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on" || sub === "off") {
        saveEnabled(sub === "on");
        cfg = loadConfig();
      } else if (sub === "reload") cfg = loadConfig();
      const av = available(ctx);
      const lines = [`Model router: ${cfg.enabled ? "ON" : "OFF"}  (config: ${CONFIG_PATH})`, `Available (${av.length}): ${av.map(key).join(", ")}`];
      if (cfg.allow.length) lines.push(`Allow: ${cfg.allow.join(", ")} → ${av.filter((m) => allowed(m, cfg)).length} model(s)`);
      if (pending) lines.push(`Pending (next turn): ${pending.why} → ${pending.tier}`);
      for (const t of TIERS) {
        const p = pickModel(av, t, cfg, cooldown);
        lines.push(`${t.padEnd(5)} → ${p.model ? key(p.model) : "(none)"} — ${p.why}`);
      }
      const cds = [...cooldown].filter(([, u]) => u > Date.now()).map(([k, u]) => `${k} (${Math.ceil((u - Date.now()) / 60000)}m)`);
      if (cds.length) lines.push(`Cooldown: ${cds.join(", ")}`);
      lines.push(`Subagents: ${Object.entries(cfg.subagents).map(([t, k]) => `${t}→${k}`).join(", ")}`);
      lines.push(`Current: ${key((ctx as any).model)}${routedTier ? ` (routed ${routedWhy} → ${routedTier}; restores ${key(saved)} when the turn settles)` : ""}`);
      notify(ctx, lines.join("\n"));
    },
  });
}

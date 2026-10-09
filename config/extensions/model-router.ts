/**
 * model-router — route planning/review work and coding work to different models.
 *
 *   plan/review (ck-plan, ck-code-review, ck-scout, ck-ask, brainstorm, review…) → models.plan
 *   coding      (ck-cook, ck-fix, implement, debug, test…)                        → models.code
 *
 * Triggers (Pi 1.1.0 API, verified in dist/core/extensions/types.d.ts):
 *   - `input` event (interactive, rpc and extension messages, before skill expansion):
 *       `/skill:<name> …`, `Use the skill "<name>"` (pi-goal-orch stages), `/<name>` skill commands
 *   - `tool_call` read of …/<skill>/SKILL.md (model loads a skill on its own) → switch for the next request
 *   - `tool_call` of the @tintinweb `Agent` tool without an explicit `model`:
 *       fills `input.model` from `subagents` mapping (Plan/Explore → plan, general-purpose → code)
 * The previous model is restored when the agent settles (unless the user picked a
 * model by hand meanwhile). Unavailable target (unknown id / no auth / setModel false)
 * → stay on the current model and notify.
 *
 * Config: ~/.pi/agent/model-router.json   Command: /router [status|on|off|reload]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Kind = "plan" | "code";

interface RouterConfig {
  enabled: boolean;
  models: Record<Kind, string | null>;
  /** regex sources tested against the skill name; plan is tested first */
  rules: Record<Kind, string[]>;
  /** exact skill name → kind (wins over rules) */
  skills: Record<string, Kind | "none">;
  /** @tintinweb subagent_type → kind */
  subagents: Record<string, Kind | "none">;
  restore: boolean;
}

const DEFAULTS: RouterConfig = {
  enabled: true,
  models: { plan: "opencode-go/deepseek-v4.1-flash", code: "antigravity/gemini-3.8-flash" },
  rules: {
    plan: ["review", "plan", "scout", "brainstorm", "(^|-)ask($|-)", "research", "audit", "explore", "analy", "spec", "design", "investigat"],
    code: ["cook", "fix", "implement", "code", "build", "refactor", "debug", "test", "migrat", "frontend", "backend"],
  },
  skills: {},
  subagents: { Plan: "plan", Explore: "plan", "general-purpose": "code" },
  restore: true,
};

const CONFIG_PATH = path.join(process.env.MODEL_ROUTER_HOME || path.join(os.homedir(), ".pi", "agent"), "model-router.json");

function loadConfig(): RouterConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      models: { ...DEFAULTS.models, ...(raw.models ?? {}) },
      rules: { ...DEFAULTS.rules, ...(raw.rules ?? {}) },
      skills: { ...(raw.skills ?? {}) },
      subagents: { ...DEFAULTS.subagents, ...(raw.subagents ?? {}) },
      restore: raw.restore ?? DEFAULTS.restore,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveEnabled(enabled: boolean) {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* new file */
  }
  raw.enabled = enabled;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
}

export function classifySkill(name: string, cfg: RouterConfig): Kind | null {
  const n = name.toLowerCase().replace(/^\//, "").replace(/^skill:/, "");
  const exact = cfg.skills[n];
  if (exact) return exact === "none" ? null : exact;
  for (const kind of ["plan", "code"] as Kind[]) {
    if (cfg.rules[kind].some((r) => new RegExp(r, "i").test(n))) return kind;
  }
  return null;
}

/** Skill name referenced by a prompt, if any. */
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

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();
  /** model active before the router's first switch in this agent run */
  let saved: any;
  /** model the router last set (to recognise our own model_select events) */
  let routedTo: string | null = null;
  let routedKind: Kind | null = null;
  let routedSkill: string | null = null;
  let settingModel = false;
  let runSeq = 0;
  let lastNote = "";

  const key = (m: any) => (m ? `${m.provider}/${m.id}` : "(none)");

  function notify(ctx: ExtensionContext | undefined, msg: string, level: "info" | "warning" = "info") {
    try {
      ctx?.ui?.notify?.(`[router] ${msg}`, level);
    } catch {
      /* non-TUI */
    }
  }

  function knownSkills(): Set<string> {
    try {
      return new Set(pi.getCommands().filter((c: any) => c.source === "skill").map((c: any) => String(c.name).toLowerCase()));
    } catch {
      return new Set();
    }
  }

  function resolveModel(ctx: ExtensionContext, ref: string): { model?: any; why?: string } {
    const i = ref.indexOf("/");
    if (i < 1) return { why: `bad model ref "${ref}"` };
    const reg = (ctx as any).modelRegistry;
    const model = reg?.find?.(ref.slice(0, i), ref.slice(i + 1));
    if (!model) return { why: `${ref} not found in the model registry` };
    if (reg.hasConfiguredAuth && !reg.hasConfiguredAuth(model)) return { why: `${ref}: provider not logged in` };
    return { model };
  }

  async function route(ctx: ExtensionContext, kind: Kind, skill: string) {
    if (!cfg.enabled) return;
    const ref = cfg.models[kind];
    if (!ref) return;
    const current = (ctx as any).model;
    if (key(current) === ref) {
      routedKind = kind;
      routedSkill = skill;
      return;
    }
    const { model, why } = resolveModel(ctx, ref);
    if (!model) {
      const note = `${skill} → ${kind}: ${why}; staying on ${key(current)}`;
      if (note !== lastNote) notify(ctx, note, "warning");
      lastNote = note;
      return;
    }
    settingModel = true;
    let ok = false;
    try {
      ok = await pi.setModel(model);
    } catch {
      ok = false;
    } finally {
      settingModel = false;
    }
    if (!ok) {
      notify(ctx, `${skill} → ${kind}: could not switch to ${ref} (auth/quota?); staying on ${key(current)}`, "warning");
      return;
    }
    if (saved === undefined) saved = current ?? null;
    routedTo = ref;
    routedKind = kind;
    routedSkill = skill;
    notify(ctx, `${skill} → ${kind} model ${ref}`);
  }

  pi.on("input", async (event: any, ctx) => {
    if (!cfg.enabled || typeof event?.text !== "string") return { action: "continue" };
    const skill = skillFromText(event.text, knownSkills());
    const kind = skill ? classifySkill(skill, cfg) : null;
    if (skill && kind) await route(ctx, kind, skill);
    return { action: "continue" };
  });

  pi.on("tool_call", async (event: any, ctx) => {
    if (!cfg.enabled) return;
    const name = String(event?.toolName ?? "");
    const input = event?.input;
    if (!input || typeof input !== "object") return;
    if (name === "read") {
      const skill = skillFromPath(input.path ?? input.file_path ?? "");
      const kind = skill ? classifySkill(skill, cfg) : null;
      if (skill && kind) await route(ctx, kind, skill);
      return;
    }
    if (name === "Agent" && !input.model && typeof input.subagent_type === "string") {
      const kind = cfg.subagents[input.subagent_type];
      const ref = kind && kind !== "none" ? cfg.models[kind] : null;
      if (ref && resolveModel(ctx, ref).model) input.model = ref; // mutate in place (Pi API)
    }
  });

  pi.on("agent_start", async () => {
    runSeq++;
  });

  pi.on("model_select", async (event: any) => {
    // A model picked by the user (or pi-model-fallback) while routed: don't restore over it.
    if (!settingModel && routedTo && key(event?.model) !== routedTo) {
      saved = undefined;
      routedTo = null;
      routedKind = null;
      routedSkill = null;
    }
  });

  pi.on("agent_settled", async (_e, ctx) => {
    if (!cfg.restore || saved === undefined || !routedTo) return;
    const seq = runSeq;
    // Defer: another extension (e.g. pi-goal-orch) may start the next stage right now;
    // its input event re-routes, and a new run means "don't restore yet".
    setTimeout(async () => {
      if (runSeq !== seq || saved === undefined || !routedTo) return;
      if (key((ctx as any).model) !== routedTo) return;
      const back = saved;
      saved = undefined;
      routedTo = null;
      routedKind = null;
      routedSkill = null;
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
      const status = (k: Kind) => {
        const ref = cfg.models[k];
        if (!ref) return `${k}: (off)`;
        const r = resolveModel(ctx, ref);
        return `${k}: ${ref}${r.model ? "" : `  ⚠ ${r.why}`}`;
      };
      notify(
        ctx,
        [
          `Model router: ${cfg.enabled ? "ON" : "OFF"}  (config: ${CONFIG_PATH})`,
          status("plan"),
          status("code"),
          `Subagents: ${Object.entries(cfg.subagents).map(([t, k]) => `${t}→${k}`).join(", ")}`,
          `Current: ${key((ctx as any).model)}${routedKind ? ` (routed: ${routedSkill} → ${routedKind}; restores ${key(saved)} when the turn settles)` : ""}`,
        ].join("\n"),
      );
    },
  });
}

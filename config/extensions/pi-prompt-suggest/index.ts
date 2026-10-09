import { promises as fs } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { collectCapabilities, renderCapabilities, selectCapabilities } from "./app/capabilities.ts";
import { buildCapabilityQuery, renderSuggestionPrompt } from "./app/prompt-template.ts";
import { generateSuggestion, type SuggestionUsage } from "./app/suggest.ts";
import { buildTurnContext } from "./app/turn-context.ts";
import { DEFAULT_CONFIG, applyConfigUpdate, describeConfigPath, loadConfig, saveConfig, type PromptSuggestConfig } from "./config.ts";
import { DEFAULT_GHOST_ACCEPT_KEYS, formatGhostAcceptKeys } from "./editor/accept-keys.ts";
import { GhostSuggestionEditor } from "./editor/ghost-editor.ts";
import { getGhostSyncAction, type GhostInstallState } from "./editor/ghost-install.ts";

/** Demo-only copy, used by `/suggester demo` to verify rendering without a model call. */
const PLACEHOLDER_SUGGESTION = "Xem lại thay đổi vừa rồi và bổ sung test cho phần xử lý lỗi.";

export default function promptSuggest(pi: ExtensionAPI): void {
	pi.registerFlag("prompt-suggest", {
		description: "Enable next-prompt ghost suggestions (persisted by /suggester on)",
		type: "boolean",
		default: false,
	});

	let config: PromptSuggestConfig = { ...DEFAULT_CONFIG };
	let demoMode = false;
	let suggestion: string | undefined;
	let revision = 0;
	let installState: GhostInstallState | undefined;
	let editorInstance: GhostSuggestionEditor | undefined;

	// Generation bookkeeping. `epoch` invalidates results after a session swap; `inFlight` keeps
	// overlapping turns from stacking up model calls.
	let epoch = 0;
	let inFlight: AbortController | undefined;
	let lastSkipReason: string | undefined;
	let lastPromptChars = 0;
	const usage: SuggestionUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

	function isEnabled(): boolean {
		return config.enabled || pi.getFlag("prompt-suggest") === true;
	}

	function setSuggestion(text: string | undefined): void {
		suggestion = text;
		revision += 1;
	}

	function cancelInFlight(): void {
		inFlight?.abort();
		inFlight = undefined;
	}

	// ---------------------------------------------------------------- editor installation

	function syncGhostEditor(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const action = getGhostSyncAction({ state: installState, context: ctx, sessionFile, enabled: isEnabled() });

		if (action === "noop") return;
		if (action === "uninstall") {
			// Restore whatever extension owned the editor before us, not the built-in default.
			ctx.ui.setEditorComponent(installState?.previous);
			installState = undefined;
			editorInstance = undefined;
			return;
		}

		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new GhostSuggestionEditor(
				tui,
				theme,
				keybindings,
				() => suggestion,
				() => revision,
				DEFAULT_GHOST_ACCEPT_KEYS,
			);
			editorInstance = editor;
			return editor;
		});
		installState = { context: ctx, sessionFile, previous };
	}

	function statusText(): string {
		const parts = [`suggest: ${isEnabled() ? (config.auto ? "auto" : "manual") : "off"}`];
		if (isEnabled()) {
			parts.push(`${formatGhostAcceptKeys(DEFAULT_GHOST_ACCEPT_KEYS)} accepts`);
			if (lastPromptChars > 0) parts.push(`prompt ~${Math.round(lastPromptChars / 4)}tok`);
			if (usage.calls > 0) parts.push(`↑${usage.inputTokens} ↓${usage.outputTokens}`);
			if (lastSkipReason) parts.push(`last: ${lastSkipReason}`);
			const misses = editorInstance?.getAnchorMisses() ?? 0;
			if (misses > 0) parts.push(`ANCHOR MISSES ${misses}`);
		}
		return parts.join(" · ");
	}

	function syncUi(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		syncGhostEditor(ctx);
		ctx.ui.setStatus("prompt-suggest", isEnabled() ? statusText() : undefined);
	}

	// ---------------------------------------------------------------- generation

	/** Resolve a configured model override; "session-default" means use the session's model. */
	function resolveModel(ctx: ExtensionContext): Model<Api> | undefined {
		if (config.model === "session-default") return ctx.model;

		const wanted = config.model.trim().toLowerCase();
		const models = ctx.modelRegistry.getAll();
		const exact = models.find(
			(model) => `${model.provider}/${model.id}`.toLowerCase() === wanted || model.id.toLowerCase() === wanted,
		);
		if (exact) return exact;
		return models.find((model) => model.id.toLowerCase().includes(wanted));
	}

	async function generateForTurn(ctx: ExtensionContext): Promise<void> {
		if (inFlight) {
			lastSkipReason = "busy";
			return;
		}

		const model = resolveModel(ctx);
		if (!model) {
			lastSkipReason = "no-model";
			syncUi(ctx);
			return;
		}

		// A suggestion is for an empty box. If the user is mid-typing, leave them alone.
		if (config.skipWhenEditorNonEmpty && ctx.ui.getEditorText().trim().length > 0) {
			lastSkipReason = "editor-not-empty";
			syncUi(ctx);
			return;
		}

		const built = buildPrompt(ctx);
		if (!built) {
			lastSkipReason = "no-turn";
			syncUi(ctx);
			return;
		}

		const controller = new AbortController();
		inFlight = controller;
		const startedEpoch = epoch;
		lastSkipReason = undefined;
		syncUi(ctx);

		const result = await generateSuggestion({
			complete: ctx.modelRegistry,
			model,
			systemPrompt: built.systemPrompt,
			prompt: built.userPrompt,
			maxTokens: config.maxOutputTokens,
			noSuggestionToken: config.noSuggestionToken,
			maxSuggestionChars: config.maxSuggestionChars,
			signal: controller.signal,
		});

		if (inFlight === controller) inFlight = undefined;
		// A new session or a newer turn invalidates this result.
		if (startedEpoch !== epoch) return;

		if (result.usage) {
			usage.inputTokens += result.usage.inputTokens;
			usage.outputTokens += result.usage.outputTokens;
			usage.calls += result.usage.calls;
		}
		lastSkipReason = result.skipReason;

		if (result.text) {
			setSuggestion(result.text);
		}
		syncUi(ctx);
	}

	interface BuiltPrompt {
		systemPrompt: string;
		userPrompt: string;
		capabilityLines: number;
	}

	/**
	 * Assemble the suggestion prompt for the current branch without calling the model.
	 * Shared by generation and by `/suggester prompt`, so what the user can inspect is exactly what
	 * gets sent to the provider.
	 */
	function buildPrompt(ctx: ExtensionContext): BuiltPrompt | undefined {
		const turn = buildTurnContext(ctx.sessionManager.getBranch(), config.turn);
		if (!turn) return undefined;

		let capabilities = "";
		if (config.includeCapabilities) {
			try {
				const inventory = collectCapabilities(pi);
				const selection = selectCapabilities(inventory, buildCapabilityQuery(turn), config.capabilities);
				capabilities = renderCapabilities(selection, config.capabilities);
			} catch {
				// Capability discovery is best-effort; a suggestion without it is still useful.
				capabilities = "";
			}
		}

		const rendered = renderSuggestionPrompt({
			turn,
			capabilities,
			customInstruction: config.customInstruction,
			noSuggestionToken: config.noSuggestionToken,
			maxSuggestionChars: config.maxSuggestionChars,
		});

		lastPromptChars = rendered.systemPrompt.length + rendered.userPrompt.length;
		return {
			systemPrompt: rendered.systemPrompt,
			userPrompt: rendered.userPrompt,
			capabilityLines: capabilities ? capabilities.split("\n").length : 0,
		};
	}

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		epoch += 1;
		cancelInFlight();
		config = await loadConfig(ctx.cwd);
		syncUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cancelInFlight();
		installState = undefined;
		editorInstance = undefined;
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus("prompt-suggest", undefined);
		} catch {
			// The runtime may already be gone; status cleanup must never break shutdown.
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		// Drop the previous turn's suggestion and any generation still in flight for it.
		cancelInFlight();
		if (suggestion !== undefined) setSuggestion(undefined);
		syncGhostEditor(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!isEnabled()) return;

		if (demoMode) {
			setSuggestion(PLACEHOLDER_SUGGESTION);
			syncUi(ctx);
			return;
		}
		if (!config.auto) return;

		await generateForTurn(ctx);
	});

	// ---------------------------------------------------------------- commands

	async function persist(ctx: ExtensionContext): Promise<void> {
		try {
			await saveConfig(config, ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`prompt-suggest: could not save config: ${String(error)}`, "error");
		}
	}

	pi.registerCommand("suggester", {
		description: "prompt suggestions: status | on | off | auto on|off | demo | clear | prompt | config <key> <value>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0] ?? "status";

			switch (subcommand) {
				case "on":
					config = { ...config, enabled: true };
					await persist(ctx);
					syncUi(ctx);
					ctx.ui.notify("Prompt suggestions on — a ghost suggestion appears after each turn", "info");
					return;

				case "off":
					config = { ...config, enabled: false };
					demoMode = false;
					cancelInFlight();
					setSuggestion(undefined);
					await persist(ctx);
					syncUi(ctx);
					ctx.ui.notify("Prompt suggestions off", "info");
					return;

				case "auto": {
					const value = parts[1];
					if (value !== "on" && value !== "off") {
						ctx.ui.notify(`suggester auto is ${config.auto ? "on" : "off"}`, "info");
						return;
					}
					config = { ...config, auto: value === "on" };
					await persist(ctx);
					syncUi(ctx);
					ctx.ui.notify(`Automatic suggestions ${config.auto ? "on" : "off"}`, "info");
					return;
				}

				case "demo":
					config = { ...config, enabled: true };
					demoMode = true;
					await persist(ctx);
					syncUi(ctx);
					setSuggestion(PLACEHOLDER_SUGGESTION);
					// Installing the editor copies the previous editor's text into it, which may still
					// hold the command just submitted. A ghost only renders over an empty or matching prefix.
					ctx.ui.setEditorText("");
					ctx.ui.notify("Demo suggestion shown — the ghost text is in the input box", "info");
					return;

				case "prompt": {
					const built = buildPrompt(ctx);
					if (!built) {
						ctx.ui.notify("prompt-suggest: no completed turn on this branch yet", "warning");
						return;
					}
					const target = path.join(getAgentDir(), "prompt-suggest", "last-prompt.txt");
					try {
						await fs.mkdir(path.dirname(target), { recursive: true });
						await fs.writeFile(
							target,
							`/* system */\n${built.systemPrompt}\n\n/* user */\n${built.userPrompt}\n`,
							"utf8",
						);
						ctx.ui.notify(
							`prompt-suggest: ~${Math.round((built.systemPrompt.length + built.userPrompt.length) / 4)} tokens (${built.capabilityLines} capability lines). Note: this file contains your recent prompts and file paths. → ${target}`,
							"info",
						);
					} catch (error) {
						ctx.ui.notify(`prompt-suggest: could not write prompt: ${String(error)}`, "error");
					}
					return;
				}

				case "clear":
					setSuggestion(undefined);
					syncUi(ctx);
					return;

				case "config": {
					const [key, ...rest] = parts.slice(1);
					if (!key) {
						ctx.ui.notify(
							`prompt-suggest config (${describeConfigPath(ctx.cwd)}): enabled=${config.enabled} auto=${config.auto} model=${config.model} maxSuggestionChars=${config.maxSuggestionChars} maxOutputTokens=${config.maxOutputTokens} includeCapabilities=${config.includeCapabilities}`,
							"info",
						);
						return;
					}
					const { config: next, error } = applyConfigUpdate(config, key, rest.join(" "));
					if (error) {
						ctx.ui.notify(`prompt-suggest: ${error}`, "error");
						return;
					}
					config = next;
					await persist(ctx);
					syncUi(ctx);
					ctx.ui.notify(`prompt-suggest: ${key} updated`, "info");
					return;
				}

				case "status":
				default: {
					ctx.ui.notify(
						`prompt-suggest: ${isEnabled() ? "on" : "off"} · auto: ${config.auto} · model: ${config.model} · calls: ${usage.calls} · ↑${usage.inputTokens} ↓${usage.outputTokens} · prompt ~${Math.round(lastPromptChars / 4)} tokens${lastSkipReason ? ` · last: ${lastSkipReason}` : ""} · ${describeConfigPath(ctx.cwd)}`,
						"info",
					);
					return;
				}
			}
		},
	});
}

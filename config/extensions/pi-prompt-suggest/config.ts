import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CAPABILITY_LIMITS, type CapabilityLimits } from "./app/capabilities.ts";
import { DEFAULT_TURN_LIMITS, type TurnContextLimits } from "./app/turn-context.ts";

export interface PromptSuggestConfig {
	schemaVersion: number;
	/** Persisted opt-in. Set by `/suggester on`; the cli flag can also force it on. */
	enabled: boolean;
	/** Generate a suggestion automatically after each settled turn. */
	auto: boolean;
	/** "session-default" or a model id/pattern override for the suggester call. */
	model: string;
	/** Token ceiling for the suggester call. The answer is one short prompt. */
	maxOutputTokens: number;
	maxSuggestionChars: number;
	customInstruction: string;
	/** Token the model returns when no suggestion is warranted. */
	noSuggestionToken: string;
	/** Include installed skills/commands/tools in the prompt, ranked by relevance. */
	includeCapabilities: boolean;
	/** Skip generation when the editor is not empty. */
	skipWhenEditorNonEmpty: boolean;
	capabilities: CapabilityLimits;
	turn: TurnContextLimits;
}

export const DEFAULT_CONFIG: PromptSuggestConfig = {
	schemaVersion: 1,
	// Off until the user asks for it: this replaces their editor and costs tokens per turn.
	enabled: false,
	auto: true,
	model: "session-default",
	maxOutputTokens: 200,
	maxSuggestionChars: 200,
	customInstruction: "",
	noSuggestionToken: "[no suggestion]",
	includeCapabilities: true,
	skipWhenEditorNonEmpty: true,
	capabilities: DEFAULT_CAPABILITY_LIMITS,
	turn: DEFAULT_TURN_LIMITS,
};

export function configPath(cwd: string = process.cwd(), agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "prompt-suggest", "config.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Merge on-disk config over the defaults, field by field.
 *
 * A malformed or outdated file must never break the extension, so unknown keys are dropped and any
 * value of the wrong type falls back to its default instead of throwing.
 */
export function normalizeConfig(raw: unknown): PromptSuggestConfig {
	if (!isPlainObject(raw)) return { ...DEFAULT_CONFIG };

	const capabilities = isPlainObject(raw.capabilities) ? raw.capabilities : {};
	const turn = isPlainObject(raw.turn) ? raw.turn : {};

	return {
		schemaVersion: pickNumber(raw.schemaVersion, DEFAULT_CONFIG.schemaVersion, 1, 1000),
		enabled: pickBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
		auto: pickBoolean(raw.auto, DEFAULT_CONFIG.auto),
		model: pickString(raw.model, DEFAULT_CONFIG.model) || DEFAULT_CONFIG.model,
		maxOutputTokens: pickNumber(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 32, 4096),
		maxSuggestionChars: pickNumber(raw.maxSuggestionChars, DEFAULT_CONFIG.maxSuggestionChars, 20, 2000),
		customInstruction: pickString(raw.customInstruction, DEFAULT_CONFIG.customInstruction),
		noSuggestionToken: pickString(raw.noSuggestionToken, DEFAULT_CONFIG.noSuggestionToken) || DEFAULT_CONFIG.noSuggestionToken,
		includeCapabilities: pickBoolean(raw.includeCapabilities, DEFAULT_CONFIG.includeCapabilities),
		skipWhenEditorNonEmpty: pickBoolean(raw.skipWhenEditorNonEmpty, DEFAULT_CONFIG.skipWhenEditorNonEmpty),
		capabilities: {
			maxPerCategory: pickNumber(capabilities.maxPerCategory, DEFAULT_CAPABILITY_LIMITS.maxPerCategory, 0, 100),
			maxDescriptionChars: pickNumber(
				capabilities.maxDescriptionChars,
				DEFAULT_CAPABILITY_LIMITS.maxDescriptionChars,
				20,
				500,
			),
			maxUnmatchedNames: pickNumber(
				capabilities.maxUnmatchedNames,
				DEFAULT_CAPABILITY_LIMITS.maxUnmatchedNames,
				0,
				500,
			),
		},
		turn: {
			recentUserPrompts: pickNumber(turn.recentUserPrompts, DEFAULT_TURN_LIMITS.recentUserPrompts, 0, 50),
			recentUserPromptChars: pickNumber(turn.recentUserPromptChars, DEFAULT_TURN_LIMITS.recentUserPromptChars, 20, 4000),
			latestAssistantChars: pickNumber(turn.latestAssistantChars, DEFAULT_TURN_LIMITS.latestAssistantChars, 200, 200_000),
			maxToolSignals: pickNumber(turn.maxToolSignals, DEFAULT_TURN_LIMITS.maxToolSignals, 0, 50),
			maxToolSignalChars: pickNumber(turn.maxToolSignalChars, DEFAULT_TURN_LIMITS.maxToolSignalChars, 20, 2000),
			maxTouchedFiles: pickNumber(turn.maxTouchedFiles, DEFAULT_TURN_LIMITS.maxTouchedFiles, 0, 50),
		},
	};
}

export async function loadConfig(cwd?: string): Promise<PromptSuggestConfig> {
	try {
		const text = await fs.readFile(configPath(cwd), "utf8");
		return normalizeConfig(JSON.parse(text));
	} catch {
		// Missing file is the normal first run; unreadable JSON falls back to defaults.
		return { ...DEFAULT_CONFIG };
	}
}

/** Write via a temp file + rename so an interrupted save cannot truncate the config. */
export async function saveConfig(config: PromptSuggestConfig, cwd?: string): Promise<void> {
	const target = configPath(cwd);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	await fs.rename(temp, target);
}

/** Apply `key=value` style updates from the `/suggester config` command. */
export function applyConfigUpdate(
	config: PromptSuggestConfig,
	key: string,
	value: string,
): { config: PromptSuggestConfig; error?: string } {
	const numeric = (min: number, max: number, fallback: number) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return undefined;
		return Math.min(max, Math.max(min, Math.floor(parsed)));
	};

	switch (key) {
		case "enabled":
			return { config: { ...config, enabled: value === "true" || value === "on" } };
		case "auto":
			return { config: { ...config, auto: value === "true" || value === "on" } };
		case "model":
			return value.trim()
				? { config: { ...config, model: value.trim() } }
				: { config, error: "model must not be empty" };
		case "maxSuggestionChars": {
			const parsed = numeric(20, 2000, config.maxSuggestionChars);
			return parsed === undefined
				? { config, error: "maxSuggestionChars must be a number" }
				: { config: { ...config, maxSuggestionChars: parsed } };
		}
		case "maxOutputTokens": {
			const parsed = numeric(32, 4096, config.maxOutputTokens);
			return parsed === undefined
				? { config, error: "maxOutputTokens must be a number" }
				: { config: { ...config, maxOutputTokens: parsed } };
		}
		case "includeCapabilities":
			return { config: { ...config, includeCapabilities: value === "true" || value === "on" } };
		case "skipWhenEditorNonEmpty":
			return { config: { ...config, skipWhenEditorNonEmpty: value === "true" || value === "on" } };
		case "maxPerCategory": {
			const parsed = numeric(0, 100, config.capabilities.maxPerCategory);
			return parsed === undefined
				? { config, error: "maxPerCategory must be a number" }
				: { config: { ...config, capabilities: { ...config.capabilities, maxPerCategory: parsed } } };
		}
		case "customInstruction":
			return { config: { ...config, customInstruction: value } };
		default:
			return { config, error: `unknown key: ${key}` };
	}
}

/** Home-relative display path for status output. */
export function describeConfigPath(cwd?: string): string {
	const target = configPath(cwd);
	const home = os.homedir();
	return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

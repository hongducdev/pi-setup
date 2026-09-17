/**
 * Publishes prompt-cache retention and response-speed values to pi-footer's event widgets.
 *
 * Cache TTL is derived from pi's own retention decision (see @earendil-works/pi-ai):
 * Anthropic attaches `cache_control.ttl = "1h"` only when PI_CACHE_RETENTION=long and the
 * model compat allows long retention, otherwise the default 5-minute entry is used;
 * OpenAI-family requests carry `prompt_cache_retention: "24h"` (or `ttl: "30m"` in explicit
 * prompt-cache mode). Anthropic documents that the lifetime is refreshed each time the cache
 * is used, so the countdown restarts from the start of every request that reads or writes the
 * cache. Providers with no documented TTL show the age of the last cache activity instead,
 * prefixed with `~`, so a countdown is never invented.
 *
 * Response speed uses provider usage.output when the stream reports it, falling back to the
 * chars/4 content estimate while streaming (same approach as pi-cc-extensions), and is
 * measured over the whole request span (message_start -> message_end).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const UPDATE_WIDGET_EVENT = "pi-footer:update-widget";
export const CACHE_TTL_WIDGET_ID = "cache_ttl";
export const TPS_WIDGET_ID = "tps";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ANTHROPIC_SHORT_TTL_MS = 5 * MINUTE_MS;
const ANTHROPIC_LONG_TTL_MS = 1 * HOUR_MS;
const OPENAI_LONG_TTL_MS = 24 * HOUR_MS;
const OPENAI_EXPLICIT_TTL_MS = 30 * MINUTE_MS;

const IDLE_TICK_MS = 15_000;
const STREAM_TICK_MS = 1_000;
const MIN_SPEED_SAMPLE_MS = 1_000;
const MIN_FINAL_SAMPLE_MS = 250;
const ESTIMATED_CHARS_PER_TOKEN = 4;

export interface ModelLike {
	id?: string;
	provider?: string;
	api?: string;
	compat?: {
		supportsLongCacheRetention?: boolean;
		supportsExplicitPromptCacheMode?: boolean;
	};
}

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
}

export type ProviderFamily = "anthropic" | "openai" | "unknown";

export interface CacheTtl {
	/** Known retention window in ms, or null when this provider exposes no documented TTL. */
	ttlMs: number | null;
	/** Short tier label shown next to the remaining time, empty when the TTL is unknown. */
	label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function providerFamily(model: ModelLike | undefined): ProviderFamily {
	const api = (model?.api ?? "").toLowerCase();
	const provider = (model?.provider ?? "").toLowerCase();
	if (
		api.startsWith("anthropic") ||
		api.startsWith("bedrock") ||
		provider.includes("anthropic") ||
		provider.includes("bedrock")
	) {
		return "anthropic";
	}
	// Only first-party OpenAI endpoints honour prompt_cache_retention; other providers speak an
	// OpenAI-compatible API but manage their own undocumented cache lifetime.
	const openaiProvider =
		provider === "openai" ||
		provider === "openai-codex" ||
		provider.startsWith("azure") ||
		provider.includes("openai") ||
		provider.includes("codex");
	return openaiProvider ? "openai" : "unknown";
}

/** Mirrors pi's resolveCacheRetention(): an explicit option wins, otherwise the env decides. */
export function retentionIsLong(env: Record<string, string | undefined> = process.env): boolean {
	return env.PI_CACHE_RETENTION === "long";
}

export function resolveCacheTtl(
	model: ModelLike | undefined,
	options: { long: boolean; sawOneHourWrite: boolean },
): CacheTtl {
	// pi-ai defaults compat.supportsLongCacheRetention to true and only opt-outs set false.
	const supportsLong = model?.compat?.supportsLongCacheRetention !== false;
	const family = providerFamily(model);

	if (family === "anthropic") {
		const oneHour = options.sawOneHourWrite || (options.long && supportsLong);
		return oneHour
			? { ttlMs: ANTHROPIC_LONG_TTL_MS, label: "1h" }
			: { ttlMs: ANTHROPIC_SHORT_TTL_MS, label: "5m" };
	}

	if (family === "openai") {
		if (!options.long || !supportsLong) return { ttlMs: null, label: "" };
		const explicit = model?.compat?.supportsExplicitPromptCacheMode === true;
		return explicit
			? { ttlMs: OPENAI_EXPLICIT_TTL_MS, label: "30m" }
			: { ttlMs: OPENAI_LONG_TTL_MS, label: "24h" };
	}

	return { ttlMs: null, label: "" };
}

export function formatSpan(ms: number): string {
	const safe = Math.max(0, Math.floor(ms / 1000));
	if (safe < 60) return `${safe}s`;
	const minutes = Math.floor(safe / 60);
	if (minutes < 60) return `${minutes}m`;
	if (safe < DAY_MS / 1000) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
	}
	const hours = Math.floor(minutes / 60);
	const restHours = hours % 24;
	return restHours === 0 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours / 24)}d${restHours}h`;
}

export function formatRate(tokens: number, elapsedMs: number): string {
	const rate = (tokens / Math.max(1, elapsedMs)) * 1000;
	if (rate >= 100) return `${Math.round(rate)}`;
	return rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);
}

export function cacheWidgetValue(
	ttl: CacheTtl,
	state: { touchedAtMs: number | undefined; nowMs: number },
): string | null {
	if (state.touchedAtMs === undefined) return null;
	const age = state.nowMs - state.touchedAtMs;
	if (ttl.ttlMs === null) return `~${formatSpan(age)}`;
	const remaining = ttl.ttlMs - age;
	return remaining <= 0 ? `${ttl.label}·cold` : `${ttl.label}·${formatSpan(remaining)}`;
}

export function tpsWidgetValue(
	tokens: number,
	elapsedMs: number,
	minSampleMs: number = MIN_SPEED_SAMPLE_MS,
): string | null {
	if (tokens <= 0 || elapsedMs < minSampleMs) return null;
	return `${formatRate(tokens, elapsedMs)} t/s`;
}

/** chars/4 fallback used only while streaming, before the provider reports usage.output. */
export function estimateTokens(message: unknown): number {
	if (!isRecord(message) || !Array.isArray(message.content)) return 0;
	let chars = 0;
	for (const block of message.content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			chars += block.text.length;
			continue;
		}
		if (block.type === "thinking") {
			const signature = block.thinkingSignature;
			if (isRecord(signature) && typeof signature.body === "string") chars += signature.body.length;
			else if (typeof block.thinking === "string") chars += block.thinking.length;
		}
	}
	return Math.floor(chars / ESTIMATED_CHARS_PER_TOKEN);
}

export function readUsage(message: unknown): UsageLike | undefined {
	if (!isRecord(message) || !isRecord(message.usage)) return undefined;
	const usage = message.usage;
	return {
		input: numberOrZero(usage.input),
		output: numberOrZero(usage.output),
		cacheRead: numberOrZero(usage.cacheRead),
		cacheWrite: numberOrZero(usage.cacheWrite),
		cacheWrite1h: numberOrZero(usage.cacheWrite1h),
	};
}

function timestampOf(entry: unknown, message: unknown): number | undefined {
	const candidates = [
		isRecord(message) ? message.timestamp : undefined,
		isRecord(entry) ? entry.timestamp : undefined,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
			return candidate;
		}
		if (typeof candidate === "string") {
			const parsed = Date.parse(candidate);
			if (!Number.isNaN(parsed)) return parsed;
		}
	}
	return undefined;
}

interface CacheEvidence {
	touchedAtMs?: number;
	sawOneHourWrite: boolean;
}

/** Seeds cache evidence from an existing session so a resumed session shows its real state. */
export function collectCacheEvidence(entries: readonly unknown[]): CacheEvidence {
	const evidence: CacheEvidence = { sawOneHourWrite: false };
	for (const entry of entries) {
		const message = isRecord(entry) ? entry.message : undefined;
		if (!isRecord(message) || message.role !== "assistant") continue;
		const usage = readUsage(message);
		if (!usage) continue;
		if ((usage.cacheWrite1h ?? 0) > 0) evidence.sawOneHourWrite = true;
		if ((usage.cacheRead ?? 0) > 0 || (usage.cacheWrite ?? 0) > 0) {
			evidence.touchedAtMs = timestampOf(entry, message) ?? evidence.touchedAtMs;
		}
	}
	return evidence;
}

export default function cacheTpsWidgets(pi: ExtensionAPI): void {
	let evidence: CacheEvidence = { sawOneHourWrite: false };
	let responseStartMs: number | undefined;
	let responseTokens = 0;
	let lastSpeed: string | null = null;
	let activeCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let streaming = false;
	const published = new Map<string, string | null>();

	const model = (): ModelLike | undefined => activeCtx?.model as ModelLike | undefined;

	const emit = (widgetId: string, value: string | null): void => {
		if (published.get(widgetId) === value) return;
		published.set(widgetId, value);
		pi.events.emit(UPDATE_WIDGET_EVENT, { widgetId, value });
	};

	const refreshCache = (): void => {
		const value = cacheWidgetValue(
			resolveCacheTtl(model(), { long: retentionIsLong(), ...evidence }),
			{ touchedAtMs: evidence.touchedAtMs, nowMs: Date.now() },
		);
		emit(CACHE_TTL_WIDGET_ID, value);
	};

	const refreshSpeed = (): void => {
		if (responseStartMs !== undefined) {
			const live = tpsWidgetValue(responseTokens, Date.now() - responseStartMs);
			if (live !== null) {
				lastSpeed = live;
				emit(TPS_WIDGET_ID, live);
				return;
			}
		}
		// Keep the last completed response visible while idle instead of blanking the widget.
		if (lastSpeed !== null) emit(TPS_WIDGET_ID, lastSpeed);
	};

	const tick = (): void => {
		refreshSpeed();
		refreshCache();
	};

	const startTimer = (intervalMs: number): void => {
		if (timer) clearInterval(timer);
		timer = setInterval(tick, intervalMs);
		(timer as unknown as { unref?: () => void }).unref?.();
	};

	const stopTimer = (): void => {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		responseStartMs = undefined;
		responseTokens = 0;
		lastSpeed = null;
		published.clear();
		evidence = collectCacheEvidence(ctx.sessionManager.getBranch());
		streaming = false;
		refreshCache();
		emit(TPS_WIDGET_ID, null);
		startTimer(IDLE_TICK_MS);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		activeCtx = undefined;
	});

	pi.on("model_select", async (_event, ctx) => {
		// A different model can use a different retention tier: drop evidence from the old one.
		activeCtx = ctx;
		evidence = { sawOneHourWrite: false };
		refreshCache();
	});

	pi.on("message_start", async (event, ctx) => {
		activeCtx = ctx;
		const message = event.message;
		if (!isRecord(message) || message.role !== "assistant") return;
		responseStartMs = Date.now();
		responseTokens = readUsage(message)?.output ?? 0;
		streaming = true;
		startTimer(STREAM_TICK_MS);
	});

	pi.on("message_update", async (event, ctx) => {
		activeCtx = ctx;
		const message = event.message;
		if (!isRecord(message) || message.role !== "assistant") return;
		if (responseStartMs === undefined) {
			responseStartMs = Date.now();
			startTimer(STREAM_TICK_MS);
		}
		const reported = readUsage(message)?.output ?? 0;
		responseTokens = reported > 0 ? reported : Math.max(responseTokens, estimateTokens(message));
	});

	pi.on("message_end", async (event, ctx) => {
		activeCtx = ctx;
		const message = event.message;
		if (!isRecord(message) || message.role !== "assistant") return;
		const startedAt = responseStartMs ?? Date.now();
		const usage = readUsage(message);
		const tokens = usage?.output && usage.output > 0 ? usage.output : estimateTokens(message);

		responseTokens = tokens;
		// A finished response is a complete measurement, so it does not need the live-sample bar.
		const speed = tpsWidgetValue(tokens, Date.now() - startedAt, MIN_FINAL_SAMPLE_MS);
		if (speed !== null) lastSpeed = speed;

		if (usage && ((usage.cacheRead ?? 0) > 0 || (usage.cacheWrite ?? 0) > 0)) {
			// Anthropic starts the TTL clock at the start of the request that touches the entry.
			evidence.touchedAtMs = startedAt;
		}
		if (usage && (usage.cacheWrite1h ?? 0) > 0) evidence.sawOneHourWrite = true;

		responseStartMs = undefined;
		streaming = false;
		emit(TPS_WIDGET_ID, lastSpeed);
		refreshCache();
		startTimer(IDLE_TICK_MS);
	});

	pi.on("turn_end", () => {
		if (streaming) return;
		refreshCache();
	});
}

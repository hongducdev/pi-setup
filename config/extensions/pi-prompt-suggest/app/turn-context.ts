/**
 * Turn context: the minimum a next-prompt suggester needs from the conversation.
 *
 * Everything is derived from `ctx.sessionManager.getBranch()` so the pipeline does not depend on
 * event payloads and stays consistent with the branch the user is actually on.
 */

export interface TurnContext {
	status: "completed" | "aborted" | "error";
	/** Text of the most recent assistant message on the branch. */
	latestAssistantText: string;
	/** Most recent user prompts, newest first. */
	recentUserPrompts: string[];
	/** Tools the last turn actually called, with a short argument hint. */
	toolSignals: string[];
	/** Files the last turn read or wrote, newest first. */
	touchedFiles: string[];
}

export interface TurnContextLimits {
	recentUserPrompts: number;
	recentUserPromptChars: number;
	latestAssistantChars: number;
	maxToolSignals: number;
	maxToolSignalChars: number;
	maxTouchedFiles: number;
}

export const DEFAULT_TURN_LIMITS: TurnContextLimits = {
	recentUserPrompts: 6,
	recentUserPromptChars: 400,
	latestAssistantChars: 6000,
	maxToolSignals: 8,
	maxToolSignalChars: 160,
	maxTouchedFiles: 8,
};

/** Minimal structural view of a session entry; avoids depending on pi's internal entry union. */
export interface BranchEntryLike {
	type?: string;
	message?: unknown;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
}

/** Tools whose calls indicate which files the turn was working with. */
const FILE_ARG_KEYS = ["path", "file_path", "filePath", "file", "notebook_path"];

export function buildTurnContext(
	entries: readonly BranchEntryLike[],
	limits: TurnContextLimits = DEFAULT_TURN_LIMITS,
): TurnContext | undefined {
	const messages = entries
		.filter((entry) => entry?.type === "message")
		.map((entry) => entry.message as MessageLike)
		.filter((message): message is MessageLike => typeof message === "object" && message !== null);

	if (messages.length === 0) return undefined;

	const assistantIndex = findLastIndex(messages, (message) => message.role === "assistant");
	if (assistantIndex < 0) return undefined;

	const assistant = messages[assistantIndex]!;
	const status = statusFromStopReason(assistant.stopReason);

	const recentUserPrompts: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		const text = extractText(message.content).trim();
		if (!text) continue;
		if (recentUserPrompts.some((existing) => existing === text)) continue;
		recentUserPrompts.push(truncate(text, limits.recentUserPromptChars));
		if (recentUserPrompts.length >= limits.recentUserPrompts) break;
	}

	// Tool activity belongs to the current turn: everything after the last user prompt.
	const lastUserIndex = findLastIndex(messages, (message) => message.role === "user");
	const turnStart = lastUserIndex >= 0 ? lastUserIndex : 0;
	const toolSignals: string[] = [];
	const touchedFiles: string[] = [];

	for (const message of messages.slice(turnStart)) {
		for (const call of extractToolCalls(message.content)) {
			if (toolSignals.length < limits.maxToolSignals) {
				const hint = summarizeArguments(call.arguments);
				toolSignals.push(truncate(hint ? `${call.name} ${hint}` : call.name, limits.maxToolSignalChars));
			}
			const file = extractFilePath(call.arguments);
			if (file && !touchedFiles.includes(file) && touchedFiles.length < limits.maxTouchedFiles) {
				touchedFiles.push(file);
			}
		}
	}

	return {
		status,
		latestAssistantText: truncate(extractText(assistant.content), limits.latestAssistantChars),
		recentUserPrompts,
		toolSignals,
		touchedFiles,
	};
}

function statusFromStopReason(stopReason: string | undefined): TurnContext["status"] {
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return "completed";
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (predicate(items[index]!)) return index;
	}
	return -1;
}

/** Flatten a message's content into plain text, ignoring thinking and tool-call blocks. */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("\n");
}

interface ToolCallLike {
	name: string;
	arguments: Record<string, unknown>;
}

function extractToolCalls(content: unknown): ToolCallLike[] {
	if (!Array.isArray(content)) return [];
	const calls: ToolCallLike[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: unknown; name?: unknown; arguments?: unknown };
		if (typed.type !== "toolCall" || typeof typed.name !== "string") continue;
		const args = typed.arguments;
		calls.push({
			name: typed.name,
			arguments: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
		});
	}
	return calls;
}

function extractFilePath(args: Record<string, unknown>): string | undefined {
	for (const key of FILE_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/** One short, human-readable argument hint - enough to know what the tool was aimed at. */
function summarizeArguments(args: Record<string, unknown>): string {
	const file = extractFilePath(args);
	if (file) return file;
	for (const key of ["command", "pattern", "query", "prompt", "description"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return truncate(value, 60);
	}
	return "";
}

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

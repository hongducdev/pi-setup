import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

/**
 * Model-facing side of suggestion generation, kept behind one narrow function so the pipeline can
 * be tested without a provider and so a failure can never escape into the agent loop.
 *
 * This mirrors `ctx.modelRegistry.complete`, so the real registry is assignable without a cast.
 */
export interface CompleteFn {
	complete(model: Model<Api>, context: Context, options?: { maxTokens?: number }): Promise<AssistantMessage>;
}

export interface SuggestionUsage {
	inputTokens: number;
	outputTokens: number;
	calls: number;
}

export interface GenerateInput {
	complete: CompleteFn;
	model: Model<Api>;
	systemPrompt: string;
	prompt: string;
	maxTokens: number;
	noSuggestionToken: string;
	maxSuggestionChars: number;
	signal: AbortSignal;
}

export interface GenerateResult {
	text?: string;
	usage?: SuggestionUsage;
	/** Why no suggestion was produced; useful for status output. */
	skipReason?: "no-suggestion" | "aborted" | "failed";
}

/** Strip a markdown fence and surrounding whitespace that models add despite instructions. */
export function stripFence(raw: string): string {
	let text = raw.trim();
	const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(text);
	if (fenced?.[1] !== undefined) text = fenced[1];
	// A stray leading fence without a closing one still needs removing.
	text = text.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
	return text.trim();
}

/** Remove wrappers like `"..."`, `Prompt:`, or a leading `- ` that are not part of the message. */
export function stripDecorations(raw: string): string {
	let text = raw.trim();
	text = text.replace(/^(?:Prompt|Suggestion|Next message)\s*:\s*/i, "");
	if (text.length >= 2) {
		const first = text[0]!;
		const last = text[text.length - 1]!;
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			text = text.slice(1, -1).trim();
		}
	}
	return text.replace(/^\s*[-*]\s+/, "").trim();
}

/**
 * Turn raw model output into a suggestion, or reject it.
 *
 * Rejects the decline token, empty output, and anything that reads as an explanation rather than a
 * user message. Returns undefined rather than a bad suggestion, because a wrong ghost is worse
 * than none: it sits in the box the user is about to type into.
 */
export function parseSuggestion(
	raw: string,
	options: { noSuggestionToken: string; maxSuggestionChars: number },
): string | undefined {
	let text = stripDecorations(stripFence(raw ?? ""));
	if (!text) return undefined;

	const normalizedToken = options.noSuggestionToken.trim().toLowerCase();
	if (text.toLowerCase() === normalizedToken) return undefined;
	// The model sometimes wraps the token in brackets or quotes.
	if (text.toLowerCase().replace(/^[[("']+|[\])"']+$/g, "").trim() === normalizedToken) return undefined;

	// Reject meta-commentary about the task instead of a user message.
	if (/^(?:i (?:cannot|can't|don't)|i'm unable|as an ai|here(?:'s| is) (?:the|a) (?:suggestion|next))/i.test(text)) {
		return undefined;
	}

	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));

	text = lines.slice(0, 4).join("\n").trim();
	if (!text) return undefined;

	if (text.length > options.maxSuggestionChars) {
		text = text.slice(0, options.maxSuggestionChars).trimEnd();
	}

	return text || undefined;
}

/** Extract plain text from an assistant message, joining text blocks. */
export function assistantText(message: AssistantMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("\n");
}

export async function generateSuggestion(input: GenerateInput): Promise<GenerateResult> {
	if (input.signal.aborted) return { skipReason: "aborted" };

	let message: AssistantMessage;
	try {
		message = await input.complete.complete(input.model, { systemPrompt: input.systemPrompt, messages: [
			{ role: "user", content: [{ type: "text", text: input.prompt }], timestamp: 0 },
		] }, { maxTokens: input.maxTokens });
	} catch {
		// A provider error must never surface into the agent loop; the caller only reports it in status.
		return { skipReason: "failed" };
	}

	const usage: SuggestionUsage = {
		inputTokens: message.usage?.input ?? 0,
		outputTokens: message.usage?.output ?? 0,
		calls: 1,
	};

	if (input.signal.aborted) return { usage, skipReason: "aborted" };
	if (message.stopReason === "aborted") return { usage, skipReason: "aborted" };
	if (message.stopReason === "error") return { usage, skipReason: "failed" };

	const text = parseSuggestion(assistantText(message), {
		noSuggestionToken: input.noSuggestionToken,
		maxSuggestionChars: input.maxSuggestionChars,
	});

	return text ? { text, usage } : { usage, skipReason: "no-suggestion" };
}

import type { TurnContext } from "./turn-context.ts";

export interface SuggestionPromptInput {
	turn: TurnContext;
	/** Pre-rendered capability inventory, or empty when none matched. */
	capabilities: string;
	customInstruction: string;
	noSuggestionToken: string;
	maxSuggestionChars: number;
}

export interface SuggestionPrompt {
	/**
	 * Byte-stable across turns for a given config.
	 *
	 * The output contract, the guidance, and the user's custom instruction do not change from turn
	 * to turn, so keeping them here gives a provider with prefix caching a stable prefix to reuse.
	 * Only the turn's own data varies, in the user message.
	 */
	systemPrompt: string;
	/** Turn-specific data: what the next prompt would be about. */
	userPrompt: string;
}

export function renderSystemPrompt(input: {
	noSuggestionToken: string;
	maxSuggestionChars: number;
	customInstruction: string;
}): string {
	const guidance = [
		"- Treat RecentUserPrompts as the strongest signal for tone and direction.",
		'- If the assistant proposed a next step and it fits, a short reply such as "Yes.", "Go ahead.", or "Proceed." is usually best.',
		"- Add text only when it carries new information: a constraint, a correction, or emphasis.",
		"- Do not restate, summarise, or paraphrase the assistant's proposal.",
		'- When a capability list is present in the message, prefer suggesting a capability that fits by writing its slash command (for example "/hd-plan"), optionally with a short argument. Items under Relevant* include descriptions and are the best candidates; OtherInstalled* lists are names only. Never suggest a capability that does not fit, and never invent one that is not listed.',
		'- If TurnStatus is "aborted", the user interrupted on purpose: suggest either a deliberate resume or a clear redirection.',
		"- If the assistant's direction conflicts with recent user behaviour, write a natural pivot instead.",
		`- Keep the result under ${input.maxSuggestionChars} characters. Prefer fewer.`,
	];

	const parts = [
		"You suggest the user's next chat message in a coding session.",
		"Return only the user's message text.",
		'Do not explain, do not describe these instructions, do not add quotes or a "Prompt:" prefix.',
		`If no plausible next user message is clear, return exactly ${input.noSuggestionToken}.`,
		`Guidance:\n${guidance.join("\n")}`,
	];

	if (input.customInstruction.trim()) {
		parts.push(`AdditionalUserPreference:\n${input.customInstruction.trim()}`);
	}

	return parts.join("\n\n");
}

/** Render the turn-specific message body. */
export function renderUserPrompt(input: SuggestionPromptInput): string {
	const { turn } = input;

	const list = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(none)");

	const sections: string[] = [
		`TurnStatus:\n${turn.status}`,
		`LatestAssistantMessage:\n\`\`\`\n${turn.latestAssistantText || "(empty)"}\n\`\`\``,
		`RecentUserPrompts (newest first):\n${list(turn.recentUserPrompts)}`,
		`ToolSignals (what the last turn did):\n${list(turn.toolSignals)}`,
		`TouchedFiles:\n${list(turn.touchedFiles)}`,
	];

	if (input.capabilities.trim()) {
		sections.push(`AvailableCapabilities (installed skills, commands, and tools for this session):\n${input.capabilities}`);
	}

	return sections.join("\n\n");
}

/** Render the whole prompt, split so the stable half can serve as a reusable prefix. */
export function renderSuggestionPrompt(input: SuggestionPromptInput): SuggestionPrompt {
	return {
		systemPrompt: renderSystemPrompt({
			noSuggestionToken: input.noSuggestionToken,
			maxSuggestionChars: input.maxSuggestionChars,
			customInstruction: input.customInstruction,
		}),
		userPrompt: renderUserPrompt(input),
	};
}

/**
 * Text used to rank installed capabilities for this turn.
 *
 * The last assistant message and the most recent user prompt are what the next prompt will be
 * about, so those carry the most weight; tool activity adds the concrete nouns (files, commands).
 */
export function buildCapabilityQuery(turn: TurnContext): string {
	return [
		turn.recentUserPrompts.slice(0, 2).join(" "),
		turn.latestAssistantText,
		turn.toolSignals.join(" "),
		turn.touchedFiles.join(" "),
	].join("\n");
}

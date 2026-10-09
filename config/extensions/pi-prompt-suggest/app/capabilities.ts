/**
 * Capability inventory: what skills, commands, and tools this session actually has.
 *
 * Sending every installed skill to the model on every turn would be both slow and expensive - a
 * large skill library runs to thousands of tokens. Instead the inventory is ranked locally against
 * the current turn's text and only the best matches are rendered into the prompt.
 */

export interface CapabilityItem {
	name: string;
	description?: string;
	/** For tools: which extension, package, or "builtin" provides it. */
	source?: string;
	active?: boolean;
}

export interface Capabilities {
	skills: CapabilityItem[];
	customCommands: CapabilityItem[];
	promptTemplates: CapabilityItem[];
	tools: CapabilityItem[];
}

export interface CapabilitySource {
	getCommands(): Array<{ name: string; description?: string; source: string }>;
	getAllTools(): Array<{ name: string; description?: string; sourceInfo: { source: string } }>;
	getActiveTools(): string[];
}

export interface CapabilityLimits {
	/** Maximum items kept per category after ranking. */
	maxPerCategory: number;
	/** Descriptions are truncated to this many characters. */
	maxDescriptionChars: number;
	/** Cap on the names-only list of capabilities that did not rank. */
	maxUnmatchedNames: number;
}

export const DEFAULT_CAPABILITY_LIMITS: CapabilityLimits = {
	maxPerCategory: 12,
	maxDescriptionChars: 80,
	maxUnmatchedNames: 80,
};

/** Commands this extension registers; never worth suggesting back to the user. */
const OWN_COMMANDS = new Set(["suggester"]);

export function collectCapabilities(source: CapabilitySource): Capabilities {
	const commands = safe(source.getCommands);
	const tools = safe(source.getAllTools);
	const activeTools = new Set(safe(source.getActiveTools) ?? []);

	const skills: CapabilityItem[] = [];
	const customCommands: CapabilityItem[] = [];
	const promptTemplates: CapabilityItem[] = [];

	for (const command of commands ?? []) {
		if (!command?.name || OWN_COMMANDS.has(command.name)) continue;
		const item: CapabilityItem = { name: command.name, description: command.description };
		if (command.source === "skill") skills.push(item);
		else if (command.source === "prompt") promptTemplates.push(item);
		else customCommands.push(item);
	}

	const toolItems: CapabilityItem[] = (tools ?? [])
		.filter((tool) => tool?.name)
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			source: shortenSource(tool.sourceInfo?.source),
			active: activeTools.has(tool.name),
		}));

	return { skills, customCommands, promptTemplates, tools: toolItems };
}

function safe<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		// A capability lookup must never take down a suggestion.
		return undefined;
	}
}

/** Package sources arrive as paths or specifiers; keep only the readable tail. */
function shortenSource(source: string | undefined): string | undefined {
	if (!source) return undefined;
	const cleaned = source.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = cleaned.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? source;
}

const STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "have", "has", "was", "were", "are", "not",
	"but", "you", "your", "can", "will", "would", "should", "could", "then", "than", "them", "they",
	"all", "any", "one", "two", "into", "out", "over", "under", "about", "when", "what", "which",
	"how", "why", "who", "use", "using", "used", "make", "made", "get", "got", "let", "its", "it's",
]);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff:_-]+/u)
		.map((token) => token.replace(/^[-:_]+|[-:_]+$/g, ""))
		.filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Score by how many distinct query tokens appear in the item's name or description.
 *
 * Deliberately simple: it runs on every turn, so it must be cheap and predictable. Ties break on
 * name length so shorter, more general capabilities win over very specific ones.
 */
export function scoreItem(item: CapabilityItem, queryTokens: Set<string>): number {
	if (queryTokens.size === 0) return 0;
	const haystack = `${item.name} ${item.description ?? ""}`.toLowerCase();
	let score = 0;
	for (const token of queryTokens) {
		if (haystack.includes(token)) score += 1;
	}
	return score;
}

export function rankItems(items: CapabilityItem[], query: string, max: number): CapabilityItem[] {
	if (max <= 0) return [];
	const queryTokens = new Set(tokenize(query));
	if (queryTokens.size === 0) return [];

	const scored = items
		.map((item) => ({ item, score: scoreItem(item, queryTokens) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);

	return scored.slice(0, max).map((entry) => entry.item);
}

/**
 * Ranking result.
 *
 * `matched` carries descriptions so the model can judge fitness. `unmatched` carries only names:
 * keyword ranking cannot see semantic relevance ("fix the parser" does not overlap "debug root
 * cause"), and a bare name list is cheap enough that the whole toolbox can stay visible.
 */
export interface CapabilitySelection {
	matched: Capabilities;
	unmatched: Capabilities;
}

function withoutSelected(all: CapabilityItem[], selected: CapabilityItem[], max: number): CapabilityItem[] {
	const chosen = new Set(selected.map((item) => item.name));
	return all
		.filter((item) => !chosen.has(item.name))
		.slice(0, max)
		.map((item) => ({ name: item.name }));
}

/** Rank every category against the turn text, keeping an unmatched name index alongside. */
export function selectCapabilities(
	capabilities: Capabilities,
	query: string,
	limits: CapabilityLimits = DEFAULT_CAPABILITY_LIMITS,
): CapabilitySelection {
	const matched: Capabilities = {
		skills: rankItems(capabilities.skills, query, limits.maxPerCategory),
		customCommands: rankItems(capabilities.customCommands, query, limits.maxPerCategory),
		promptTemplates: rankItems(capabilities.promptTemplates, query, limits.maxPerCategory),
		// Tools are grouped by owner and ranked within the group, so one noisy package cannot
		// crowd out the others.
		tools: rankToolGroups(capabilities.tools, query, limits),
	};

	return {
		matched,
		unmatched: {
			skills: withoutSelected(capabilities.skills, matched.skills, limits.maxUnmatchedNames),
			customCommands: withoutSelected(capabilities.customCommands, matched.customCommands, limits.maxUnmatchedNames),
			promptTemplates: withoutSelected(capabilities.promptTemplates, matched.promptTemplates, limits.maxUnmatchedNames),
			tools: withoutSelected(capabilities.tools, matched.tools, limits.maxUnmatchedNames),
		},
	};
}

function rankToolGroups(tools: CapabilityItem[], query: string, limits: CapabilityLimits): CapabilityItem[] {
	const bySource = new Map<string, CapabilityItem[]>();
	for (const tool of tools) {
		const key = tool.source ?? "builtin";
		bySource.set(key, [...(bySource.get(key) ?? []), tool]);
	}

	const perGroup = Math.max(1, Math.ceil(limits.maxPerCategory / Math.max(1, bySource.size)));
	const selected: CapabilityItem[] = [];
	for (const group of bySource.values()) {
		selected.push(...rankItems(group, query, perGroup));
	}
	return selected;
}

export function isEmptyCapabilities(capabilities: Capabilities): boolean {
	return (
		capabilities.skills.length === 0 &&
		capabilities.customCommands.length === 0 &&
		capabilities.promptTemplates.length === 0 &&
		capabilities.tools.length === 0
	);
}

/**
 * Render the selection for the prompt.
 *
 * The `[inactive]` marker matters: suggesting a tool that is registered but not currently active
 * would produce a prompt the agent cannot satisfy.
 */
export function renderCapabilities(
	selection: CapabilitySelection,
	limits: CapabilityLimits = DEFAULT_CAPABILITY_LIMITS,
): string {
	const lines: string[] = [];

	const section = (title: string, items: CapabilityItem[], formatter: (item: CapabilityItem) => string) => {
		if (items.length === 0) return;
		lines.push(`${title}:`);
		for (const item of items) lines.push(`- ${formatter(item)}`);
	};

	const namesOnly = (title: string, items: CapabilityItem[]) => {
		if (items.length === 0) return;
		lines.push(`${title}: ${items.map((item) => item.name).join(", ")}`);
	};

	const withDescription = (item: CapabilityItem) =>
		item.description ? `${item.name} — ${truncate(item.description, limits.maxDescriptionChars)}` : item.name;

	const matched = selection.matched;
	const unmatched = selection.unmatched;

	section("RelevantSkills (invoke by writing the slash command as the prompt)", matched.skills, withDescription);
	section("RelevantCommands", matched.customCommands, withDescription);
	section("RelevantPromptTemplates", matched.promptTemplates, withDescription);
	section("RelevantTools (name — owner)", matched.tools, (item) => {
		const inactive = item.active === false ? " [inactive]" : "";
		return `${item.name} — ${item.source ?? "builtin"}${inactive}`;
	});

	// Names only: keeps the full toolbox knowable without paying for every description.
	namesOnly("OtherInstalledSkills", unmatched.skills);
	namesOnly("OtherInstalledCommands", unmatched.customCommands);
	namesOnly("OtherInstalledPromptTemplates", unmatched.promptTemplates);
	namesOnly("OtherInstalledTools", unmatched.tools);

	return lines.join("\n");
}

/** True when the selection has nothing at all to say. */
export function isEmptySelection(selection: CapabilitySelection): boolean {
	return isEmptyCapabilities(selection.matched) && isEmptyCapabilities(selection.unmatched);
}

export function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

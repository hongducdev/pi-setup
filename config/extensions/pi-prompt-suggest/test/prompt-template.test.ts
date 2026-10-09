import { describe, expect, test } from "bun:test";
import { buildCapabilityQuery, renderSuggestionPrompt, renderSystemPrompt, renderUserPrompt } from "../app/prompt-template.ts";
import type { TurnContext } from "../app/turn-context.ts";

const turn: TurnContext = {
	status: "completed",
	latestAssistantText: "I updated the parser and all tests pass.",
	recentUserPrompts: ["fix the parser", "also check edge cases"],
	toolSignals: ["edit src/parser.ts", "powershell bun test"],
	touchedFiles: ["src/parser.ts"],
};

const base = {
	turn,
	capabilities: "",
	customInstruction: "",
	noSuggestionToken: "[no suggestion]",
	maxSuggestionChars: 200,
};

describe("renderSuggestionPrompt", () => {
	test("keeps the output contract in the stable system prompt", () => {
		const { systemPrompt } = renderSuggestionPrompt(base);
		expect(systemPrompt).toContain("Return only the user's message text.");
		expect(systemPrompt).toContain("[no suggestion]");
		expect(systemPrompt).toContain("under 200 characters");
	});

	test("the system prompt is byte-stable across turns so a provider can cache the prefix", () => {
		const first = renderSuggestionPrompt(base).systemPrompt;
		const second = renderSuggestionPrompt({ ...base, capabilities: "RelevantSkills:\n- a — b" }).systemPrompt;
		expect(second).toBe(first);
	});

	test("the system prompt is stable when the custom instruction changes only in content", () => {
		const withInstruction = renderSystemPrompt({ ...base, customInstruction: "Be terse." });
		expect(withInstruction).toContain("Be terse.");
	});

	test("includes the turn status and assistant message in the user prompt", () => {
		const { userPrompt } = renderSuggestionPrompt(base);
		expect(userPrompt).toContain("TurnStatus:\ncompleted");
		expect(userPrompt).toContain("I updated the parser and all tests pass.");
	});

	test("includes recent user prompts, tool signals, and touched files", () => {
		const { userPrompt } = renderSuggestionPrompt(base);
		expect(userPrompt).toContain("fix the parser");
		expect(userPrompt).toContain("edit src/parser.ts");
		expect(userPrompt).toContain("src/parser.ts");
	});

	test("omits the capability section when nothing matched", () => {
		expect(renderSuggestionPrompt(base).userPrompt).not.toContain("AvailableCapabilities");
	});

	test("includes capabilities in the user prompt", () => {
		const { systemPrompt, userPrompt } = renderSuggestionPrompt({
			...base,
			capabilities: "RelevantSkills:\n- ck:plan — plan work",
		});
		expect(userPrompt).toContain("AvailableCapabilities");
		expect(userPrompt).toContain("ck:plan");
		expect(systemPrompt).toContain("never invent one that is not listed");
	});

	test("includes a custom instruction in the system prompt only when set", () => {
		expect(renderSuggestionPrompt(base).systemPrompt).not.toContain("AdditionalUserPreference");
		expect(renderSuggestionPrompt({ ...base, customInstruction: "Be terse." }).systemPrompt).toContain("Be terse.");
	});

	test("handles an empty assistant message", () => {
		const prompt = renderUserPrompt({ ...base, turn: { ...turn, latestAssistantText: "" } });
		expect(prompt).toContain("(empty)");
	});

	test("marks empty lists instead of leaving a blank section", () => {
		const prompt = renderUserPrompt({
			...base,
			turn: { ...turn, toolSignals: [], touchedFiles: [], recentUserPrompts: [] },
		});
		expect(prompt).toContain("(none)");
	});
});

describe("buildCapabilityQuery", () => {
	test("carries the text a next prompt would be about", () => {
		const query = buildCapabilityQuery(turn);
		expect(query).toContain("fix the parser");
		expect(query).toContain("also check edge cases");
		expect(query).toContain("I updated the parser");
		expect(query).toContain("src/parser.ts");
	});

	test("weights only the two most recent user prompts", () => {
		const many: TurnContext = {
			...turn,
			recentUserPrompts: ["newest", "second", "third", "fourth"],
		};
		const query = buildCapabilityQuery(many);
		expect(query).toContain("newest");
		expect(query).toContain("second");
		expect(query).not.toContain("third");
	});
});

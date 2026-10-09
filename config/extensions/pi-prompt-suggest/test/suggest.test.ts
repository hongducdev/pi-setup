import { describe, expect, test } from "bun:test";
import { generateSuggestion, parseSuggestion } from "../app/suggest.ts";

const parseOptions = { noSuggestionToken: "[no suggestion]", maxSuggestionChars: 200 };

describe("parseSuggestion", () => {
	test("returns plain text unchanged", () => {
		expect(parseSuggestion("Run the tests again.", parseOptions)).toBe("Run the tests again.");
	});

	test("strips a markdown fence", () => {
		expect(parseSuggestion("```\nRun the tests again.\n```", parseOptions)).toBe("Run the tests again.");
	});

	test("strips a fence with a language tag", () => {
		expect(parseSuggestion("```text\nYes, go ahead.\n```", parseOptions)).toBe("Yes, go ahead.");
	});

	test("strips surrounding quotes", () => {
		expect(parseSuggestion('"Yes, go ahead."', parseOptions)).toBe("Yes, go ahead.");
	});

	test("strips a Prompt: prefix", () => {
		expect(parseSuggestion("Prompt: Yes, go ahead.", parseOptions)).toBe("Yes, go ahead.");
	});

	test("strips a leading bullet", () => {
		expect(parseSuggestion("- Yes, go ahead.", parseOptions)).toBe("Yes, go ahead.");
	});

	test("rejects the decline token", () => {
		expect(parseSuggestion("[no suggestion]", parseOptions)).toBeUndefined();
	});

	test("rejects a decorated decline token", () => {
		expect(parseSuggestion('"[no suggestion]"', parseOptions)).toBeUndefined();
	});

	test("rejects a decline token in different case", () => {
		expect(parseSuggestion("[No Suggestion]", parseOptions)).toBeUndefined();
	});

	test("rejects empty output", () => {
		expect(parseSuggestion("", parseOptions)).toBeUndefined();
		expect(parseSuggestion("   \n  ", parseOptions)).toBeUndefined();
	});

	test("rejects a fenced empty block", () => {
		expect(parseSuggestion("```\n```", parseOptions)).toBeUndefined();
	});

	test("rejects meta commentary about the task", () => {
		expect(parseSuggestion("I cannot determine the next message.", parseOptions)).toBeUndefined();
		expect(parseSuggestion("Here is the suggestion:", parseOptions)).toBeUndefined();
		expect(parseSuggestion("As an AI, I would say:", parseOptions)).toBeUndefined();
	});

	test("clamps to the character budget", () => {
		const result = parseSuggestion("x".repeat(500), { ...parseOptions, maxSuggestionChars: 50 });
		expect(result).toHaveLength(50);
	});

	test("keeps a short multi-line prompt", () => {
		const result = parseSuggestion("First line\nSecond line", parseOptions);
		expect(result).toBe("First line\nSecond line");
	});

	test("drops excess lines", () => {
		const result = parseSuggestion("1\n2\n3\n4\n5\n6", parseOptions);
		expect(result?.split("\n")).toHaveLength(4);
	});
});

interface FakeMessage {
	content: unknown;
	usage?: { input: number; output: number };
	stopReason: string;
}

function fakeComplete(message: FakeMessage | (() => never)) {
	return {
		async complete() {
			if (typeof message === "function") return message();
			return message as never;
		},
	};
}

const generateBase = {
	model: {} as never,
	systemPrompt: "s",
	prompt: "p",
	maxTokens: 100,
	noSuggestionToken: "[no suggestion]",
	maxSuggestionChars: 200,
	signal: new AbortController().signal,
};

describe("generateSuggestion", () => {
	test("returns text and usage on success", async () => {
		const result = await generateSuggestion({
			...generateBase,
			complete: fakeComplete({
				content: [{ type: "text", text: "Yes." }],
				usage: { input: 120, output: 4 },
				stopReason: "stop",
			}),
		});
		expect(result.text).toBe("Yes.");
		expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 4, calls: 1 });
	});

	test("reports no-suggestion without text", async () => {
		const result = await generateSuggestion({
			...generateBase,
			complete: fakeComplete({ content: [{ type: "text", text: "[no suggestion]" }], stopReason: "stop" }),
		});
		expect(result.text).toBeUndefined();
		expect(result.skipReason).toBe("no-suggestion");
	});

	test("never throws when the provider fails", async () => {
		const result = await generateSuggestion({
			...generateBase,
			complete: fakeComplete(() => {
				throw new Error("provider exploded");
			}),
		});
		expect(result.skipReason).toBe("failed");
	});

	test("reports a provider-side abort as aborted", async () => {
		const result = await generateSuggestion({
			...generateBase,
			complete: fakeComplete({ content: [], stopReason: "aborted" }),
		});
		expect(result.skipReason).toBe("aborted");
	});

	test("reports an error stop reason as failed", async () => {
		const result = await generateSuggestion({
			...generateBase,
			complete: fakeComplete({ content: [], stopReason: "error" }),
		});
		expect(result.skipReason).toBe("failed");
	});

	test("does not call the provider when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const result = await generateSuggestion({
			...generateBase,
			signal: controller.signal,
			complete: {
				async complete() {
					called = true;
					return {} as never;
				},
			},
		});
		expect(called).toBe(false);
		expect(result.skipReason).toBe("aborted");
	});

	test("passes the token ceiling through to the provider", async () => {
		let seen: { maxTokens?: number } | undefined;
		await generateSuggestion({
			...generateBase,
			maxTokens: 77,
			complete: {
				async complete(_model, _context, options) {
					seen = options;
					return { content: [{ type: "text", text: "ok" }], stopReason: "stop" } as never;
				},
			},
		});
		expect(seen?.maxTokens).toBe(77);
	});
});

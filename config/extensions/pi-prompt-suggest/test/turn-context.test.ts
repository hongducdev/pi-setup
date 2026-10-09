import { describe, expect, test } from "bun:test";
import { buildTurnContext, DEFAULT_TURN_LIMITS } from "../app/turn-context.ts";

const entry = (message: unknown) => ({ type: "message", message });

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (blocks: unknown[], stopReason = "stop") => ({ role: "assistant", content: blocks, stopReason });
const text = (value: string) => ({ type: "text", text: value });
const toolCall = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", id: `t-${name}`, name, arguments: args });

describe("buildTurnContext", () => {
	test("returns undefined when the branch has no assistant message", () => {
		expect(buildTurnContext([entry(user("hi"))])).toBeUndefined();
	});

	test("returns undefined for an empty branch", () => {
		expect(buildTurnContext([])).toBeUndefined();
	});

	test("takes the latest assistant text, ignoring thinking blocks", () => {
		const turn = buildTurnContext([
			entry(user("do it")),
			entry(assistant([{ type: "thinking", thinking: "hmm" }, text("Done, tests pass.")])),
		]);
		expect(turn?.latestAssistantText).toBe("Done, tests pass.");
	});

	test("reports turn status from the stop reason", () => {
		expect(buildTurnContext([entry(user("a")), entry(assistant([text("x")], "aborted"))])?.status).toBe("aborted");
		expect(buildTurnContext([entry(user("a")), entry(assistant([text("x")], "error"))])?.status).toBe("error");
		expect(buildTurnContext([entry(user("a")), entry(assistant([text("x")], "stop"))])?.status).toBe("completed");
	});

	test("collects recent user prompts newest first and de-duplicates", () => {
		const turn = buildTurnContext([
			entry(user("first")),
			entry(assistant([text("ok")])),
			entry(user("second")),
			entry(assistant([text("ok")])),
			entry(user("second")),
		]);
		expect(turn?.recentUserPrompts).toEqual(["second", "first"]);
	});

	test("caps recent user prompts", () => {
		const entries = Array.from({ length: 20 }, (_, index) => entry(user(`prompt ${index}`)));
		entries.push(entry(assistant([text("done")])));
		const turn = buildTurnContext(entries, { ...DEFAULT_TURN_LIMITS, recentUserPrompts: 3 });
		expect(turn?.recentUserPrompts).toHaveLength(3);
	});

	test("reads user prompts from content block arrays", () => {
		const turn = buildTurnContext([
			entry({ role: "user", content: [text("block form")], timestamp: 0 }),
			entry(assistant([text("ok")])),
		]);
		expect(turn?.recentUserPrompts).toEqual(["block form"]);
	});

	test("collects tool signals and touched files from the current turn only", () => {
		const turn = buildTurnContext([
			entry(user("old turn")),
			entry(assistant([toolCall("read", { path: "old.ts" })])),
			entry(user("new turn")),
			entry(assistant([toolCall("read", { file_path: "src/new.ts" }), toolCall("powershell", { command: "bun test" })])),
		]);

		expect(turn?.touchedFiles).toEqual(["src/new.ts"]);
		expect(turn?.toolSignals).toEqual(["read src/new.ts", "powershell bun test"]);
	});

	test("does not repeat a touched file", () => {
		const turn = buildTurnContext([
			entry(user("go")),
			entry(assistant([toolCall("read", { path: "a.ts" }), toolCall("edit", { path: "a.ts" })])),
		]);
		expect(turn?.touchedFiles).toEqual(["a.ts"]);
	});

	test("caps tool signals and files", () => {
		const turn = buildTurnContext(
			[
				entry(user("go")),
				entry(
					assistant(
						Array.from({ length: 30 }, (_, index) => toolCall("read", { path: `f${index}.ts` })),
					),
				),
			],
			{ ...DEFAULT_TURN_LIMITS, maxToolSignals: 2, maxTouchedFiles: 3 },
		);
		expect(turn?.toolSignals).toHaveLength(2);
		expect(turn?.touchedFiles).toHaveLength(3);
	});

	test("truncates a very long assistant message", () => {
		const turn = buildTurnContext([entry(user("go")), entry(assistant([text("x".repeat(5000))]))], {
			...DEFAULT_TURN_LIMITS,
			latestAssistantChars: 100,
		});
		expect(turn?.latestAssistantText.length).toBeLessThanOrEqual(100);
	});

	test("ignores non-message entries and malformed messages", () => {
		const turn = buildTurnContext([
			{ type: "custom", message: undefined },
			entry(null),
			entry(user("real")),
			entry(assistant([text("done")])),
		]);
		expect(turn?.recentUserPrompts).toEqual(["real"]);
	});
});

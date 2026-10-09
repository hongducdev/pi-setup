import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import promptSuggest from "../index.ts";
import { normalize, strip } from "./editor-harness.ts";

/**
 * Wiring-level tests that reproduce what `interactive-mode.setCustomEditorComponent` does: build the
 * new editor immediately, copy the previous editor's text and padding into it, then focus it.
 *
 * The config file is redirected to a temp agent dir so these tests never touch the real one.
 */

const REAL_EDITOR_PADDING = 2;
let agentDir: string | undefined;
let previousAgentDir: string | undefined;
const createdDirs: string[] = [];

/**
 * Point the agent dir at a fresh temp directory.
 * Every install gets its own, because the extension persists `/suggester on` to the config file -
 * a shared directory would leak settings between tests.
 */
function useFreshAgentDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "prompt-suggest-test-"));
	createdDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

beforeAll(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = useFreshAgentDir();
});

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type EditorLike = {
	focused: boolean;
	setText(text: string): void;
	getText(): string;
	render(width: number): string[];
	setPaddingX?(padding: number): void;
	getAnchorMisses(): number;
};

interface RegistryCall {
	systemPrompt?: string;
	messages?: unknown;
	maxTokens?: number;
}

function createFakePi(options: { reply?: string | (() => Promise<never>); commands?: unknown[] } = {}) {
	const flags: Record<string, unknown> = {};
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const calls: RegistryCall[] = [];

	const pi = {
		flags,
		calls,
		reply: (options.reply ?? "Run the failing test first.") as string | (() => Promise<never>),
		registerFlag(name: string, config: { default?: unknown }) {
			if (config.default !== undefined) flags[name] = config.default;
		},
		getFlag: (name: string) => flags[name],
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, config);
		},
		registerShortcut() {},
		getCommands: () => options.commands ?? [],
		getAllTools: () => [{ name: "read", description: "Read a file", sourceInfo: { source: "builtin" } }],
		getActiveTools: () => ["read"],
		async emit(event: string, ctx: unknown) {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		},
		emitAsync(event: string, ctx: unknown) {
			return Promise.all((handlers.get(event) ?? []).map((handler) => handler({}, ctx)));
		},
		async run(command: string, args: string, ctx: unknown) {
			const entry = commands.get(command);
			if (!entry) throw new Error(`unknown command: ${command}`);
			await entry.handler(args, ctx);
		},
	};

	return pi;
}

function createModelRegistry(pi: ReturnType<typeof createFakePi>) {
	return {
		getAll: () => [{ provider: "test", id: "test-model" }],
		async complete(_model: unknown, context: RegistryCall, options: { maxTokens?: number }) {
			pi.calls.push({ ...context, maxTokens: options?.maxTokens });
			if (typeof pi.reply === "function") return pi.reply();
			return {
				role: "assistant",
				content: [{ type: "text", text: pi.reply }],
				usage: { input: 100, output: 5 },
				stopReason: "stop",
			};
		},
	};
}

function createFakeCtx(pi: ReturnType<typeof createFakePi>, initialEditorText = "", cwd = agentDir ?? process.cwd()) {
	let factory: ((tui: unknown, theme: unknown, kb: unknown) => unknown) | undefined;
	let live: EditorLike | undefined;
	const statuses = new Map<string, string | undefined>();
	const notifications: string[] = [];

	const tui = { terminal: { rows: 24 }, requestRender() {}, setFocus() {} };
	const theme = {
		borderColor: (text: string) => text,
		selectList: {
			selectedPrefix: (t: string) => t,
			selectedText: (t: string) => t,
			description: (t: string) => t,
			scrollInfo: (t: string) => t,
			noMatch: (t: string) => t,
		},
	};
	const keybindings = { matches: () => false };

	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		cwd,
		model: { provider: "test", id: "test-model" },
		modelRegistry: createModelRegistry(pi),
		sessionManager: {
			getSessionFile: () => "session.jsonl",
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "fix the parser", timestamp: 0 } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "I updated the parser." }],
						stopReason: "stop",
					},
				},
			],
		},
		ui: {
			setEditorComponent(next: typeof factory) {
				factory = next;
				if (!next) {
					live = undefined;
					return;
				}
				live = next(tui, theme, keybindings) as EditorLike;
				live.setPaddingX?.(REAL_EDITOR_PADDING);
				live.setText(initialEditorText);
				live.focused = true;
			},
			getEditorComponent: () => factory,
			setEditorText(text: string) {
				live?.setText(text);
			},
			getEditorText: () => live?.getText() ?? "",
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	};

	return {
		ctx,
		statuses,
		notifications,
		getFactory: () => factory,
		getEditor: () => live,
		getText: () => live?.getText() ?? "",
		render(width = 60): string {
			if (!live) return "";
			return live
				.render(width)
				.map((line) => normalize(strip(line)))
				.filter(Boolean)
				.join(" | ");
		},
	};
}

function install(options: Parameters<typeof createFakePi>[0] = {}, initialEditorText = "") {
	// Isolate the persisted config for this test.
	const dir = useFreshAgentDir();
	const pi = createFakePi(options);
	promptSuggest(pi as never);
	return { pi, fake: createFakeCtx(pi, initialEditorText, dir) };
}

describe("extension wiring: opt-in", () => {
	test("registers the flag, defaulting to off", () => {
		const { pi } = install();
		expect(pi.flags["prompt-suggest"]).toBe(false);
	});

	test("installs nothing and stays quiet while off", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.emit("agent_start", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		expect(fake.getFactory()).toBeUndefined();
		expect(pi.calls).toHaveLength(0);
	});

	test("does nothing when the mode has no UI", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", { ...fake.ctx, hasUI: false });
		expect(fake.getFactory()).toBeUndefined();
	});
});

describe("extension wiring: automatic suggestions", () => {
	test("generates and displays a suggestion after a settled turn", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_start", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		expect(pi.calls).toHaveLength(1);
		expect(fake.render()).toContain("Run the failing test first.");
	});

	test("sends a capability-aware prompt that distinguishes relevant skills from the rest", async () => {
		const { pi, fake } = install({
			commands: [
				{ name: "ck:parser", description: "Fix parser bugs in the tokenizer", source: "skill" },
				{ name: "ck:deploy", description: "Deploy to any platform", source: "skill" },
			],
		});
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		const prompt = JSON.stringify(pi.calls[0]?.messages);
		// The parser skill matches the turn text, so it carries its description.
		expect(prompt).toContain("RelevantSkills");
		expect(prompt).toContain("ck:parser — Fix parser bugs in the tokenizer");
		// The unrelated skill stays visible by name so it is never invisible to the model.
		expect(prompt).toMatch(/OtherInstalledSkills: .*ck:deploy/);
	});

	test("caps the caller's output tokens", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);
		expect(pi.calls[0]?.maxTokens).toBe(200);
	});

	test("does not generate when automatic mode is off", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.run("suggester", "auto off", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		expect(pi.calls).toHaveLength(0);
	});

	test("skips generation while the user is typing", async () => {
		const { pi, fake } = install({}, "half-typed prompt");
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		expect(pi.calls).toHaveLength(0);
	});

	test("clears the suggestion when the next turn starts", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);
		expect(fake.render()).toContain("Run the failing test first.");

		await pi.emit("agent_start", fake.ctx);
		expect(fake.render()).not.toContain("Run the failing test first.");
	});

	test("a provider failure never surfaces and leaves no suggestion", async () => {
		const { pi, fake } = install({
			reply: () => Promise.reject(new Error("provider exploded")),
		});
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		expect(fake.render()).not.toContain("Run the failing test");
		expect(fake.statuses.get("prompt-suggest")).toContain("failed");
	});

	test("drops a suggestion whose turn was interrupted by a new one", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { pi, fake } = install({
			reply: async () => {
				await gate;
				return {
					role: "assistant",
					content: [{ type: "text", text: "stale suggestion" }],
					usage: { input: 1, output: 1 },
					stopReason: "stop",
				} as never;
			},
		});
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);

		const pending = pi.emitAsync("agent_settled", fake.ctx);
		// A new turn starts while the model call is still open.
		await pi.emit("agent_start", fake.ctx);
		release?.();
		await pending;

		expect(fake.render()).not.toContain("stale suggestion");
	});

	test("drops an in-flight suggestion when the session is swapped", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { pi, fake } = install({
			reply: async () => {
				await gate;
				return {
					role: "assistant",
					content: [{ type: "text", text: "from the old session" }],
					usage: { input: 1, output: 1 },
					stopReason: "stop",
				} as never;
			},
		});
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);

		const pending = pi.emitAsync("agent_settled", fake.ctx);
		await pi.emit("session_start", fake.ctx);
		release?.();
		await pending;

		expect(fake.render()).not.toContain("from the old session");
	});

	test("does not start a second generation while one is in flight", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { pi, fake } = install({
			reply: async () => {
				await gate;
				return {
					role: "assistant",
					content: [{ type: "text", text: "only once" }],
					usage: { input: 1, output: 1 },
					stopReason: "stop",
				} as never;
			},
		});
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);

		const first = pi.emitAsync("agent_settled", fake.ctx);
		const second = pi.emitAsync("agent_settled", fake.ctx);
		release?.();
		await Promise.all([first, second]);

		expect(pi.calls).toHaveLength(1);
	});

	test("reports the assembled prompt size so the cost is visible", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		// The prompt is assembled before the call, so its size is known even before usage arrives.
		expect(fake.statuses.get("prompt-suggest")).toContain("prompt ~");
	});

	test("tracks usage in the status line", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "on", fake.ctx);
		await pi.emit("agent_settled", fake.ctx);

		expect(fake.statuses.get("prompt-suggest")).toContain("↑100");
	});
});

describe("extension wiring: manual controls", () => {
	test("/suggester demo renders ghost text immediately", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "demo", fake.ctx);

		expect(fake.render()).toContain("bổ sung test");
	});

	test("/suggester demo clears stale editor text so the ghost is visible", async () => {
		const { pi, fake } = install({}, "/suggester demo");
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "demo", fake.ctx);

		expect(fake.getText()).toBe("");
		expect(fake.render()).toContain("bổ sung test");
	});

	test("renders with the real editor padding without losing the caret anchor", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "demo", fake.ctx);

		expect(fake.getEditor()?.getAnchorMisses()).toBe(0);
	});

	test("/suggester off restores the previously installed editor factory", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		const previous = fake.getFactory();

		await pi.run("suggester", "on", fake.ctx);
		await pi.run("suggester", "off", fake.ctx);

		expect(fake.getFactory()).toBe(previous);
	});

	test("persists the opt-in so the next session starts enabled", async () => {
		// Both sessions must share one agent dir for this to be meaningful.
		const dir = useFreshAgentDir();
		const first = createFakePi();
		promptSuggest(first as never);
		const firstCtx = createFakeCtx(first, "", dir);
		await first.emit("session_start", firstCtx.ctx);
		await first.run("suggester", "on", firstCtx.ctx);

		const second = createFakePi();
		promptSuggest(second as never);
		const secondCtx = createFakeCtx(second, "", dir);
		await second.emit("session_start", secondCtx.ctx);

		expect(secondCtx.getFactory()).toBeDefined();
	});

	test("/suggester prompt writes the exact prompt that would be sent", async () => {
		const pi = createFakePi({
			commands: [{ name: "ck:parser", description: "Fix parser bugs in the tokenizer", source: "skill" }],
		});
		promptSuggest(pi as never);
		const dir = useFreshAgentDir();
		const fake = createFakeCtx(pi, "", dir);
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "prompt", fake.ctx);

		const written = await Bun.file(`${dir}/prompt-suggest/last-prompt.txt`).text();
		expect(written).toContain("TurnStatus:");
		expect(written).toContain("ck:parser");
		expect(written).toContain("RelevantSkills");
		// The file holds both halves, labelled, so it can be diffed against the request.
		expect(written).toContain("/* system */");
		expect(written).toContain("/* user */");
		// The notice must warn that the file contains conversation content.
		expect(fake.notifications.join(" ")).toContain("tokens");
		expect(fake.notifications.join(" ")).toContain("recent prompts");
	});

	test("/suggester prompt does not call the model", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "prompt", fake.ctx);
		expect(pi.calls).toHaveLength(0);
	});

	test("status reports enabled state and config path", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "status", fake.ctx)
			.catch(() => {});
		expect(fake.notifications.join(" ")).toContain("prompt-suggest:");
	});

	test("rejects an unknown config key without crashing", async () => {
		const { pi, fake } = install();
		await pi.emit("session_start", fake.ctx);
		await pi.run("suggester", "config nope 1", fake.ctx);
		expect(fake.notifications.join(" ")).toContain("unknown key");
	});
});

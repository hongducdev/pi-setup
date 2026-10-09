import { describe, expect, test } from "bun:test";
import { createEditorHarness } from "./editor-harness.ts";

/**
 * The ghost editor replaces the session editor, so every application keybinding must still
 * reach `CustomEditor`. These are the negative checks that protect the rest of pi's UX.
 */
describe("GhostSuggestionEditor keybinding compatibility", () => {
	test("does not swallow extension-registered shortcuts", () => {
		const harness = createEditorHarness({ suggestion: "hello" });
		let handled = false;
		harness.editor.onExtensionShortcut = () => {
			handled = true;
			return true;
		};

		harness.editor.handleInput("\x1b[15~");

		expect(handled).toBe(true);
	});

	test("still dispatches the interrupt action while a ghost is visible", () => {
		const harness = createEditorHarness({
			suggestion: "hello",
			match: (data, action) => action === "app.interrupt" && data === "\x1b",
		});
		let interrupted = false;
		harness.editor.onAction("app.interrupt", () => {
			interrupted = true;
		});

		expect(harness.editor.hasGhost()).toBe(true);
		harness.editor.handleInput("\x1b");

		expect(interrupted).toBe(true);
		// The ghost must also yield to the key rather than reappearing immediately.
		expect(harness.editor.hasGhost()).toBe(false);
	});

	test("still dispatches exit (ctrl+d) on an empty editor while a ghost is visible", () => {
		const harness = createEditorHarness({
			suggestion: "hello",
			match: (data, action) => action === "app.exit" && data === "\x04",
		});
		let exited = false;
		harness.editor.onAction("app.exit", () => {
			exited = true;
		});

		harness.editor.handleInput("\x04");

		expect(exited).toBe(true);
	});

	test("still recalls prompt history with the history keybinding", () => {
		const harness = createEditorHarness({
			match: (data, action) => action === "tui.editor.historyPrevious" && data === "\x1b[A",
		});
		harness.editor.addToHistory("previous prompt");

		harness.editor.handleInput("\x1b[A");

		expect(harness.editor.getText()).toBe("previous prompt");
	});

	test("accepting a ghost does not forward the key to the application", () => {
		const harness = createEditorHarness({
			suggestion: "hello",
			// Space is also bound to an app action here; accepting must win.
			match: (_data, action) => action === "app.something",
		});
		let appActionRan = false;
		harness.editor.onAction("app.something" as never, () => {
			appActionRan = true;
		});

		harness.editor.handleInput(" ");

		expect(harness.editor.getText()).toBe("hello");
		expect(appActionRan).toBe(false);
	});

	test("ordinary typing still reaches the editor", () => {
		const harness = createEditorHarness({ suggestion: "hello" });
		harness.editor.handleInput("a");
		harness.editor.handleInput("b");
		expect(harness.editor.getText()).toBe("ab");
	});

	test("the editor remains usable after accepting a suggestion", () => {
		const harness = createEditorHarness({ suggestion: "hello" });
		harness.editor.handleInput(" ");
		harness.editor.handleInput("!");
		expect(harness.editor.getText()).toBe("hello!");
	});
});

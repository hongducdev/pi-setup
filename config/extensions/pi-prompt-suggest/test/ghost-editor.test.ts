import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { injectGhostIntoLine, renderGhostContinuationLine } from "../editor/ghost-editor.ts";
import { NARROW, createEditorHarness, normalize, strip } from "./editor-harness.ts";

describe("injectGhostIntoLine", () => {
	test("returns undefined when the cursor marker is absent", () => {
		expect(injectGhostIntoLine("plain line", "ghost", NARROW)).toBeUndefined();
	});

	test("inserts ghost text after the fake cursor", () => {
		const line = `> ${CURSOR_MARKER}\x1b[7m \x1b[0m`;
		const result = injectGhostIntoLine(line, "ghost", NARROW);
		expect(result).toBeDefined();
		expect(normalize(result!.line)).toBe("> ghost");
	});

	test("keeps the cursor marker before the ghost text", () => {
		const line = `> ${CURSOR_MARKER}\x1b[7m \x1b[0m`;
		const result = injectGhostIntoLine(line, "ghost", NARROW);
		expect(result!.line.indexOf(CURSOR_MARKER)).toBeLessThan(result!.line.indexOf("ghost"));
	});

	test("reports the ghost start column", () => {
		const line = `> ab${CURSOR_MARKER}\x1b[7m \x1b[0m`;
		const result = injectGhostIntoLine(line, "cd", NARROW);
		expect(result?.ghostCol).toBe(5);
	});

	test("does not widen the line past the available width", () => {
		const line = `> ${CURSOR_MARKER}\x1b[7m \x1b[0m`;
		const result = injectGhostIntoLine(line, "x".repeat(200), 20);
		expect(strip(result!.line).length).toBeLessThanOrEqual(20);
	});
});

describe("renderGhostContinuationLine", () => {
	test("indents to the ghost column and fills the width", () => {
		const line = renderGhostContinuationLine("tail", 4, 20);
		expect(strip(line)).toBe(`${" ".repeat(4)}tail${" ".repeat(12)}`);
	});
});

describe("GhostSuggestionEditor rendering", () => {
	test("renders the suggestion as ghost text on an empty editor", () => {
		const harness = createEditorHarness({ suggestion: "hello world" });
		expect(harness.renderedLines().length).toBeGreaterThanOrEqual(3);
		expect(harness.renderedText()).toContain("hello world");
	});

	test("renders only the missing suffix when the editor holds a prefix", () => {
		const harness = createEditorHarness({ suggestion: "hello world", text: "hello" });
		expect(harness.renderedText()).toContain("hello world");
	});

	test("renders nothing when the editor text is not a prefix of the suggestion", () => {
		const harness = createEditorHarness({ suggestion: "hello world", text: "goodbye" });
		expect(harness.renderedText()).not.toContain("hello world");
	});

	test("renders nothing when the editor is not focused", () => {
		const harness = createEditorHarness({ suggestion: "hello world", focused: false });
		expect(harness.renderedText()).not.toContain("hello world");
	});

	test("renders nothing without a suggestion", () => {
		const harness = createEditorHarness({});
		expect(harness.editor.hasGhost()).toBe(false);
		// Only the editor's own borders remain.
		expect(harness.renderedLines()[1]?.trim() ?? "").toBe("");
	});

	test("renders a multi-line suggestion from an empty editor", () => {
		const harness = createEditorHarness({ suggestion: "first line\nsecond line" });
		expect(harness.renderedText()).toContain("first line");
		expect(harness.renderedText()).toContain("second line");
	});

	test("hides the suggestion rather than relocating it when the caret has no inline room", () => {
		// A long typed prefix pushes the caret to the right edge of a 40-column editor.
		const longPrefix = "a".repeat(35);
		const harness = createEditorHarness({ suggestion: `${longPrefix} tail text` });
		harness.editor.setText(longPrefix);

		// Nothing is drawn, and in particular the suggestion is not moved to another line.
		expect(harness.renderedText()).not.toContain("tail text");
	});

	test("withholds a multi-line suggestion once the editor has text", () => {
		const harness = createEditorHarness({ suggestion: "first line\nsecond line", text: "fir" });
		expect(harness.editor.hasGhost()).toBe(false);
	});

	test("trims surrounding whitespace from a suggestion", () => {
		const harness = createEditorHarness({ suggestion: "  padded  " });
		expect(harness.renderedText()).toContain("padded");
		expect(harness.renderedText()).not.toContain("  padded");
	});

	test("renders nothing for a whitespace-only suggestion", () => {
		const harness = createEditorHarness({ suggestion: "   " });
		expect(harness.editor.hasGhost()).toBe(false);
	});
});

describe("GhostSuggestionEditor acceptance", () => {
	test("accepts the suggestion with Space on an empty editor", () => {
		const harness = createEditorHarness({ suggestion: "hello world" });
		harness.editor.handleInput(" ");
		expect(harness.editor.getText()).toBe("hello world");
	});

	test("does not accept with Space when only Right is configured", () => {
		const harness = createEditorHarness({ suggestion: "hello world", acceptKeys: ["right"] });
		harness.editor.handleInput(" ");
		expect(harness.editor.getText()).not.toBe("hello world");
	});

	test("accepts the suggestion with Right when configured", () => {
		const harness = createEditorHarness({ suggestion: "hello world", acceptKeys: ["right"] });
		harness.editor.handleInput("\x1b[C");
		expect(harness.editor.getText()).toBe("hello world");
	});

	test("Space stays a literal space once a prefix is typed", () => {
		const harness = createEditorHarness({ suggestion: "hello world", text: "hello" });
		harness.editor.handleInput(" ");
		// A text-producing key must never silently accept over what the user is typing.
		expect(harness.editor.getText()).toBe("hello ");
	});

	test("Right still accepts a typed prefix", () => {
		const harness = createEditorHarness({ suggestion: "hello world", text: "hello", acceptKeys: ["right"] });
		harness.editor.handleInput("\x1b[C");
		expect(harness.editor.getText()).toBe("hello world");
	});

	test("Right completes a prefix even when Space is also an accept key", () => {
		const harness = createEditorHarness({ suggestion: "hello world", text: "hello", acceptKeys: ["space", "right"] });
		harness.editor.handleInput("\x1b[C");
		expect(harness.editor.getText()).toBe("hello world");
	});

	test("does not accept when the editor already holds unrelated text", () => {
		const harness = createEditorHarness({ suggestion: "hello world", text: "goodbye", acceptKeys: ["space", "right"] });
		harness.editor.handleInput("\x1b[C");
		expect(harness.editor.getText()).toBe("goodbye");
	});
});

describe("GhostSuggestionEditor suppression", () => {
	test("typing hides the ghost and clearing the editor restores it", () => {
		const harness = createEditorHarness({ suggestion: "hello world" });
		harness.editor.handleInput("z");
		expect(harness.editor.hasGhost()).toBe(false);

		harness.editor.handleInput("\x7f");
		expect(harness.editor.getText()).toBe("");
		expect(harness.editor.hasGhost()).toBe(true);
	});

	test("a non-accept key on an empty editor hides the ghost until a new suggestion arrives", () => {
		const harness = createEditorHarness({ suggestion: "first suggestion" });
		expect(harness.editor.hasGhost()).toBe(true);

		// Left arrow leaves the editor empty but dismisses the ghost.
		harness.editor.handleInput("\x1b[D");
		expect(harness.editor.getText()).toBe("");
		expect(harness.editor.hasGhost()).toBe(false);

		harness.setSuggestion("second suggestion");
		harness.bumpRevision();
		expect(harness.editor.hasGhost()).toBe(true);
	});

	test("typing hides the ghost even while the text is still a prefix", () => {
		const harness = createEditorHarness({ suggestion: "hello world" });
		// A keypress is treated as the user taking over, so the ghost yields immediately.
		harness.editor.handleInput("h");
		expect(harness.editor.getText()).toBe("h");
		expect(harness.editor.hasGhost()).toBe(false);

		// It comes back once the editor is empty again.
		harness.editor.handleInput("\x7f");
		expect(harness.editor.hasGhost()).toBe(true);
	});

	test("a suggestion that no longer matches the typed text is withheld", () => {
		const harness = createEditorHarness({ suggestion: "hello world", text: "hx" });
		expect(harness.editor.hasGhost()).toBe(false);
	});

	test("a suggestion arriving after typing shows for the matching prefix", () => {
		// Mirrors a suggestion produced mid-typing: the text is already there when it lands.
		const harness = createEditorHarness({ suggestion: "hello world", text: "hello" });
		expect(harness.editor.hasGhost()).toBe(true);
		expect(harness.renderedText()).toContain("hello world");
	});

	test("a new suggestion replaces a visible one", () => {
		const harness = createEditorHarness({ suggestion: "first suggestion" });
		harness.setSuggestion("second suggestion");
		harness.bumpRevision();

		expect(harness.renderedText()).toContain("second suggestion");
		expect(harness.renderedText()).not.toContain("first suggestion");
	});
});

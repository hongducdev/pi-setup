import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { findGhostAnchor } from "../editor/ghost-editor.ts";
import { createEditorHarness, strip } from "./editor-harness.ts";

/**
 * The render override must not disturb what `Editor.render()` produced.
 *
 * These assertions compare against a baseline render with no suggestion, so an off-by-one in the
 * line splicing shows up as a moved border or a missing content line rather than passing silently.
 */
describe("GhostSuggestionEditor render invariants", () => {
	const WIDTHS = [1, 5, 12, 20, 40, 80];

	for (const width of WIDTHS) {
		test(`preserves the border layout at width ${width}`, () => {
			const baseline = createEditorHarness({}).editor.render(width);
			const withGhost = createEditorHarness({ suggestion: "a suggestion that will be quite long indeed\nand wraps" })
				.editor.render(width);

			expect(withGhost[0]).toBe(baseline[0]);
			expect(withGhost[withGhost.length - 1]).toBe(baseline[baseline.length - 1]);
		});

		test(`never exceeds the available width at width ${width}`, () => {
			const lines = createEditorHarness({ suggestion: "a fairly long suggestion that wraps around" })
				.editor.render(width);
			for (const line of lines) {
				// Measure with pi's own width function; the hardware cursor marker is zero-width.
				expect(widthOf(line)).toBeLessThanOrEqual(width);
			}
		});
	}

	test("adds only trailing ghost lines, keeping the content line first", () => {
		const baseline = createEditorHarness({}).editor.render(40);
		const withGhost = createEditorHarness({ suggestion: "line one\nline two" }).editor.render(40);

		expect(withGhost.length).toBeGreaterThan(baseline.length);
		// Content stays on the same index; extra lines are inserted before the bottom border.
		expect(withGhost[0]).toBe(baseline[0]);
	});

	test("leaves the layout untouched when there is not enough inline room", () => {
		// 35 columns of prefix leaves fewer than MIN_INLINE_GHOST_WIDTH columns before the edge.
		const prefix = "a".repeat(35);
		const baseline = createEditorHarness({ text: prefix }).editor.render(40);
		const harness = createEditorHarness({ suggestion: `${prefix} tail text` });
		harness.editor.setText(prefix);

		const withGhost = harness.editor.render(40);
		// No ghost is drawn, but the editor must look exactly as it did before.
		expect(withGhost.length).toBe(baseline.length);
		expect(withGhost[0]).toBe(baseline[0]);
		expect(withGhost[withGhost.length - 1]).toBe(baseline[baseline.length - 1]);
	});

	test("renders correctly with CJK text and emoji", () => {
		const harness = createEditorHarness({ suggestion: "Kiểm tra lại phần này 🚀 và thêm test" });
		const lines = harness.editor.render(40);
		for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(40);
		expect(lines.map(strip).join(" ")).toContain("🚀");
	});
});

describe("findGhostAnchor", () => {
	test("finds the insertion point after a one-column cursor", () => {
		const anchor = findGhostAnchor(`> ab${CURSOR_MARKER}\x1b[7m \x1b[0m`);
		expect(anchor?.ghostCol).toBe(5);
	});

	test("rejects a cursor that is not exactly one column wide", () => {
		// Guards against pi changing the cursor rendering: fail closed instead of mis-rendering.
		expect(findGhostAnchor(`> ${CURSOR_MARKER}\x1b[7m  \x1b[0m`)).toBeUndefined();
	});

	test("rejects a line with no cursor marker", () => {
		expect(findGhostAnchor("> plain")).toBeUndefined();
	});

	test("rejects a line with a marker but no cursor block", () => {
		expect(findGhostAnchor(`> ${CURSOR_MARKER}`)).toBeUndefined();
	});
});

/** Strip styling and the zero-width hardware cursor marker, then measure like the TUI does. */
function widthOf(line: string): number {
	return visibleWidth(line.split(CURSOR_MARKER).join(""));
}

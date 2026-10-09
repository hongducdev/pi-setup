import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { matchesGhostAcceptKey, normalizeGhostAcceptKeys, type GhostAcceptKey } from "./accept-keys.ts";

const GHOST_COLOR = "\x1b[38;5;244m";
const RESET = "\x1b[0m";
/** ANSI introducer of the editor's fake cursor block (`\x1b[7m<grapheme>\x1b[0m`). */
const CURSOR_OPEN = "\x1b[7m";
/**
 * Below this much room after the caret, an inline ghost is not drawn at all.
 *
 * Deliberately no fallback layout: rendering the suggestion somewhere else in the editor would
 * mean splicing lines into `Editor.render()`'s output, and a mistake there corrupts the editor's
 * borders. Showing nothing is the safe degradation.
 */
export const MIN_INLINE_GHOST_WIDTH = 12;

export interface GhostInjection {
	/** The line with the first ghost segment inserted after the cursor. */
	line: string;
	/** Remaining wrapped segments of the first ghost line. */
	continuation: string[];
	/** Visible column where the ghost text starts (used to align continuation lines). */
	ghostCol: number;
}

export interface GhostAnchor {
	/** Index in the rendered line immediately after the fake cursor block. */
	insertAt: number;
	/** Visible column where ghost text starts. */
	ghostCol: number;
}

/**
 * Locate where ghost text may be inserted on a rendered editor line.
 *
 * `Editor.render()` emits `CURSOR_MARKER` only while the editor is focused, followed by a
 * highlighted cursor block. No anchor means there is no caret to render against, so the ghost is
 * skipped entirely rather than moved to another surface.
 *
 * COUPLING: this depends on two internals of `Editor.render()` - the `CURSOR_MARKER` constant and
 * the reverse-video cursor block. If pi changes either, `findGhostAnchor` returns undefined and
 * the ghost silently stops rendering. `GhostSuggestionEditor.getAnchorMisses()` exists so the
 * wiring can surface that drift instead of failing invisibly.
 */
export function findGhostAnchor(line: string): GhostAnchor | undefined {
	const markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex < 0) return undefined;

	const cursorStart = line.indexOf(CURSOR_OPEN, markerIndex);
	if (cursorStart < 0) return undefined;
	const cursorEnd = line.indexOf(RESET, cursorStart + CURSOR_OPEN.length);
	if (cursorEnd < 0) return undefined;

	// The cursor must still be a single column wide, otherwise the insertion column is unknown.
	if (visibleWidth(line.slice(cursorStart + CURSOR_OPEN.length, cursorEnd)) !== 1) return undefined;

	const insertAt = cursorEnd + RESET.length;
	return { insertAt, ghostCol: visibleWidth(line.slice(0, insertAt)) };
}

/**
 * Insert ghost text immediately after the editor's fake cursor on one rendered line.
 *
 * Returns undefined when there is no anchor, or when fewer than `minInlineWidth` columns remain -
 * the caller then renders the suggestion as a block instead of one character per line.
 */
export function injectGhostIntoLine(
	line: string,
	ghostText: string,
	width: number,
	minInlineWidth: number = MIN_INLINE_GHOST_WIDTH,
): GhostInjection | undefined {
	const anchor = findGhostAnchor(line);
	if (!anchor) return undefined;

	const available = width - anchor.ghostCol;
	if (available < minInlineWidth) return undefined;

	const wrapped = wrapTextWithAnsi(ghostText, available);
	const first = wrapped[0] ?? "";

	return {
		line: truncateToWidth(
			line.slice(0, anchor.insertAt) + GHOST_COLOR + first + RESET + line.slice(anchor.insertAt),
			width,
			"",
		),
		continuation: wrapped.slice(1),
		ghostCol: anchor.ghostCol,
	};
}

/** Render one continuation line of a multi-line ghost, indented to the ghost column. */
export function renderGhostContinuationLine(text: string, col: number, width: number): string {
	const available = Math.max(0, width - col);
	const body = truncateToWidth(text, available, "");
	const used = col + visibleWidth(body);
	const padding = " ".repeat(Math.max(0, width - used));
	return truncateToWidth(`${" ".repeat(col)}${GHOST_COLOR}${body}${RESET}${padding}`, width, "");
}

interface GhostState {
	text: string;
	suggestion: string;
	suffixLines: string[];
}

/**
 * Editor that renders a next-prompt suggestion as ghost text after the caret.
 *
 * Extends `CustomEditor` so application keybindings (escape, ctrl+d, model switching,
 * autocomplete, history) keep working; only keys we own are intercepted.
 */
export class GhostSuggestionEditor extends CustomEditor {
	private suppressGhost = false;
	private suppressArmedByNonEmptyText = false;
	private lastSuggestion: string | undefined;
	private lastRevision = -1;
	private anchorMisses = 0;

	public constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getSuggestion: () => string | undefined,
		private readonly getRevision: () => number,
		private readonly ghostAcceptKeys: readonly GhostAcceptKey[],
	) {
		super(tui, theme, keybindings);
	}

	public override handleInput(data: string): void {
		const ghost = this.getGhostState();

		if (ghost) {
			if (this.shouldAcceptGhost(data, ghost.text)) {
				this.setText(ghost.suggestion);
				return;
			}

			// A non-accept key on an empty editor dismisses the ghost until a new suggestion arrives.
			// With a prefix already typed the ghost stays visible so an explicit accept key still works.
			if (ghost.text.length === 0) {
				this.suppressGhost = true;
				this.suppressArmedByNonEmptyText = false;
				super.handleInput(data);
				this.updateGhostSuppressionLifecycle();
				return;
			}
		}

		super.handleInput(data);
		this.updateGhostSuppressionLifecycle();
	}

	/**
	 * Decide whether a key accepts the suggestion.
	 *
	 * A key that produces text (Space) may only accept while the editor is empty - otherwise the
	 * accept would silently replace what the user meant to type. A key that does not produce text
	 * (Right arrow) may accept whenever the buffer is still a prefix of the suggestion.
	 */
	private shouldAcceptGhost(data: string, text: string): boolean {
		return normalizeGhostAcceptKeys(this.ghostAcceptKeys).some((key) => {
			if (!matchesGhostAcceptKey(data, [key])) return false;
			return key === "space" ? text.length === 0 : true;
		});
	}

	/** Number of renders where a suggestion was active but the caret could not be located. */
	public getAnchorMisses(): number {
		return this.anchorMisses;
	}

	public override setText(text: string): void {
		super.setText(text);
		this.updateGhostSuppressionLifecycle();
	}

	/** Whether a ghost suggestion is currently renderable. */
	public hasGhost(): boolean {
		return this.getGhostState() !== undefined;
	}

	public override render(width: number): string[] {
		const lines = super.render(width);
		const ghost = this.getGhostState();
		if (!ghost) return lines;
		if (lines.length < 3) return lines;

		const contentIndex = 1;
		const contentLine = lines[contentIndex];
		if (!contentLine) return lines;

		const injection = injectGhostIntoLine(contentLine, ghost.suffixLines[0] ?? "", width);
		if (!injection) {
			// No caret to anchor to, or no inline room left: show nothing rather than relocate the ghost.
			if (!findGhostAnchor(contentLine)) this.anchorMisses += 1;
			return lines;
		}

		lines[contentIndex] = injection.line;

		const continuation: string[] = [...injection.continuation];
		for (let index = 1; index < ghost.suffixLines.length; index += 1) {
			continuation.push(...wrapTextWithAnsi(ghost.suffixLines[index] ?? "", Math.max(1, width - injection.ghostCol)));
		}
		if (continuation.length === 0) return lines;

		let bottom = lines.length - 1;
		for (let index = 0; index < continuation.length; index += 1) {
			const ghostLine = renderGhostContinuationLine(continuation[index] ?? "", injection.ghostCol, width);
			const target = contentIndex + 1 + index;
			if (target < bottom) {
				lines[target] = ghostLine;
			} else {
				lines.splice(bottom, 0, ghostLine);
				bottom += 1;
			}
		}

		return lines;
	}

	/**
	 * Ghost stays hidden after the user starts typing, and becomes eligible again once the
	 * editor returns to empty - or as soon as a new suggestion arrives.
	 */
	private updateGhostSuppressionLifecycle(): void {
		if (!this.suppressGhost) return;
		if (this.getText().length > 0) {
			this.suppressArmedByNonEmptyText = true;
			return;
		}
		if (this.suppressArmedByNonEmptyText) {
			this.suppressGhost = false;
			this.suppressArmedByNonEmptyText = false;
		}
	}

	private getGhostState(): GhostState | undefined {
		const revision = this.getRevision();
		const suggestion = this.getSuggestion()?.trim();

		// A new suggestion always re-enables ghost rendering.
		if (revision !== this.lastRevision || suggestion !== this.lastSuggestion) {
			this.lastRevision = revision;
			this.lastSuggestion = suggestion;
			this.suppressGhost = false;
			this.suppressArmedByNonEmptyText = false;
		}

		if (!suggestion || this.suppressGhost) return undefined;

		const text = this.getText();
		const cursor = this.getCursor();

		// Ghost renders only for an empty or single-line prefix at the caret with nothing after it.
		if (text.includes("\n")) return undefined;
		if (cursor.line !== 0 || cursor.col !== text.length) return undefined;
		if (!suggestion.startsWith(text)) return undefined;

		const suffix = suggestion.slice(text.length);
		if (!suffix) return undefined;

		const suffixLines = suffix.split("\n");
		// A multi-line ghost needs the whole editor line, so only offer it from an empty editor.
		if (suffixLines.length > 1 && text.length > 0) return undefined;

		return { text, suggestion, suffixLines };
	}
}

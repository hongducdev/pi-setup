import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { GhostSuggestionEditor } from "../editor/ghost-editor.ts";
import type { GhostAcceptKey } from "../editor/accept-keys.ts";

export const ANSI = /\x1b\[[0-9;]*m/g;
export const NARROW = 40;

export function strip(text: string): string {
	return text.replace(ANSI, "").replace(CURSOR_MARKER, "");
}

export function normalize(text: string): string {
	return strip(text).replace(/\s+/g, " ").trim();
}

export type KeybindingMatch = (data: string, action: string) => boolean;

export interface HarnessOptions {
	suggestion?: string | undefined;
	revision?: number | undefined;
	acceptKeys?: Array<GhostAcceptKey> | undefined;
	text?: string | undefined;
	/** Keybinding double. Defaults to matching nothing, like the real editor with no bindings hit. */
	match?: KeybindingMatch | undefined;
	/** Whether the editor reports focus. `CURSOR_MARKER` is only emitted while focused. */
	focused?: boolean | undefined;
}

export interface Harness {
	editor: GhostSuggestionEditor;
	/** Replace the suggestion the editor reads on its next render/input. */
	setSuggestion(next: string | undefined): void;
	/** Bump the revision, which is how the wiring signals "this is a new suggestion". */
	bumpRevision(): void;
	renderedLines(): string[];
	renderedText(): string;
}

/**
 * Build a `GhostSuggestionEditor` against minimal TUI/theme/keybindings doubles.
 *
 * `Editor.render()` needs very little from the TUI in practice, which lets the full render path
 * (including `CURSOR_MARKER` emission) be asserted headlessly instead of only by eye in a terminal.
 */
export function createEditorHarness(options: HarnessOptions = {}): Harness {
	let suggestion = options.suggestion;
	let revision = options.revision ?? 1;

	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		borderColor: (text: string) => text,
		selectList: {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
		},
	};
	const keybindings = { matches: options.match ?? (() => false) };

	const editor = new GhostSuggestionEditor(
		tui as never,
		theme as never,
		keybindings as never,
		() => suggestion,
		() => revision,
		options.acceptKeys ?? ["space"],
	);
	editor.focused = options.focused ?? true;
	if (options.text !== undefined) editor.setText(options.text);

	return {
		editor,
		setSuggestion: (next) => {
			suggestion = next;
		},
		bumpRevision: () => {
			revision += 1;
		},
		renderedLines: () => editor.render(NARROW).map(strip),
		renderedText: () => editor.render(NARROW).map(normalize).join(" | "),
	};
}

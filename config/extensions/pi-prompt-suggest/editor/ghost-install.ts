import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Editor factory as the UI context exposes it.
 *
 * `EditorFactory` is declared in pi's internal extension types but not re-exported from the package
 * index, so it is derived from the API that consumes it instead of imported by name.
 */
export type EditorComponentFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Install state for the custom editor, used to detect when a re-install is required. */
export interface GhostInstallState {
	context: object;
	sessionFile: string | null;
	/** Editor factory that was installed before us, restored on uninstall. */
	previous: EditorComponentFactory | undefined;
}

export interface GhostSyncInput {
	state: GhostInstallState | undefined;
	context: object;
	sessionFile: string | null;
	enabled: boolean;
}

/**
 * Decide whether the ghost editor must be installed, uninstalled, or left alone.
 *
 * `setEditorComponent` replaces the session's editor, so re-installing on every event would
 * discard in-progress editor state. Install only on first use or when the session changes.
 */
export function getGhostSyncAction(input: GhostSyncInput): "install" | "uninstall" | "noop" {
	const { state, context, sessionFile, enabled } = input;
	if (!enabled) {
		return state ? "uninstall" : "noop";
	}
	if (state?.context === context && state.sessionFile === sessionFile) {
		return "noop";
	}
	return "install";
}

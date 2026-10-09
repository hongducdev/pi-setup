import { describe, expect, test } from "bun:test";
import { getGhostSyncAction } from "../editor/ghost-install.ts";

const base = { context: {}, sessionFile: "s1", enabled: true };

describe("getGhostSyncAction", () => {
	test("installs on first use", () => {
		expect(getGhostSyncAction({ ...base, state: undefined })).toBe("install");
	});

	test("does nothing when the same context and session are already installed", () => {
		const context = {};
		const installed = { context, sessionFile: "s1", previous: undefined };
		expect(getGhostSyncAction({ ...base, context, state: installed })).toBe("noop");
	});

	test("re-installs when the session file changes", () => {
		const context = {};
		const state = { context, sessionFile: "old", previous: undefined };
		expect(getGhostSyncAction({ ...base, context, state })).toBe("install");
	});

	test("re-installs when the context object is replaced (session swap)", () => {
		const state = { context: {}, sessionFile: "s1", previous: undefined };
		expect(getGhostSyncAction({ ...base, context: {}, state })).toBe("install");
	});

	test("uninstalls when disabled while installed", () => {
		const context = {};
		const state = { context, sessionFile: "s1", previous: undefined };
		expect(getGhostSyncAction({ ...base, context, state, enabled: false })).toBe("uninstall");
	});

	test("does nothing when disabled and not installed", () => {
		expect(getGhostSyncAction({ ...base, state: undefined, enabled: false })).toBe("noop");
	});

	test("defaults to off so a fresh session is untouched", () => {
		// The extension ships disabled; nothing should be installed until it is opted into.
		expect(getGhostSyncAction({ ...base, state: undefined, enabled: false })).toBe("noop");
	});
});

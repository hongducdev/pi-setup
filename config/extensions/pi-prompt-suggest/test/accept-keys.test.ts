import { describe, expect, test } from "bun:test";
import {
	DEFAULT_GHOST_ACCEPT_KEYS,
	formatGhostAcceptKeys,
	isGhostAcceptKey,
	matchesGhostAcceptKey,
	normalizeGhostAcceptKeys,
} from "../editor/accept-keys.ts";

describe("normalizeGhostAcceptKeys", () => {
	test("defaults when undefined", () => {
		expect(normalizeGhostAcceptKeys(undefined)).toEqual([...DEFAULT_GHOST_ACCEPT_KEYS]);
	});

	test("defaults when empty", () => {
		expect(normalizeGhostAcceptKeys([])).toEqual(["space"]);
	});

	test("drops unknown entries", () => {
		expect(normalizeGhostAcceptKeys(["space", "tab" as never])).toEqual(["space"]);
	});

	test("de-duplicates", () => {
		expect(normalizeGhostAcceptKeys(["right", "right", "space"])).toEqual(["right", "space"]);
	});

	test("falls back to default when nothing valid remains", () => {
		expect(normalizeGhostAcceptKeys(["enter" as never])).toEqual(["space"]);
	});
});

describe("matchesGhostAcceptKey", () => {
	test("matches space by default", () => {
		expect(matchesGhostAcceptKey(" ", undefined)).toBe(true);
	});

	test("does not match right by default", () => {
		expect(matchesGhostAcceptKey("\x1b[C", undefined)).toBe(false);
	});

	test("matches right when configured", () => {
		expect(matchesGhostAcceptKey("\x1b[C", ["right"])).toBe(true);
	});

	test("matches space when configured alongside right", () => {
		expect(matchesGhostAcceptKey(" ", ["right", "space"])).toBe(true);
	});

	test("does not match ordinary characters", () => {
		expect(matchesGhostAcceptKey("a", ["space", "right"])).toBe(false);
	});
});

describe("formatGhostAcceptKeys", () => {
	test("formats defaults", () => {
		expect(formatGhostAcceptKeys(undefined)).toBe("Space");
	});

	test("formats both keys", () => {
		expect(formatGhostAcceptKeys(["right", "space"])).toBe("Right/Space");
	});
});

describe("isGhostAcceptKey", () => {
	test("accepts known keys only", () => {
		expect(isGhostAcceptKey("space")).toBe(true);
		expect(isGhostAcceptKey("right")).toBe(true);
		expect(isGhostAcceptKey("tab")).toBe(false);
		expect(isGhostAcceptKey(undefined)).toBe(false);
	});
});

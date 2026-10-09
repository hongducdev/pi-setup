import { describe, expect, test } from "bun:test";
import { applyConfigUpdate, DEFAULT_CONFIG, normalizeConfig } from "../config.ts";

describe("normalizeConfig", () => {
	test("returns defaults for non-object input", () => {
		expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig("nonsense")).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig([])).toEqual(DEFAULT_CONFIG);
	});

	test("defaults enabled to false so nothing runs unasked", () => {
		expect(normalizeConfig({}).enabled).toBe(false);
	});

	test("reads a partial file and fills the rest", () => {
		const config = normalizeConfig({ auto: false, maxSuggestionChars: 80 });
		expect(config.auto).toBe(false);
		expect(config.maxSuggestionChars).toBe(80);
		expect(config.maxOutputTokens).toBe(DEFAULT_CONFIG.maxOutputTokens);
		expect(config.capabilities).toEqual(DEFAULT_CONFIG.capabilities);
	});

	test("drops unknown keys", () => {
		const config = normalizeConfig({ somethingElse: true }) as unknown as Record<string, unknown>;
		expect(config.somethingElse).toBeUndefined();
	});

	test("ignores a value of the wrong type instead of throwing", () => {
		const config = normalizeConfig({ auto: "yes", maxSuggestionChars: "big", model: 42 });
		expect(config.auto).toBe(DEFAULT_CONFIG.auto);
		expect(config.maxSuggestionChars).toBe(DEFAULT_CONFIG.maxSuggestionChars);
		expect(config.model).toBe(DEFAULT_CONFIG.model);
	});

	test("clamps numeric values into range", () => {
		const config = normalizeConfig({ maxSuggestionChars: 99999, maxOutputTokens: 0 });
		expect(config.maxSuggestionChars).toBe(2000);
		expect(config.maxOutputTokens).toBe(32);
	});

	test("never accepts an empty model or token", () => {
		const config = normalizeConfig({ model: "", noSuggestionToken: "" });
		expect(config.model).toBe(DEFAULT_CONFIG.model);
		expect(config.noSuggestionToken).toBe(DEFAULT_CONFIG.noSuggestionToken);
	});

	test("normalizes nested sections independently", () => {
		const config = normalizeConfig({ capabilities: { maxPerCategory: 3 }, turn: "broken" });
		expect(config.capabilities.maxPerCategory).toBe(3);
		expect(config.capabilities.maxDescriptionChars).toBe(DEFAULT_CONFIG.capabilities.maxDescriptionChars);
		expect(config.turn).toEqual(DEFAULT_CONFIG.turn);
	});
});

describe("applyConfigUpdate", () => {
	test("toggles enabled and auto", () => {
		expect(applyConfigUpdate(DEFAULT_CONFIG, "enabled", "true").config.enabled).toBe(true);
		expect(applyConfigUpdate(DEFAULT_CONFIG, "auto", "off").config.auto).toBe(false);
	});

	test("sets the model", () => {
		expect(applyConfigUpdate(DEFAULT_CONFIG, "model", "anthropic/claude").config.model).toBe("anthropic/claude");
	});

	test("rejects an empty model", () => {
		expect(applyConfigUpdate(DEFAULT_CONFIG, "model", "  ").error).toBeDefined();
	});

	test("rejects a non-numeric number", () => {
		expect(applyConfigUpdate(DEFAULT_CONFIG, "maxSuggestionChars", "lots").error).toBeDefined();
	});

	test("updates a nested capability limit", () => {
		expect(applyConfigUpdate(DEFAULT_CONFIG, "maxPerCategory", "5").config.capabilities.maxPerCategory).toBe(5);
	});

	test("reports an unknown key", () => {
		expect(applyConfigUpdate(DEFAULT_CONFIG, "nope", "1").error).toContain("unknown key");
	});

	test("never mutates the input config", () => {
		const before = JSON.stringify(DEFAULT_CONFIG);
		applyConfigUpdate(DEFAULT_CONFIG, "enabled", "true");
		expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before);
	});
});

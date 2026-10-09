import { describe, expect, test } from "bun:test";
import {
	collectCapabilities,
	DEFAULT_CAPABILITY_LIMITS,
	isEmptyCapabilities,
	rankItems,
	renderCapabilities,
	selectCapabilities,
	truncate,
} from "../app/capabilities.ts";

function source(overrides: Partial<Parameters<typeof collectCapabilities>[0]> = {}) {
	return {
		getCommands: () => [
			{ name: "ck:plan", description: "Plan implementations and design architectures", source: "skill" },
			{ name: "ck:debug", description: "Debug systematically with root cause analysis", source: "skill" },
			{ name: "review", description: "Review staged git changes", source: "prompt" },
			{ name: "plugins", description: "Open the plugin manager", source: "extension" },
			{ name: "suggester", description: "our own command", source: "extension" },
		],
		getAllTools: () => [
			{ name: "read", description: "Read a file", sourceInfo: { source: "builtin" } },
			{ name: "lens_diagnostics", description: "Query diagnostics", sourceInfo: { source: "C:\\x\\node_modules\\pi-lens" } },
			{ name: "symbol_search", description: "Find symbols", sourceInfo: { source: "C:\\x\\node_modules\\pi-lens" } },
		],
		getActiveTools: () => ["read", "lens_diagnostics"],
		...overrides,
	};
}

describe("collectCapabilities", () => {
	test("splits commands by source", () => {
		const caps = collectCapabilities(source());
		expect(caps.skills.map((item) => item.name)).toEqual(["ck:plan", "ck:debug"]);
		expect(caps.promptTemplates.map((item) => item.name)).toEqual(["review"]);
		expect(caps.customCommands.map((item) => item.name)).toEqual(["plugins"]);
	});

	test("never suggests this extension's own commands", () => {
		const caps = collectCapabilities(source());
		expect(caps.customCommands.some((item) => item.name === "suggester")).toBe(false);
	});

	test("groups tools by owner and marks the inactive ones", () => {
		const caps = collectCapabilities(source());
		const lens = caps.tools.filter((tool) => tool.source === "pi-lens");
		expect(lens.map((tool) => tool.name)).toEqual(["lens_diagnostics", "symbol_search"]);
		expect(caps.tools.find((tool) => tool.name === "lens_diagnostics")?.active).toBe(true);
		expect(caps.tools.find((tool) => tool.name === "symbol_search")?.active).toBe(false);
	});

	test("survives a source that throws", () => {
		const caps = collectCapabilities(
			source({
				getCommands: () => {
					throw new Error("nope");
				},
			}),
		);
		expect(caps.skills).toEqual([]);
		expect(caps.tools.length).toBeGreaterThan(0);
	});
});

describe("rankItems", () => {
	const items = [
		{ name: "ck:plan", description: "Plan implementations and design architectures" },
		{ name: "ck:debug", description: "Debug test failures and root cause" },
		{ name: "ck:deploy", description: "Deploy to any platform" },
	];

	test("keeps only items matching the query", () => {
		expect(rankItems(items, "debug a failing test", 5).map((item) => item.name)).toEqual(["ck:debug"]);
	});

	test("respects the cap", () => {
		expect(rankItems(items, "plan debug deploy", 2)).toHaveLength(2);
	});

	test("returns nothing for a query with no signal", () => {
		expect(rankItems(items, "unrelated words entirely", 5)).toEqual([]);
	});

	test("ignores stopwords so they cannot produce false matches", () => {
		expect(rankItems(items, "the and for with", 5)).toEqual([]);
	});

	test("returns nothing when there is no query", () => {
		expect(rankItems(items, "", 5)).toEqual([]);
	});
});

describe("selectCapabilities", () => {
	const limits = { maxPerCategory: 1, maxDescriptionChars: 80, maxUnmatchedNames: 50 };

	test("caps each category independently", () => {
		const caps = collectCapabilities(source());
		const selected = selectCapabilities(caps, "plan debug review plugins read", limits);
		expect(selected.matched.skills.length).toBeLessThanOrEqual(1);
		expect(selected.matched.promptTemplates.length).toBeLessThanOrEqual(1);
		expect(selected.matched.customCommands.length).toBeLessThanOrEqual(1);
	});

	test("spreads tool slots across owners instead of letting one package win", () => {
		const caps = collectCapabilities(source());
		const selected = selectCapabilities(caps, "read symbols diagnostics file", { ...limits, maxPerCategory: 3 });
		const owners = new Set(selected.matched.tools.map((tool) => tool.source));
		expect(owners.size).toBeGreaterThan(1);
	});

	test("keeps non-matching capabilities as names only, so nothing is invisible", () => {
		const caps = collectCapabilities(source());
		const selected = selectCapabilities(caps, "plan", limits);

		expect(selected.matched.skills.map((item) => item.name)).toEqual(["ck:plan"]);
		// ck:debug does not match, but its name stays available without its description.
		expect(selected.unmatched.skills.map((item) => item.name)).toContain("ck:debug");
		expect(selected.unmatched.skills.every((item) => item.description === undefined)).toBe(true);
	});

	test("a large skill library is reduced to descriptions for the relevant ones only", () => {
		const caps = collectCapabilities(
			source({
				getCommands: () =>
					Array.from({ length: 60 }, (_, index) => ({
						name: `skill-${index}`,
						description: `generic helper number ${index}`,
						source: "skill",
					})).concat([{ name: "target", description: "handles concurrency bugs", source: "skill" }]),
			}),
		);
		const selected = selectCapabilities(caps, "concurrency bug", DEFAULT_CAPABILITY_LIMITS);
		expect(selected.matched.skills.map((item) => item.name)).toEqual(["target"]);
		expect(selected.matched.skills[0]?.description).toBeDefined();
	});

	test("the name index is capped", () => {
		const caps = collectCapabilities(
			source({
				getCommands: () =>
					Array.from({ length: 60 }, (_, index) => ({
						name: `skill-${index}`,
						description: "nothing relevant here",
						source: "skill",
					})),
			}),
		);
		const selected = selectCapabilities(caps, "unmatched", { ...limits, maxUnmatchedNames: 5 });
		expect(selected.unmatched.skills).toHaveLength(5);
	});
});

describe("renderCapabilities", () => {
	const limits = { maxPerCategory: 12, maxDescriptionChars: 80, maxUnmatchedNames: 50 };

	test("renders matching capabilities with descriptions", () => {
		const caps = collectCapabilities(source());
		const text = renderCapabilities(selectCapabilities(caps, "plan review plugins lens", limits), limits);

		expect(text).toContain("RelevantSkills");
		expect(text).toContain("ck:plan");
		expect(text).toContain("RelevantCommands");
		expect(text).toContain("RelevantTools");
	});

	test("lists non-matching capabilities as names only", () => {
		const caps = collectCapabilities(source());
		const text = renderCapabilities(selectCapabilities(caps, "plan", limits), limits);

		expect(text).toMatch(/OtherInstalledSkills: .*ck:debug/);
		// The unrelated skill must not consume a description slot.
		const relevantSection = text.slice(0, text.indexOf("OtherInstalledSkills"));
		expect(relevantSection).not.toContain("ck:debug");
	});

	test("renders nothing for an empty selection", () => {
		const empty = { matched: { skills: [], customCommands: [], promptTemplates: [], tools: [] }, unmatched: { skills: [], customCommands: [], promptTemplates: [], tools: [] } };
		expect(renderCapabilities(empty, limits)).toBe("");
	});

	test("marks inactive tools so the model does not suggest them", () => {
		const caps = collectCapabilities(source());
		const text = renderCapabilities(selectCapabilities(caps, "symbols diagnostics", limits), limits);
		expect(text).toContain("[inactive]");
	});

	test("truncates long descriptions", () => {
		const selection = {
			matched: { skills: [{ name: "x", description: "y".repeat(200) }], customCommands: [], promptTemplates: [], tools: [] },
			unmatched: { skills: [], customCommands: [], promptTemplates: [], tools: [] },
		};
		const text = renderCapabilities(selection, { maxPerCategory: 5, maxDescriptionChars: 30, maxUnmatchedNames: 5 });
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(200);
	});
});

describe("truncate", () => {
	test("collapses whitespace", () => {
		expect(truncate("a\n\n  b\tc", 50)).toBe("a b c");
	});

	test("adds an ellipsis when cutting", () => {
		expect(truncate("abcdefghij", 5)).toBe("abcd…");
	});

	test("leaves short text alone", () => {
		expect(truncate("abc", 5)).toBe("abc");
	});
});

describe("isEmptyCapabilities", () => {
	test("detects an empty inventory", () => {
		expect(isEmptyCapabilities({ skills: [], customCommands: [], promptTemplates: [], tools: [] })).toBe(true);
	});

	test("detects a non-empty inventory", () => {
		expect(
			isEmptyCapabilities({ skills: [{ name: "a" }], customCommands: [], promptTemplates: [], tools: [] }),
		).toBe(false);
	});
});

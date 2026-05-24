/**
 * Tests for the preset list/detail formatters. Pure functions over a
 * hand-built LoadedConfig — no filesystem, no Pi.
 */

import { describe, expect, it } from "vitest";
import type { DagNode } from "./dag.js";
import { gitCommitExtractor } from "./extractors/index.js";
import type { LoadedConfig } from "./loadConfig.js";
import { formatPresetDetails, formatPresetList } from "./preview.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const skillNode = (overrides: Partial<DagNode> = {}): DagNode =>
	({
		kind: "skill",
		skill: "test",
		completionStrategy: "agent-end",
		sessionPolicy: "fresh",
		...overrides,
	}) as DagNode;

const baseConfig = (overrides: Partial<LoadedConfig> = {}): LoadedConfig => ({
	dag: {
		edges: [],
		presets: {
			mid: ["research", "implement", "commit"],
			tiny: ["research", "commit"],
		},
		nodes: {
			research: skillNode({ skill: "research", completionStrategy: "artifact-emit" }),
			implement: skillNode({ skill: "implement" }),
			commit: skillNode({ skill: "commit", extractor: gitCommitExtractor }),
		},
	},
	presetNames: new Set(["mid", "tiny"]),
	defaultPreset: "mid",
	source: "project",
	layers: ["built-in", "project"],
	presetSources: new Map([
		["mid", "built-in"],
		["tiny", "project"],
	]),
	...overrides,
});

// ---------------------------------------------------------------------------
// formatPresetList
// ---------------------------------------------------------------------------

describe("formatPresetList", () => {
	it("lists every preset with its stage count and source layer", () => {
		const out = formatPresetList(baseConfig());
		expect(out).toContain("mid");
		expect(out).toContain("3 stages");
		expect(out).toContain("[built-in]");
		expect(out).toContain("tiny");
		expect(out).toContain("2 stages");
		expect(out).toContain("[project]");
	});

	it("annotates the default preset with (default)", () => {
		const out = formatPresetList(baseConfig());
		const midLine = out.split("\n").find((l) => l.trimStart().startsWith("mid")) ?? "";
		expect(midLine).toContain("(default)");
		const tinyLine = out.split("\n").find((l) => l.trimStart().startsWith("tiny")) ?? "";
		expect(tinyLine).not.toContain("(default)");
	});

	it("renders a single-line source banner for the merged layer set", () => {
		const out = formatPresetList(baseConfig());
		expect(out).toContain("Sources: built-in + project");
	});

	it("includes both usage hints — run and preview", () => {
		const out = formatPresetList(baseConfig());
		expect(out).toContain("Usage: /rpiv [preset] <description>");
		expect(out).toContain("/rpiv <preset>");
		expect(out).toContain("preview stages");
	});

	it("falls back to '[built-in]' for presets missing from presetSources", () => {
		// Defensive: if a preset name slips into presetNames without a source
		// entry, we don't want a crash or a 'undefined' tag.
		const config = baseConfig({
			presetSources: new Map([["mid", "built-in"]]),
		});
		const out = formatPresetList(config);
		const tinyLine = out.split("\n").find((l) => l.trimStart().startsWith("tiny")) ?? "";
		expect(tinyLine).toContain("[built-in]");
	});

	it("renders single-layer banner when only built-in is active", () => {
		const config = baseConfig({
			layers: ["built-in"],
			source: "built-in",
		});
		expect(formatPresetList(config)).toContain("Sources: built-in");
	});
});

// ---------------------------------------------------------------------------
// formatPresetDetails
// ---------------------------------------------------------------------------

describe("formatPresetDetails", () => {
	it("renders the header with layer + default tags", () => {
		const out = formatPresetDetails(baseConfig(), "mid");
		expect(out).toContain("preset: mid  (built-in, default)");
	});

	it("renders header without (default) tag for non-default presets", () => {
		const out = formatPresetDetails(baseConfig(), "tiny");
		expect(out).toContain("preset: tiny  (project)");
		expect(out).not.toContain("preset: tiny  (project, default)");
	});

	it("numbers stages 1-based and shows completionStrategy + sessionPolicy", () => {
		const out = formatPresetDetails(baseConfig(), "mid");
		const lines = out.split("\n");
		expect(lines.some((l) => /^\s+1\.\s+research\b/.test(l))).toBe(true);
		expect(lines.some((l) => /^\s+2\.\s+implement\b/.test(l))).toBe(true);
		expect(lines.some((l) => /^\s+3\.\s+commit\b/.test(l))).toBe(true);
		// research has completionStrategy: "artifact-emit"
		expect(lines.find((l) => /research/.test(l))).toContain("artifact-emit");
		expect(lines.find((l) => /research/.test(l))).toContain("fresh");
	});

	it("decorates stages whose node carries snapshot / extractor", () => {
		const out = formatPresetDetails(baseConfig(), "mid");
		const commitLine = out.split("\n").find((l) => /commit/.test(l)) ?? "";
		expect(commitLine).toContain("snapshot");
		expect(commitLine).toContain("extractor");
	});

	it("does NOT show snapshot / extractor decoration for plain nodes", () => {
		const out = formatPresetDetails(baseConfig(), "mid");
		const implementLine = out.split("\n").find((l) => /implement/.test(l)) ?? "";
		expect(implementLine).not.toContain("snapshot");
		expect(implementLine).not.toContain("extractor");
	});

	it("falls through to formatPresetList for unknown preset names", () => {
		const out = formatPresetDetails(baseConfig(), "does-not-exist");
		expect(out).toContain("Available presets:");
	});

	it("renders an '(unknown node)' marker for preset stages missing from nodes", () => {
		const config = baseConfig();
		config.dag.presets.broken = ["mystery"];
		(config.presetNames as Set<string>).add("broken");
		const out = formatPresetDetails(config, "broken");
		expect(out).toContain("mystery");
		expect(out).toContain("(unknown node)");
	});

	it("emits a per-preset usage hint", () => {
		const out = formatPresetDetails(baseConfig(), "tiny");
		expect(out).toContain("Usage: /rpiv tiny <description>");
	});
});

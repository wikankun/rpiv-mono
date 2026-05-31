/**
 * Unit tests for the load-time skill-alias transform (`aliasSkills`).
 *
 * The transform is pure and never mutates its input: it returns the original
 * workflow by reference when nothing changed (so the shared built-in registry
 * is never mutated in place) and a new frozen copy when a remap applied.
 */

import { describe, expect, it } from "vitest";
import type { StageDef, Workflow } from "./api.js";
import { aliasSkills } from "./load/alias.js";

// Minimal stage builders — `aliasSkills` only reads `run`, `prompt`, `skill`.
const skillStage = (skill?: string): StageDef => ({
	kind: "side-effect",
	sessionPolicy: "fresh",
	...(skill ? { skill } : {}),
});
const runStage = (): StageDef => ({ kind: "side-effect", sessionPolicy: "fresh", run: (async () => {}) as never });
const promptStage = (): StageDef => ({ kind: "side-effect", sessionPolicy: "fresh", prompt: "do the thing" });
const fanoutStage = (): StageDef => ({ kind: "produces", sessionPolicy: "fresh", fanout: (() => []) as never });
const iterateStage = (): StageDef => ({ kind: "produces", sessionPolicy: "fresh", iterate: (() => null) as never });

const wf = (stages: Record<string, StageDef>): Workflow => ({
	name: "w",
	start: Object.keys(stages)[0] ?? "x",
	stages,
	edges: {},
});

describe("aliasSkills", () => {
	it("materialises an implicit skill when the stage key is aliased", () => {
		const w = wf({ commit: skillStage() });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(out.stages.commit?.skill).toBe("attributed-commit");
		// Input untouched — the implicit skill stays implicit on the original.
		expect(w.stages.commit?.skill).toBeUndefined();
	});

	it("remaps an explicit skill keyed by the effective skill name (not the stage id)", () => {
		const w = wf({ release: skillStage("commit") });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(out.stages.release?.skill).toBe("attributed-commit");
	});

	it("skips prompt stages (no /skill: dispatch) — returns the same reference", () => {
		const w = wf({ p: promptStage() });
		expect(aliasSkills(w, { p: "x" })).toBe(w);
	});

	it("skips run (script) stages — returns the same reference", () => {
		const w = wf({ s: runStage() });
		expect(aliasSkills(w, { s: "x" })).toBe(w);
	});

	it("aliases fanout and iterate stages (they still dispatch a skill)", () => {
		const w = wf({ impl: fanoutStage(), gen: iterateStage() });
		const out = aliasSkills(w, { impl: "impl2", gen: "gen2" });
		expect(out.stages.impl?.skill).toBe("impl2");
		expect(out.stages.gen?.skill).toBe("gen2");
	});

	it("resolves one hop only — never follows the target as a new alias key", () => {
		const w = wf({ a: skillStage() });
		const out = aliasSkills(w, { a: "b", b: "c" });
		expect(out.stages.a?.skill).toBe("b");
	});

	it("returns the same reference for an empty alias map", () => {
		const w = wf({ commit: skillStage() });
		expect(aliasSkills(w, {})).toBe(w);
	});

	it("returns the same reference when no stage matches an alias key", () => {
		const w = wf({ commit: skillStage() });
		expect(aliasSkills(w, { nonexistent: "x" })).toBe(w);
	});

	it("treats an identity alias (target === effective) as a no-op", () => {
		const w = wf({ commit: skillStage() });
		expect(aliasSkills(w, { commit: "commit" })).toBe(w);
	});

	it("freezes the rewritten workflow", () => {
		const w = wf({ commit: skillStage() });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(Object.isFrozen(out)).toBe(true);
	});

	it("preserves untouched stages while remapping matched ones", () => {
		const w = wf({ research: skillStage(), commit: skillStage() });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(out.stages.research?.skill).toBeUndefined();
		expect(out.stages.commit?.skill).toBe("attributed-commit");
	});
});

import { describe, expect, it } from "vitest";
import { decorateStage, unitRowFields } from "./audit.js";
import type { UnitRef } from "./types.js";

describe("decorateStage", () => {
	it("renders a fanout/iterate unit tag as `parent (tag)`", () => {
		expect(decorateStage("implement", "phase-2")).toBe("implement (phase-2)");
	});

	it("renders an assess round/phase tag verbatim", () => {
		expect(decorateStage("breakdown", "r0·judge")).toBe("breakdown (r0·judge)");
	});
});

describe("unitRowFields", () => {
	it("returns {} for a single (non-loop) stage so the spread adds nothing", () => {
		expect(unitRowFields(undefined)).toEqual({});
		// Spreading the empty object into a row leaves the JSON byte-identical.
		expect(JSON.stringify({ stage: "x", ...unitRowFields(undefined) })).toBe(JSON.stringify({ stage: "x" }));
	});

	it("projects a UnitRef into the four structured row fields", () => {
		const unit: UnitRef = { parent: "implement", role: "produce", index: 1, id: "phase-2", label: "phase 2/5" };
		expect(unitRowFields(unit)).toEqual({
			parent: "implement",
			role: "produce",
			unitId: "phase-2",
			unitIndex: 1,
		});
	});

	it("carries an undefined id through (assess units have no stable id)", () => {
		const unit: UnitRef = { parent: "breakdown", role: "judge", index: 0, label: "r0·judge" };
		expect(unitRowFields(unit)).toEqual({
			parent: "breakdown",
			role: "judge",
			unitId: undefined,
			unitIndex: 0,
		});
	});
});

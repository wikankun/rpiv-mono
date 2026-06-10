/**
 * Construction-time tests for the `Judge` first-class concept: `judge()` is a
 * valid-by-construction factory (the `defineRoute` pattern) backed by a single
 * `judgeShapeIssues` rule source. Invalid shapes — missing `outcome.name`,
 * skill+prompt, neither — are unrepresentable past the factory.
 */

import { describe, expect, it } from "vitest";
import { type Judge, judge, judgeShapeIssues } from "./judge.js";

const outcome = { name: "verdict" } as Judge["outcome"];

describe("judgeShapeIssues", () => {
	it("returns no issues for a valid skill judge", () => {
		expect(judgeShapeIssues({ skill: "grade", outcome })).toEqual([]);
	});

	it("returns no issues for a valid prompt judge", () => {
		expect(judgeShapeIssues({ prompt: "grade this", outcome })).toEqual([]);
	});

	it("flags a missing judge object", () => {
		expect(judgeShapeIssues(undefined)).toEqual(["a judge object is required"]);
	});

	it("flags missing outcome.name", () => {
		const issues = judgeShapeIssues({ skill: "grade", outcome: {} as Judge["outcome"] });
		expect(issues).toContain("judge.outcome must carry a `name` so the verdict publishes to its own named channel");
	});

	it("flags skill+prompt (both dispatchers set)", () => {
		const issues = judgeShapeIssues({ skill: "grade", prompt: "x", outcome });
		expect(issues).toContain("judge sets both `skill` and `prompt` — choose one dispatch (skill XOR prompt)");
	});

	it("flags neither skill nor prompt", () => {
		const issues = judgeShapeIssues({ outcome });
		expect(issues).toContain("judge sets neither `skill` nor `prompt` — one is required to dispatch the judge");
	});
});

describe("judge()", () => {
	it("is an identity passthrough for a valid judge", () => {
		const spec: Judge = { skill: "grade", outcome };
		expect(judge(spec)).toBe(spec);
	});

	it("throws on missing outcome.name", () => {
		expect(() => judge({ skill: "grade", outcome: {} as Judge["outcome"] })).toThrow(/judge\(\):.*name/);
	});

	it("throws on skill+prompt", () => {
		expect(() => judge({ skill: "grade", prompt: "x", outcome })).toThrow(/skill XOR prompt/);
	});

	it("throws on neither skill nor prompt", () => {
		expect(() => judge({ outcome })).toThrow(/one is required to dispatch/);
	});
});

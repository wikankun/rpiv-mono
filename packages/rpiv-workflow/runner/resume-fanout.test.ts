/**
 * End-to-end fanout-resume tests — drive `resumeWorkflow` over a fanout workflow
 * with a mock session chain. Complements the pure-fold cases in resume.test.ts.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FanoutUnit, gate, produces, type Workflow } from "../api.js";
import { fs as fsHandle } from "../handle.js";
import type { OutputSpec } from "../output.js";
import { eq, gt } from "../predicates.js";
import { appendStage, readAllStages, type WorkflowHeader, type WorkflowStage, writeHeader } from "../state/index.js";
import { typeboxSchema } from "../typebox-adapter.js";
import { resumeWorkflow } from "./runner.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-fanout-resume-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const header: WorkflowHeader = {
	runId: "2026-06-03_07-30-00-ab12",
	workflow: "fanout-wf",
	input: "Ship it",
	ts: "2026-06-03T07:30:00Z",
};

/** Deterministic 3-unit fanout (blind to artifact, stable across re-call). */
const threeUnits = (): readonly FanoutUnit[] =>
	[1, 2, 3].map((n) => ({ prompt: `phase ${n}`, label: `phase ${n}/3`, id: `phase-${n}` }));

const fanoutWf: Workflow = {
	name: "fanout-wf",
	start: "impl",
	stages: { impl: { kind: "produces", sessionPolicy: "fresh", fanout: threeUnits } },
	edges: { impl: "stop" },
} as Workflow;

function writeRun(stages: WorkflowStage[]): void {
	writeHeader(tmpDir, header);
	for (const s of stages) appendStage(tmpDir, header.runId, s);
}
const unitRow = (n: number, num: number, status: "completed" | "failed"): WorkflowStage => ({
	stageNumber: num,
	stage: `impl (phase-${n})`,
	skill: "impl",
	status,
	ts: `t${num}`,
	...(status === "failed" ? { errMsg: "boom" } : {}),
});

describe("fanout-resume", () => {
	it("mid-fanout failure: re-runs only the failed unit + remaining, then chains to stop", async () => {
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "completed"), unitRow(3, 3, "failed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("unit 3 done")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: fanoutWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Only unit 3 re-ran → exactly one new dispatch.
		expect(chain.sentMessages).toEqual(["/skill:impl phase 3"]);
		// New completed row appended for unit 3; total = 3 original + 1 new.
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows).toHaveLength(4);
		expect(rows[3]).toMatchObject({ stage: "impl (phase-3)", status: "completed" });
	});

	it("process died mid-fanout (no failure row): resumes at the next unit", async () => {
		writeRun([unitRow(1, 1, "completed")]); // only unit 1 recorded
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("unit 2")] }, { branch: [mockAssistantMessage("unit 3")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: fanoutWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual(["/skill:impl phase 2", "/skill:impl phase 3"]);
	});

	it("fully-completed fanout: no-op route-onward — single completion notice, no re-announce", async () => {
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "completed"), unitRow(3, 3, "completed")]);
		const fanoutStarts: number[] = [];
		const stageStarts: string[] = [];
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, {
			workflow: fanoutWf,
			header,
			ref: "@x",
			lifecycle: {
				onFanoutStart: (_stage, units) => {
					fanoutStarts.push(units.length);
				},
				onStageStart: (stage) => {
					stageStarts.push(stage.name);
				},
			},
		});

		expect(result.success).toBe(true);
		expect(chain.ctx.newSession).not.toHaveBeenCalled();
		expect(readAllStages(tmpDir, header.runId)).toHaveLength(3); // no new rows

		// Short-circuit: the finished fanout is NOT re-announced (no onStageStart /
		// onFanoutStart re-fire on a no-op resume).
		expect(fanoutStarts).toEqual([]);
		expect(stageStarts).toEqual([]);
		// ...and the only completion toast is the workflow-level one — no spurious
		// per-stage "✓ impl completed" (symmetric with a finished-linear resume).
		expect(chain.notifications.filter((n) => n.msg === "✓ impl completed")).toEqual([]);
		expect(chain.notifications.filter((n) => /workflow complete/.test(n.msg))).toHaveLength(1);
	});

	it("non-deterministic FanoutFn: records a terminal failure, refuses to re-run wrong units", async () => {
		// Recorded run had `phase-1` completed; the workflow now recomputes different ids.
		const drifted: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: {
				impl: {
					kind: "produces",
					sessionPolicy: "fresh",
					fanout: () => [{ prompt: "x", label: "task 1", id: "task-1" }],
				},
			},
			edges: { impl: "stop" },
		} as Workflow;
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: drifted, header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/deterministic/);
		// In-run failure (we got far enough to start resuming) → runId present, row written.
		expect(result.runId).toBe(header.runId);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "impl", status: "failed" });
		// No unit was dispatched.
		expect(chain.sentMessages).toEqual([]);
	});

	it("paren-in-label: a parenthesized completed prefix still resumes (no false mismatch)", async () => {
		// The decoration guard compares full strings — a label containing parens
		// (`impl (phase (a))`) must not be mis-parsed into a spurious mismatch.
		const parenUnits = (): readonly FanoutUnit[] => [
			{ prompt: "first", label: "phase (a)" },
			{ prompt: "second", label: "phase (b)" },
		];
		const parenWf: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: { impl: { kind: "produces", sessionPolicy: "fresh", fanout: parenUnits } },
			edges: { impl: "stop" },
		} as Workflow;
		// Unit 1 (label "phase (a)") completed; unit 2 failed.
		writeRun([
			{ stageNumber: 1, stage: "impl (phase (a))", skill: "impl", status: "completed", ts: "t1" },
			{ stageNumber: 2, stage: "impl (phase (b))", skill: "impl", status: "failed", ts: "t2", errMsg: "boom" },
		]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [{ branch: [mockAssistantMessage("unit b")] }] });

		const result = await resumeWorkflow(chain.ctx, { workflow: parenWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Prefix matched despite the parens → only unit 2 re-ran.
		expect(chain.sentMessages).toEqual(["/skill:impl second"]);
	});
});

// ---------------------------------------------------------------------------
// Looped fanout — a gated back-edge (review → impl) ran the fanout a SECOND
// time and died mid-second-pass. Resume must continue only the trailing
// generation; the fold no longer concatenates the prior pass into the prefix.
// ---------------------------------------------------------------------------

const PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Transcript-scan outcome (rpiv-pi convention, inlined). Emits matched paths as artifacts. */
const transcriptOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const matches: string[] = [];
			for (let i = Math.max(ctx.branchOffset ?? 0, 0); i < ctx.branch.length; i++) {
				const entry = ctx.branch[i]!;
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						const m = part.text.match(PATTERN);
						if (m) matches.push(...m);
					}
				}
			}
			if (matches.length === 0) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			return { kind: "ok", artifacts: matches.map((p) => ({ handle: fsHandle(p), role: "primary" as const })) };
		},
	},
	parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
});

/** Like transcriptOutcome but parses blockers_count from the artifact's frontmatter (drives the gate). */
const blockersOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: transcriptOutcome(name).collector,
	parser: {
		parse: (ctx) => {
			const primary = ctx.artifacts[0];
			if (primary?.handle.kind !== "fs") return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
			const abs = primary.handle.path.startsWith("/") ? primary.handle.path : join(ctx.cwd, primary.handle.path);
			const m = readFileSync(abs, "utf-8").match(/blockers_count:\s*(\d+)/);
			return { kind: "ok", payload: { kind: "artifact-md", data: { blockers_count: Number(m?.[1] ?? 0) } } };
		},
	},
});

/** Two stable units, blind to the artifact (same prefix every generation). */
const implUnits = (): readonly FanoutUnit[] => [
	{ prompt: "a", label: "a" },
	{ prompt: "b", label: "b" },
];

describe("fanout-resume — looped (corrective) back-edge", () => {
	let loopDir: string;
	beforeEach(() => {
		loopDir = mkdtempSync(join(tmpdir(), "rpiv-fanout-resume-loop-"));
	});
	afterEach(() => {
		rmSync(loopDir, { recursive: true, force: true });
	});

	const loopHeader: WorkflowHeader = {
		runId: "2026-06-03_09-30-00-ef56",
		workflow: "fanout-loop",
		input: "Ship it",
		ts: "2026-06-03T09:30:00Z",
	};

	const writeLoopArtifact = (rel: string, body: string) => {
		mkdirSync(join(loopDir, ...rel.split("/").slice(0, -1)), { recursive: true });
		writeFileSync(join(loopDir, rel), body);
	};

	const out = (stage: string, num: number, rel: string): WorkflowStage["output"] => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(rel), role: "primary" }],
		data: {},
		meta: { stage, stageNumber: num, ts: "", runId: "" },
	});

	it("died mid-second-pass: re-runs only the trailing generation's remaining unit, then routes onward", async () => {
		// seed -> impl(fanout a,b) -> review(gate: loop to impl if blockers>0, else stop).
		// Recorded: seed -> impl(a,b) gen 1 -> review(blockers=1, looped) -> impl(a) gen 2 done, impl(b) died.
		writeLoopArtifact(".rpiv/artifacts/reviews/cr2.md", "---\nblockers_count: 0\n---\n");
		writeHeader(loopDir, loopHeader);
		const rows: WorkflowStage[] = [
			{
				stageNumber: 1,
				stage: "seed",
				skill: "seed",
				status: "completed",
				ts: "t1",
				output: out("seed", 1, ".rpiv/artifacts/seeds/s1.md"),
			},
			{ stageNumber: 2, stage: "impl (a)", skill: "impl", status: "completed", ts: "t2" },
			{ stageNumber: 3, stage: "impl (b)", skill: "impl", status: "completed", ts: "t3" },
			{
				stageNumber: 4,
				stage: "review",
				skill: "review",
				status: "completed",
				ts: "t4",
				output: out("review", 4, ".rpiv/artifacts/reviews/cr1.md"),
			},
			// gen 2 — non-contiguous with gen 1 (the review row broke contiguity).
			{ stageNumber: 5, stage: "impl (a)", skill: "impl", status: "completed", ts: "t5" },
			{ stageNumber: 6, stage: "impl (b)", skill: "impl", status: "failed", ts: "t6", errMsg: "boom" },
		];
		for (const s of rows) appendStage(loopDir, loopHeader.runId, s);

		const chain = createMockSessionChain({
			cwd: loopDir,
			steps: [
				{ branch: [mockAssistantMessage("unit b done")] }, // impl gen-2 unit b re-run
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/cr2.md")] }, // review gen 2 → blockers=0
			],
		});

		const wf: Workflow = {
			name: "fanout-loop",
			start: "seed",
			stages: {
				seed: produces({ outcome: transcriptOutcome("seeds") }),
				impl: { kind: "produces", sessionPolicy: "fresh", fanout: implUnits },
				review: produces({
					outcome: blockersOutcome("reviews"),
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
			},
			edges: {
				seed: "impl",
				impl: "review",
				review: gate("blockers_count", { impl: gt(0), stop: eq(0) }),
			},
		} as Workflow;

		const result = await resumeWorkflow(chain.ctx, { workflow: wf, header: loopHeader, ref: "@x" });

		expect(result.success).toBe(true);
		// Only the trailing generation's remaining unit (b) re-ran — unit a of gen 2 did NOT.
		// Then review re-ran (gen 2), saw blockers=0, and the gate routed to stop.
		expect(chain.sentMessages).toEqual(["/skill:impl b", "/skill:review .rpiv/artifacts/reviews/cr1.md"]);
		// New rows appended after the originals with strictly greater stage numbers.
		const all = readAllStages(loopDir, loopHeader.runId);
		expect(all.slice(6).every((s) => s.stageNumber > 6)).toBe(true);
		expect(all[all.length - 1]).toMatchObject({ stage: "review", status: "completed" });
	});
});

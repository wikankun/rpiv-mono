/**
 * End-to-end iterate-resume tests — drive `resumeWorkflow` with a mock session chain
 * over a real iterate workflow. Complements the pure-fold cases in resume.test.ts.
 *
 * The generator reads the FROZEN review artifact for its phase list, so these tests
 * exercise entry-artifact reconstruction, accumulation reconstruction, pull resumption,
 * the boundary determinism guard, and chain continuation together.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, type FanoutFn, gate, type IterateFn, produces, type Workflow } from "../api.js";
import { fs as fsHandle } from "../handle.js";
import type { OutputSpec } from "../output.js";
import { eq, gt } from "../predicates.js";
import { appendStage, readAllStages, type WorkflowHeader, type WorkflowStage, writeHeader } from "../state/index.js";
import { typeboxSchema } from "../typebox-adapter.js";
import { resumeWorkflow } from "./runner.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-iterate-resume-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const header: WorkflowHeader = {
	runId: "2026-06-03_08-00-00-cd34",
	workflow: "polish",
	input: "Ship it",
	ts: "2026-06-03T08:00:00Z",
};

const REVIEW_3_PHASES = "# Review\n\n### Phase 1 — Alpha\nx\n### Phase 2 — Beta\ny\n### Phase 3 — Gamma\nz\n";

const writeArtifact = (rel: string, body: string) => {
	mkdirSync(join(tmpDir, ...rel.split("/").slice(0, -1)), { recursive: true });
	writeFileSync(join(tmpDir, rel), body);
};

const PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Transcript-scan outcome (rpiv-pi convention, inlined). Emits matched paths as artifacts. */
const makeOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
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

/** Deterministic per-phase generator keyed off the frozen review file (mirror iterate.test.ts). */
const reviewPhaseIterate: IterateFn = ({ artifact, index, cwd }) => {
	if (artifact?.handle.kind !== "fs") return null;
	const abs = artifact.handle.path.startsWith("/") ? artifact.handle.path : join(cwd, artifact.handle.path);
	const phases = [...readFileSync(abs, "utf-8").matchAll(/^### Phase (\d+) — (.+)$/gm)];
	if (index >= phases.length) return null;
	const num = phases[index]![1];
	return { prompt: `plan phase ${num}`, label: `phase ${index + 1}/${phases.length}`, id: `phase-${num}` };
};

// review (produces "reviews") -> blueprint (iterate, produces "plans") -> consume.
const polishWf = (iterate: IterateFn = reviewPhaseIterate): Workflow =>
	({
		name: "polish",
		start: "review",
		stages: {
			review: produces({ outcome: makeOutcome("reviews") }),
			blueprint: produces({ outcome: makeOutcome("plans"), iterate }),
			consume: acts(),
		},
		edges: { review: "blueprint", blueprint: "consume", consume: "stop" },
	}) as Workflow;

const artifactOutput = (stage: string, num: number, rel: string): WorkflowStage["output"] => ({
	kind: "artifacts",
	artifacts: [{ handle: fsHandle(rel), role: "primary" }],
	data: {},
	meta: { stage, stageNumber: num, ts: "", runId: "" },
});

/** A recorded blueprint iterate-unit row. `phase` is the unit's phase number (== its `id`). */
const planRow = (phase: number, num: number, status: "completed" | "failed"): WorkflowStage => ({
	stageNumber: num,
	stage: `blueprint (phase-${phase})`,
	skill: "blueprint",
	status,
	ts: `t${num}`,
	...(status === "completed"
		? { output: artifactOutput("blueprint", num, `.rpiv/artifacts/plans/p${phase}.md`) }
		: { errMsg: "boom" }),
});

const reviewRow: WorkflowStage = {
	stageNumber: 1,
	stage: "review",
	skill: "review",
	status: "completed",
	ts: "t1",
	output: artifactOutput("review", 1, ".rpiv/artifacts/reviews/rev.md"),
};

function writeRun(stages: WorkflowStage[]): void {
	writeArtifact(".rpiv/artifacts/reviews/rev.md", REVIEW_3_PHASES);
	writeHeader(tmpDir, header);
	for (const s of stages) appendStage(tmpDir, header.runId, s);
}

describe("iterate-resume", () => {
	it("mid-iterate failure: re-pulls + re-runs the failed unit + remaining, then chains to consume/stop", async () => {
		writeRun([reviewRow, planRow(1, 2, "completed"), planRow(2, 3, "failed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] }, // phase-2 re-run
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] }, // phase-3
				{ branch: [mockAssistantMessage("consumed")] }, // consume
			],
		});
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(), header, ref: "@x" });
		expect(result.success).toBe(true);
		// phase-2 (re-run), phase-3, consume — phase-1 NOT re-run.
		expect(chain.sentMessages).toEqual([
			"/skill:blueprint plan phase 2",
			"/skill:blueprint plan phase 3",
			expect.stringContaining("consume"),
		]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "consume", status: "completed" });
	});

	it("process died mid-iterate (no failure row): resumes at the next pull", async () => {
		writeRun([reviewRow, planRow(1, 2, "completed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(), header, ref: "@x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages.slice(0, 2)).toEqual([
			"/skill:blueprint plan phase 2",
			"/skill:blueprint plan phase 3",
		]);
	});

	it("fully-completed iterate trailer: no-op, routes onward, no new blueprint sessions", async () => {
		// All 3 phases done; trailer is the last completed unit (process died before advanceChain).
		writeRun([reviewRow, planRow(1, 2, "completed"), planRow(2, 3, "completed"), planRow(3, 4, "completed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("consumed")] }],
		});
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(), header, ref: "@x" });
		expect(result.success).toBe(true);
		// Only `consume` ran; no blueprint re-pull dispatched.
		expect(chain.sentMessages).toEqual([expect.stringContaining("consume")]);
	});

	it("non-deterministic IterateFn: boundary mismatch records terminal failure, runs no unit", async () => {
		// Recorded run had `phase-2` failing; the workflow now recomputes a differently-tagged unit.
		const drifted: IterateFn = ({ index }) =>
			index >= 3 ? null : { prompt: "x", label: `task ${index}`, id: `task-${index}` };
		writeRun([reviewRow, planRow(1, 2, "completed"), planRow(2, 3, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(drifted), header, ref: "@x" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/deterministic/);
		expect(result.runId).toBe(header.runId); // in-run failure → row written
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "blueprint", status: "failed" });
		expect(chain.sentMessages).toEqual([]); // no unit dispatched
	});

	it("paren-tolerant boundary guard: a unit label with parens resumes (full-string decoration compare)", async () => {
		// Units carry parens in their label, so the decorated row key is `blueprint (phase (N))`.
		// The boundary guard compares full decorated strings, so the inner parens don't false-mismatch.
		const parenIterate: IterateFn = ({ index }) =>
			index >= 2 ? null : { prompt: `do ${index}`, label: `phase (${index})` };
		const wf: Workflow = {
			name: "paren",
			start: "blueprint",
			stages: {
				blueprint: produces({ outcome: makeOutcome("plans"), iterate: parenIterate }),
				consume: acts(),
			},
			edges: { blueprint: "consume", consume: "stop" },
		} as Workflow;
		// Recorded: unit 0 completed, unit 1 (the boundary) failed.
		writeHeader(tmpDir, header);
		appendStage(tmpDir, header.runId, {
			stageNumber: 1,
			stage: "blueprint (phase (0))",
			skill: "blueprint",
			status: "completed",
			ts: "t1",
			output: artifactOutput("blueprint", 1, ".rpiv/artifacts/plans/p0.md"),
		});
		appendStage(tmpDir, header.runId, {
			stageNumber: 2,
			stage: "blueprint (phase (1))",
			skill: "blueprint",
			status: "failed",
			ts: "t2",
			errMsg: "boom",
		});
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] }, // phase (1) re-run
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});
		const result = await resumeWorkflow(chain.ctx, { workflow: wf, header, ref: "@x" });
		expect(result.success).toBe(true); // no false mismatch despite the inner parens
		expect(chain.sentMessages).toEqual(["/skill:blueprint do 1", expect.stringContaining("consume")]);
	});
});

// ---------------------------------------------------------------------------
// Corrective back-edge resume — a gated loop (code-review → blueprint) ran a
// SECOND iterate generation that died mid-way. Resume must continue only the
// trailing generation while `state.named.plans` carries BOTH generations.
// ---------------------------------------------------------------------------

describe("iterate-resume — corrective back-edge", () => {
	let loopDir: string;
	beforeEach(() => {
		loopDir = mkdtempSync(join(tmpdir(), "rpiv-iterate-resume-loop-"));
	});
	afterEach(() => {
		rmSync(loopDir, { recursive: true, force: true });
	});

	const loopHeader: WorkflowHeader = {
		runId: "2026-06-03_09-00-00-ef56",
		workflow: "polish-loop",
		input: "Ship it",
		ts: "2026-06-03T09:00:00Z",
	};
	const REVIEW_2_PHASES = "# Review\n\n### Phase 1 — A\nx\n### Phase 2 — B\ny\n";

	const writeLoopArtifact = (rel: string, body: string) => {
		mkdirSync(join(loopDir, ...rel.split("/").slice(0, -1)), { recursive: true });
		writeFileSync(join(loopDir, rel), body);
	};

	/** Sources the review from state.named (robust to the rolling primary being the code-review doc on re-entry). */
	const reviewFromState: IterateFn = ({ state, index, cwd }) => {
		const review = state.named.architecture_reviews?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");
		if (review?.handle.kind !== "fs") return null;
		const abs = review.handle.path.startsWith("/") ? review.handle.path : join(cwd, review.handle.path);
		const phases = [...readFileSync(abs, "utf-8").matchAll(/^### Phase (\d+) — (.+)$/gm)];
		if (index >= phases.length) return null;
		const num = phases[index]![1];
		return {
			prompt: `${review.handle.path} Phase ${num}`,
			label: `phase ${index + 1}/${phases.length}`,
			id: `phase-${num}`,
		};
	};

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

	const plansFanout: FanoutFn = ({ state }) =>
		(state.named.plans ?? [])
			.flatMap((o) => o.artifacts)
			.filter((a) => a.handle.kind === "fs")
			.map((a, i) => ({ prompt: a.handle.kind === "fs" ? a.handle.path : "", label: `plan ${i + 1}` }));

	const loopOutput = (stage: string, num: number, rel: string): WorkflowStage["output"] => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(rel), role: "primary" }],
		data: {},
		meta: { stage, stageNumber: num, ts: "", runId: "" },
	});

	it("resumes the trailing generation only; state.named.plans keeps both generations", async () => {
		writeLoopArtifact(".rpiv/artifacts/architecture_reviews/rev.md", REVIEW_2_PHASES);
		writeLoopArtifact(".rpiv/artifacts/reviews/cr2.md", "---\nblockers_count: 0\n---\n");

		// Recorded trail: gen 1 (2 plans) → code-review (blockers=1, looped) → gen 2 phase-1 done, phase-2 died.
		writeHeader(loopDir, loopHeader);
		const rows: WorkflowStage[] = [
			{
				stageNumber: 1,
				stage: "review",
				skill: "review",
				status: "completed",
				ts: "t1",
				output: loopOutput("review", 1, ".rpiv/artifacts/architecture_reviews/rev.md"),
			},
			{
				stageNumber: 2,
				stage: "blueprint (phase-1)",
				skill: "blueprint",
				status: "completed",
				ts: "t2",
				output: loopOutput("blueprint", 2, ".rpiv/artifacts/plans/g1p1.md"),
			},
			{
				stageNumber: 3,
				stage: "blueprint (phase-2)",
				skill: "blueprint",
				status: "completed",
				ts: "t3",
				output: loopOutput("blueprint", 3, ".rpiv/artifacts/plans/g1p2.md"),
			},
			{
				stageNumber: 4,
				stage: "code-review",
				skill: "code-review",
				status: "completed",
				ts: "t4",
				output: loopOutput("code-review", 4, ".rpiv/artifacts/reviews/cr1.md"),
			},
			{
				stageNumber: 5,
				stage: "blueprint (phase-1)",
				skill: "blueprint",
				status: "completed",
				ts: "t5",
				output: loopOutput("blueprint", 5, ".rpiv/artifacts/plans/g2p1.md"),
			},
			{
				stageNumber: 6,
				stage: "blueprint (phase-2)",
				skill: "blueprint",
				status: "failed",
				ts: "t6",
				errMsg: "boom",
			},
		];
		for (const s of rows) appendStage(loopDir, loopHeader.runId, s);

		const chain = createMockSessionChain({
			cwd: loopDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/g2p2.md")] }, // gen-2 phase-2 re-run
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/cr2.md")] }, // code-review → blockers=0
				// consume fanout: one unit per accumulated plan (4 total).
				{ branch: [mockAssistantMessage("impl 1")] },
				{ branch: [mockAssistantMessage("impl 2")] },
				{ branch: [mockAssistantMessage("impl 3")] },
				{ branch: [mockAssistantMessage("impl 4")] },
			],
		});

		const wf: Workflow = {
			name: "polish-loop",
			start: "review",
			stages: {
				review: produces({ outcome: transcriptOutcome("architecture_reviews") }),
				blueprint: produces({ outcome: transcriptOutcome("plans"), iterate: reviewFromState }),
				"code-review": produces({
					outcome: blockersOutcome("reviews"),
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
				consume: acts({ fanout: plansFanout }),
			},
			edges: {
				review: "blueprint",
				blueprint: "code-review",
				"code-review": gate("blockers_count", { blueprint: gt(0), consume: eq(0) }),
				consume: "stop",
			},
		} as Workflow;

		const result = await resumeWorkflow(chain.ctx, { workflow: wf, header: loopHeader, ref: "@x" });

		expect(result.success).toBe(true);
		// Only the trailing generation's remaining unit (phase-2) re-ran — phase-1 of gen 2 did NOT.
		const blueprintMsgs = chain.sentMessages.filter((m) => m.startsWith("/skill:blueprint"));
		expect(blueprintMsgs).toEqual(["/skill:blueprint .rpiv/artifacts/architecture_reviews/rev.md Phase 2"]);
		// The consume fanout saw ALL FOUR plans — state.named["plans"] carried both generations.
		expect(chain.sentMessages.slice(-4)).toEqual([
			"/skill:consume .rpiv/artifacts/plans/g1p1.md",
			"/skill:consume .rpiv/artifacts/plans/g1p2.md",
			"/skill:consume .rpiv/artifacts/plans/g2p1.md",
			"/skill:consume .rpiv/artifacts/plans/g2p2.md",
		]);
	});
});

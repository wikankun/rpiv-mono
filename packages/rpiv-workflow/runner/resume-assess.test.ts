/**
 * End-to-end assess-resume tests — drive `resumeWorkflow` with a mock session chain
 * over a real assess workflow. Complements the pure-fold cases in resume.test.ts.
 *
 * The producer scans the transcript for `.rpiv/artifacts/<bucket>/<file>.md`; the
 * skill judge scans for a `.rpiv/verdicts/<file>.json` verdict file parsed to
 * `{ done, feedback }`. Pre-writing the verdict files lets each test control the
 * judge's decision without a live model. Recorded JSONL rows carry the verdict in
 * `output.data` so the resume dispatch can re-check `judge.done` without re-grading.
 *
 * Four pending-sub-step paths:
 *   1. resume-at-judge      — trailer is a completed producer → grade round n
 *   2. resume-at-produce    — trailer is a not-done judge → run produce n+1, feeding
 *                             the recovered verdict forward (no re-grade)
 *   3. resume-after-done    — trailer is a done judge → advance downstream, no re-run
 *   4. resume-at-produce-0  — trailer is a failed round-0 producer → re-run produce 0
 * Plus a direct boundary-guard test (recomputed pending tag ≠ failed trailer → drift).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AssessConfig, acts, produces, type Workflow } from "../api.js";
import type { AssessDeps } from "../assess.js";
import { fs as fsHandle } from "../handle.js";
import { LifecycleDispatcher } from "../lifecycle.js";
import type { Output, OutputSpec } from "../output.js";
import { appendStage, readAllStages, type WorkflowHeader, type WorkflowStage, writeHeader } from "../state/index.js";
import { DEFAULT_TRIGGER } from "../triggers.js";
import type { RunContext } from "../types.js";
import type { AssessResumePoint } from "./resume.js";
import { resumeAssessStage } from "./resume-assess.js";
import { resumeWorkflow } from "./runner.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-assess-resume-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const header: WorkflowHeader = {
	runId: "2026-06-03_10-00-00-aa11",
	workflow: "decompose",
	input: "decompose this",
	ts: "2026-06-03T10:00:00Z",
};

// ---------------------------------------------------------------------------
// Outcomes (mirror assess.test.ts) — producer scans for an .md, judge for a .json.
// ---------------------------------------------------------------------------

const MD_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;
const JSON_PATTERN = /\.rpiv\/verdicts\/[\w.-]+\.json/g;

const lastMatch = (ctx: { branch: unknown[]; branchOffset?: number }, pattern: RegExp): string | undefined => {
	let found: string | undefined;
	const start = Math.max(ctx.branchOffset ?? 0, 0);
	for (let i = start; i < ctx.branch.length; i++) {
		const entry = ctx.branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") {
				const m = part.text.match(pattern);
				if (m) found = m[m.length - 1];
			}
		}
	}
	return found;
};

const producerOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const path = lastMatch(ctx, MD_PATTERN);
			if (!path) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			return { kind: "ok", artifacts: [{ handle: fsHandle(path), role: "primary" }] };
		},
	},
	parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
});

const verdictOutcome = (name: string): OutputSpec<unknown, "verdict", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const path = lastMatch(ctx, JSON_PATTERN);
			if (!path) return { kind: "fatal", message: `${ctx.skill} produced no verdict path` };
			return { kind: "ok", artifacts: [{ handle: fsHandle(path), role: "primary" }] };
		},
	},
	parser: {
		parse: (ctx) => {
			const primary = ctx.artifacts[0];
			const path = primary?.handle.kind === "fs" ? primary.handle.path : undefined;
			if (!path) return { kind: "ok", payload: { kind: "verdict", data: {} } };
			const abs = path.startsWith("/") ? path : join(ctx.cwd, path);
			if (!existsSync(abs)) return { kind: "ok", payload: { kind: "verdict", data: {} } };
			return { kind: "ok", payload: { kind: "verdict", data: JSON.parse(readFileSync(abs, "utf-8")) } };
		},
	},
});

const done = (v: Output) => Boolean((v.data as { done?: boolean }).done);
const feedForward: AssessConfig["feedForward"] = ({ verdict, round }) =>
	`refine round=${round} fb=${(verdict.data as { feedback?: string }).feedback}`;

/** breakdown (assess; start) → consume. */
const assessWf: Workflow = {
	name: "decompose",
	start: "breakdown",
	stages: {
		breakdown: produces({
			outcome: producerOutcome("tasks"),
			assess: { judge: { skill: "grade", outcome: verdictOutcome("verdict"), done }, feedForward },
		}),
		consume: acts(),
	},
	edges: { breakdown: "consume", consume: "stop" },
} as Workflow;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const writeFile = (relPath: string, content = "") => {
	const parts = relPath.split("/");
	mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
	writeFileSync(join(tmpDir, relPath), content);
};

/** Pre-write a verdict JSON and return its relative path. */
const writeVerdict = (n: number, isDone: boolean, feedback = `fb${n}`): string => {
	const rel = `.rpiv/verdicts/v${n}.json`;
	writeFile(rel, JSON.stringify({ done: isDone, feedback }));
	return rel;
};

const taskOutput = (round: number, num: number): Output => ({
	kind: "artifacts",
	artifacts: [{ handle: fsHandle(`.rpiv/artifacts/tasks/t${round}.md`), role: "primary" }],
	data: {},
	meta: { stage: "breakdown", stageNumber: num, ts: "", runId: "" },
});

const verdictOutput = (round: number, num: number, isDone: boolean): Output => ({
	kind: "artifacts",
	artifacts: [{ handle: fsHandle(`.rpiv/verdicts/v${round}.json`), role: "primary" }],
	data: { done: isDone, feedback: `fb${round}` },
	meta: { stage: "breakdown", stageNumber: num, ts: "", runId: "" },
});

const produceRow = (round: number, num: number, status: WorkflowStage["status"] = "completed"): WorkflowStage => ({
	stageNumber: num,
	stage: `breakdown (r${round}·produce)`,
	skill: "breakdown",
	status,
	ts: `t${num}`,
	...(status === "completed" ? { output: taskOutput(round, num) } : { errMsg: "boom" }),
});

const judgeRow = (round: number, num: number, isDone: boolean): WorkflowStage => ({
	stageNumber: num,
	stage: `breakdown (r${round}·judge)`,
	skill: "grade",
	status: "completed",
	ts: `t${num}`,
	output: verdictOutput(round, num, isDone),
});

function writeRun(stages: WorkflowStage[]): void {
	writeHeader(tmpDir, header);
	for (const s of stages) appendStage(tmpDir, header.runId, s);
}

// ---------------------------------------------------------------------------
// End-to-end resume paths
// ---------------------------------------------------------------------------

describe("assess-resume", () => {
	it("resume-at-judge: trailer is a completed producer → grades round n, then advances on done", async () => {
		writeRun([produceRow(0, 1, "completed")]); // died after the round-0 producer
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge round 0
				{ branch: [mockAssistantMessage("consumed")] }, // consume
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Judge grades the recovered producer handle; done → consume inherits that producer output.
		expect(chain.sentMessages).toEqual([
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "consume", status: "completed" });
	});

	it("resume-at-produce: not-done judge trailer → runs produce n+1, feedForward sees the recovered verdict (no re-grade)", async () => {
		// Round 0 fully judged not-done; the run died before the round-1 producer.
		writeRun([produceRow(0, 1, "completed"), judgeRow(0, 2, false)]);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] }, // produce round 1
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] }, // judge round 1
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// No re-grade of round 0 — the recovered verdict (fb0) feeds straight into feedForward.
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown refine round=0 fb=fb0",
			"/skill:grade .rpiv/artifacts/tasks/t1.md",
			"/skill:consume .rpiv/artifacts/tasks/t1.md",
		]);
	});

	it("resume-after-done: a done judge trailer advances downstream with no re-run", async () => {
		// Round 0 judged DONE; the run died before advancing to consume.
		writeRun([produceRow(0, 1, "completed"), judgeRow(0, 2, true)]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("consumed")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// No breakdown/grade re-run — straight to consume with the last producer output.
		expect(chain.sentMessages).toEqual(["/skill:consume .rpiv/artifacts/tasks/t0.md"]);
	});

	it("resume-at-produce-0: a failed round-0 producer re-runs produce 0 from the entry arg", async () => {
		writeRun([produceRow(0, 1, "failed")]);
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] }, // re-run produce 0
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge round 0
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Round-0 producer re-runs with the original input (breakdown is the start stage).
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown decompose this",
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
	});

	// -------------------------------------------------------------------------
	// NON-start assess stage — the entryArgsForResume primary-handle branch
	// (and its corrupted-trail guard). review (produces "seed") → breakdown
	// (assess) → consume.
	// -------------------------------------------------------------------------

	const seedOutput = (num: number): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(".rpiv/artifacts/seed/s0.md"), role: "primary" }],
		data: {},
		meta: { stage: "review", stageNumber: num, ts: "", runId: "" },
	});

	const reviewRow = (num: number): WorkflowStage => ({
		stageNumber: num,
		stage: "review",
		skill: "review",
		status: "completed",
		ts: `t${num}`,
		output: seedOutput(num),
	});

	const nonStartAssessWf: Workflow = {
		name: "decompose",
		start: "review",
		stages: {
			review: produces({ outcome: producerOutcome("seed") }),
			breakdown: produces({
				outcome: producerOutcome("tasks"),
				assess: { judge: { skill: "grade", outcome: verdictOutcome("verdict"), done }, feedForward },
			}),
			consume: acts(),
		},
		edges: { review: "breakdown", breakdown: "consume", consume: "stop" },
	} as Workflow;

	it("resume-at-produce-0 of a NON-start assess stage re-runs produce 0 from the recovered upstream primary handle", async () => {
		// review completed; the run died on the round-0 producer.
		writeRun([reviewRow(1), produceRow(0, 2, "failed")]);
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] }, // re-run produce 0
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge round 0
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: nonStartAssessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Entry arg is review's recovered primary handle, NOT the original input.
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown .rpiv/artifacts/seed/s0.md",
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
	});

	it("refuses with a recorded failure (not a crash) when the trail lacks the upstream primary a non-start assess re-entry needs", async () => {
		// Corrupted/truncated trail: the round-0 producer row exists but the upstream
		// review row is gone — the fold reconstructs NO primary artifact.
		writeRun([produceRow(0, 1, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: nonStartAssessWf, header, ref: "@x" });

		expect(result.success).toBe(false);
		// The forward ensureUpstreamArtifact halt's messages, recorded — no throw escapes.
		expect(result.error).toMatch(/no upstream artifactPath/i);
		expect(chain.sentMessages).toEqual([]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "breakdown", status: "failed" });
	});
});

// ---------------------------------------------------------------------------
// Boundary determinism guard (direct) — the assess tag is structural
// (`r{n}·{phase}`), so a well-formed reconstructState fold always recomputes a
// matching tag; the guard defends against a corrupted trail / fold-cursor drift.
// Drive resumeAssessStage with a point whose (round, phase) disagrees with the
// recorded failed trailer and assert it refuses rather than re-running.
// ---------------------------------------------------------------------------

describe("assess-resume — boundary guard", () => {
	const makeRun = (): RunContext => ({
		cwd: tmpDir,
		runId: header.runId,
		workflow: assessWf,
		totalStages: 2,
		state: {
			originalInput: "decompose this",
			primaryArtifact: undefined,
			output: undefined,
			named: {},
			stagesCompleted: 0,
			lastAllocatedStageNumber: 3,
			telemetry: { backwardJumps: 0, droppedRoutingRows: [] },
			termination: { success: false, error: undefined },
		},
		visited: new Set(),
		maxBackwardJumps: 2,
		maxIterations: 25,
		trigger: DEFAULT_TRIGGER,
		lifecycle: new LifecycleDispatcher({}),
	});

	const stubDeps = (): AssessDeps => ({
		runStageSession: vi.fn(async () => {}),
		advanceAfter: vi.fn(async () => {}),
		captureSnapshot: vi.fn(async () => undefined),
		softStopAssess: vi.fn(),
	});

	it("recomputed pending tag ≠ failed trailer → terminal drift failure, dispatches nothing", async () => {
		writeHeader(tmpDir, header);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const run = makeRun();
		const deps = stubDeps();
		// Point says pending produce@round 3; the recorded failed trailer was judge@round 2.
		const point: AssessResumePoint = {
			entryArtifact: undefined,
			round: 3,
			lastProducerOutput: undefined,
			lastVerdict: undefined,
			phase: "produce",
		};

		await resumeAssessStage(chain.ctx, "breakdown", 5, point, "breakdown (r2·judge)", run, deps);

		// Terminal failure row written; no sub-step dispatched.
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "breakdown", status: "failed" });
		expect(run.state.termination.error).toMatch(/cannot resume/i);
		expect(chain.notifications.some((n) => n.level === "error" && /changed on resume/.test(n.msg))).toBe(true);
		expect(deps.runStageSession).not.toHaveBeenCalled();
		expect(deps.advanceAfter).not.toHaveBeenCalled();
	});

	it("recomputed pending tag == failed trailer → guard passes (re-runs the pending sub-step)", async () => {
		writeHeader(tmpDir, header);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const run = makeRun();
		const deps = stubDeps();
		// Matching: pending judge@round 2, trailer judge@round 2. Provide a producer output
		// so the judge re-entry has its input.
		run.state.primaryArtifact = { handle: fsHandle(".rpiv/artifacts/tasks/t2.md"), role: "primary" };
		const point: AssessResumePoint = {
			entryArtifact: undefined,
			round: 2,
			lastProducerOutput: taskOutput(2, 3),
			lastVerdict: undefined,
			phase: "judge",
		};

		await resumeAssessStage(chain.ctx, "breakdown", 5, point, "breakdown (r2·judge)", run, deps);

		// No drift row; the judge sub-step was dispatched via runStageSession.
		expect(run.state.termination.error).toBeUndefined();
		expect(deps.runStageSession).toHaveBeenCalledTimes(1);
	});
});

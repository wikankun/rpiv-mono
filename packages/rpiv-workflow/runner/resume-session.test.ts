/**
 * Session-backed resume — end-to-end through `resumeWorkflow`:
 *
 *   - structured dispatch: failed trailer with `session` → promotion path
 *     (switchSession); `session: null` → cold re-run (newSession);
 *   - PROMOTION: the adopted branch already announces the artifact →
 *     completed row, chain advances, nothing sent into the session
 *     (issue #70's scenario);
 *   - fallback ladder: missing `switchSession` / missing session file →
 *     notify + cold re-run;
 *   - switchSession cancellation → sessionless skipped row (mirrors the
 *     live pre-open cancellation);
 *   - REATTACH: promotion miss → REATTACH_PROMPT + waitForIdle + the
 *     standard postStage (success persists; a second failure writes a
 *     session-backed failure row, keeping the run resumable);
 *   - continue-policy stages scope promotion extraction with the PERSISTED
 *     `branchOffset`.
 *
 * The host ctx is hand-rolled (not `createMockSessionChain`) because these
 * tests script `switchSession`, which the chain fixture doesn't model.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "../api.js";
import { fs as fsHandle } from "../handle.js";
import type { WorkflowSessionContext } from "../host.js";
import {
	MSG_RESUME_PROMOTED,
	MSG_RESUME_REATTACHED,
	MSG_RESUME_SESSION_FALLBACK,
	REATTACH_PROMPT,
} from "../messages.js";
import type { CollectCtx, Outcome } from "../output-spec.js";
import {
	appendStage,
	readAllStages,
	type SessionRef,
	type WorkflowHeader,
	type WorkflowStage,
	writeHeader,
} from "../state/index.js";
import { lastMatchInBranch } from "../transcript.js";
import { typeboxSchema } from "../typebox-adapter.js";
import type { WorkflowHostContext } from "../types.js";
import { resumeWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-resume-session-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const header: WorkflowHeader = {
	runId: "2026-06-11_09-00-00-ab12",
	workflow: "wf",
	input: "ship it",
	ts: "2026-06-11T09:00:00Z",
};

/** Collector that adopts whatever artifact path the branch announced. */
const announceOutcome = (collectSpy?: (ctx: CollectCtx) => void): Outcome => ({
	collector: {
		collect: (ctx: CollectCtx) => {
			collectSpy?.(ctx);
			const m = lastMatchInBranch(ctx.branch, /\.rpiv\/artifacts\/\S+\.md/g, ctx.branchOffset);
			return m
				? { kind: "ok" as const, artifacts: [{ handle: fsHandle(m), role: "primary" as const }] }
				: { kind: "ok" as const, artifacts: [] }; // produces ⇒ contract-fatal ⇒ promotion miss
		},
	},
});

const singleStageWorkflow = (outcome: Outcome, sessionPolicy: "fresh" | "continue" = "fresh"): Workflow =>
	({
		name: "wf",
		start: "build",
		stages: { build: { kind: "produces", sessionPolicy, outcome } },
		edges: { build: "stop" },
	}) as Workflow;

/** Write a Pi-shaped session file whose header carries `id`. */
const writeSessionFile = (id: string): string => {
	const dir = join(tmpDir, "pi-sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-06-11_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd: tmpDir })}\n`);
	return file;
};

const failedRow = (session: SessionRef | null): WorkflowStage => ({
	stageNumber: 1,
	stage: "build",
	skill: "build",
	status: "failed",
	ts: "t1",
	errMsg: "interrupted",
	session,
});

const writeRun = (rows: WorkflowStage[]): void => {
	writeHeader(tmpDir, header);
	for (const r of rows) appendStage(tmpDir, header.runId, r);
};

interface Harness {
	ctx: WorkflowHostContext;
	notifications: Array<{ msg: string; level: string }>;
	/** Messages sent INTO the adopted session (reattach prompt, retry fixes). */
	sentIntoSession: string[];
	switchSessionSpy: ReturnType<typeof vi.fn>;
	newSessionSpy: ReturnType<typeof vi.fn>;
}

/**
 * Hand-rolled host ctx. `switchBranch` is the adopted session's LIVE branch
 * array (mutated by `onSessionSend` to simulate the agent answering);
 * `omitSwitchSession` exercises the "host cannot switch" rung. `newSession`
 * (the cold-re-run path) delivers a fresh session whose branch announces
 * `coldAnnounce` so the fallback completes the stage.
 */
function makeHarness(opts: {
	switchBranch?: unknown[];
	omitSwitchSession?: boolean;
	switchCancelled?: boolean;
	onSessionSend?: (msg: string, branch: unknown[]) => void;
	coldAnnounce?: string;
}): Harness {
	const notifications: Array<{ msg: string; level: string }> = [];
	const sentIntoSession: string[] = [];
	const ui = {
		notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
		setStatus: () => {},
	};

	const sessionCtxFor = (branch: unknown[], id: string, file: string | undefined): WorkflowSessionContext =>
		({
			cwd: tmpDir,
			hasUI: false,
			ui,
			sessionManager: {
				getBranch: () => branch,
				getSessionId: () => id,
				getSessionFile: () => file,
			},
			waitForIdle: async () => {},
			newSession: newSessionSpy,
			sendUserMessage: async (msg: string) => {
				sentIntoSession.push(msg);
				opts.onSessionSend?.(msg, branch);
			},
		}) as unknown as WorkflowSessionContext;

	const newSessionSpy = vi.fn(async (options?: { withSession?: (c: WorkflowSessionContext) => Promise<void> }) => {
		const branch = [mockAssistantMessage(opts.coldAnnounce ?? "no artifact here")];
		await options?.withSession?.(sessionCtxFor(branch, "cold-session", undefined));
		return { cancelled: false };
	});

	const switchSessionSpy = vi.fn(
		async (path: string, options: { withSession: (c: WorkflowSessionContext) => Promise<void> }) => {
			if (opts.switchCancelled) return { cancelled: true };
			await options.withSession(sessionCtxFor(opts.switchBranch ?? [], "sess-1", path));
			return { cancelled: false };
		},
	);

	const ctx = {
		cwd: tmpDir,
		hasUI: false,
		ui,
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "outer-session",
			getSessionFile: () => undefined,
		},
		waitForIdle: async () => {},
		newSession: newSessionSpy,
		...(opts.omitSwitchSession ? {} : { switchSession: switchSessionSpy }),
	} as unknown as WorkflowHostContext;

	return { ctx, notifications, sentIntoSession, switchSessionSpy, newSessionSpy };
}

const resume = (ctx: WorkflowHostContext, workflow: Workflow) => resumeWorkflow(ctx, { workflow, header, ref: "@1" });

/** Minimal WorkflowHost for the continue-policy arm (registers the dispatched skill). */
const fakeHost = () => ({
	registerCommand: () => {},
	sendUserMessage: async () => {},
	getCommands: () => [{ name: "skill:build", source: "skill" }],
});

// ---------------------------------------------------------------------------
// Promotion (issue #70)
// ---------------------------------------------------------------------------

describe("session-backed resume — promotion", () => {
	it("adopts the interrupted session's announced artifact: completed row, nothing sent, chain advances", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("done — wrote .rpiv/artifacts/impl/build.md")],
		});

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.switchSessionSpy).toHaveBeenCalledWith(file, expect.anything());
		expect(h.newSessionSpy).not.toHaveBeenCalled();
		// Promotion sends NOTHING — the old branch already carried the work.
		expect(h.sentIntoSession).toEqual([]);
		expect(h.notifications.some((n) => n.msg === MSG_RESUME_PROMOTED("build"))).toBe(true);

		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "completed"]);
		// The promoted row is session-backed by the ADOPTED session.
		expect(rows[1]?.session).toEqual({ id: "sess-1", file });
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/build.md");
	});

	it("promotion validation-exhausted halts exactly as live — session-backed failure row", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("done — wrote .rpiv/artifacts/impl/build.md")],
		});
		// The adopted artifact exists but its data fails the output schema;
		// onInvalid: "halt" skips retries → validation-exhausted.
		const workflow = {
			name: "wf",
			start: "build",
			stages: {
				build: {
					kind: "produces",
					sessionPolicy: "fresh",
					outcome: announceOutcome(),
					outputSchema: typeboxSchema(Type.Object({ impossible: Type.Literal(1) })),
					onInvalid: "halt",
				},
			},
			edges: { build: "stop" },
		} as unknown as Workflow;

		const result = await resume(h.ctx, workflow);

		expect(result.success).toBe(false);
		expect(result.error).toContain("output validation failed after retries");
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
		expect(rows[1]?.session).toEqual({ id: "sess-1", file });
	});

	it("dispatches on the structured session field: a sessionless failed trailer re-runs cold", async () => {
		writeRun([failedRow(null)]);
		const h = makeHarness({ coldAnnounce: "wrote .rpiv/artifacts/impl/cold.md" });

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.switchSessionSpy).not.toHaveBeenCalled();
		expect(h.newSessionSpy).toHaveBeenCalledTimes(1);
		// Silent arm — no fallback notice for rows that never had a session.
		expect(h.notifications.some((n) => n.msg.includes("re-running the stage"))).toBe(false);
	});

	it("continue-policy stage scopes promotion extraction with the PERSISTED branchOffset", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file, branchOffset: 1 })]);
		const collectSpy = vi.fn();
		const h = makeHarness({
			switchBranch: [
				mockAssistantMessage("PRIOR STAGE noise .rpiv/artifacts/wrong/prior.md"),
				mockAssistantMessage("done — wrote .rpiv/artifacts/impl/cont.md"),
			],
		});

		const result = await resumeWorkflow(h.ctx, {
			workflow: singleStageWorkflow(announceOutcome(collectSpy), "continue"),
			header,
			host: fakeHost(),
			ref: "@1",
		});

		expect(result.success).toBe(true);
		// The collector saw the persisted offset — not a freshly-derived one.
		expect(collectSpy.mock.calls[0]?.[0]?.branchOffset).toBe(1);
		// And the offset kept the prior stage's announcement out of the result.
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/cont.md");
	});
});

// ---------------------------------------------------------------------------
// Fallback ladder
// ---------------------------------------------------------------------------

describe("session-backed resume — fallback ladder", () => {
	it("host without switchSession → notify + cold re-run", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({ omitSwitchSession: true, coldAnnounce: "wrote .rpiv/artifacts/impl/cold.md" });

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.newSessionSpy).toHaveBeenCalledTimes(1);
		expect(
			h.notifications.some((n) => n.msg === MSG_RESUME_SESSION_FALLBACK("build", "host cannot switch sessions")),
		).toBe(true);
	});

	it("session file gone (deleted / different machine) → notify + cold re-run", async () => {
		writeRun([failedRow({ id: "sess-1", file: join(tmpDir, "gone", "x_sess-1.jsonl") })]);
		const h = makeHarness({ coldAnnounce: "wrote .rpiv/artifacts/impl/cold.md" });

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.switchSessionSpy).not.toHaveBeenCalled();
		expect(h.newSessionSpy).toHaveBeenCalledTimes(1);
		expect(
			h.notifications.some((n) => n.msg === MSG_RESUME_SESSION_FALLBACK("build", "session file not found")),
		).toBe(true);
	});

	it("switchSession cancelled by the user → sessionless skipped row (mirrors live pre-open cancellation)", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({ switchCancelled: true });

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(false);
		expect(result.termination?.status).toBe("cancelled");
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[1]?.status).toBe("skipped");
		expect(rows[1]?.session).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Reattach (promotion miss → continue the session from its leaf)
// ---------------------------------------------------------------------------

describe("session-backed resume — reattach", () => {
	it("promotion miss → REATTACH_PROMPT into the session; agent finishes; normal success path", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("was mid-work, no artifact yet")],
			onSessionSend: (msg, branch) => {
				// The nudged agent finishes and announces.
				if (msg === REATTACH_PROMPT("build")) {
					branch.push(mockAssistantMessage("finished — wrote .rpiv/artifacts/impl/late.md"));
				}
			},
		});

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.sentIntoSession).toEqual([REATTACH_PROMPT("build")]);
		expect(h.notifications.some((n) => n.msg === MSG_RESUME_REATTACHED("build"))).toBe(true);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "completed"]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/late.md");
	});

	it("reattach second failure → session-backed failure row (the run stays resumable)", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		// Agent never announces — promotion misses AND the reattached turn
		// still produces nothing (produces-contract fatal).
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("was mid-work, no artifact yet")],
			onSessionSend: (_msg, branch) => {
				branch.push(mockAssistantMessage("sorry, still nothing"));
			},
		});

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(false);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
		// The new failure row carries the adopted session — resumable again.
		expect(rows[1]?.session).toEqual({ id: "sess-1", file });
	});
});

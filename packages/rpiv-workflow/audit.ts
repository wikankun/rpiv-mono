/**
 * Audit / bookkeeping — JSONL writes, status-line clears, notify, and
 * `state.termination.error` for terminal outcomes. Shared by runner.ts + sessions.ts;
 * neither imports back. Depends only on state + messages.
 */

import { handleToString } from "./handle.js";
import { assertNever } from "./internal-utils.js";
import { buildLifecycleContext, scriptStageRef, skillStageRef } from "./lifecycle.js";
import {
	ERR_STAGE_ABORTED,
	ERR_STAGE_NO_RESPONSE,
	ERR_STAGE_TOOL_STALLED,
	ERR_STAGE_TRUNCATED,
	MSG_FAILURE_ROW_DROPPED,
	MSG_PARTIAL_ARTIFACTS,
	MSG_STAGE_ABORTED,
	MSG_STAGE_FAILED,
	MSG_STAGE_NO_RESPONSE,
	MSG_STAGE_TOOL_STALLED,
	MSG_STAGE_TRUNCATED,
	MSG_WORKFLOW_CANCELLED,
	STATUS_KEY,
} from "./messages.js";
import { appendStage, listArtifacts, type WorkflowStage } from "./state/index.js";
import type { StopSignal } from "./transcript.js";
import type { RunContext, RunState, SessionContext, UnitRef, WorkflowHostContext } from "./types.js";

/** Single source of ISO-8601 timestamps for audit rows + output meta. */
export const nowIso = (): string => new Date().toISOString();

/**
 * Minimal bookkeeping ctx. Structurally derived from `SessionContext` so any
 * future field added to the base lands here too — no duplicate
 * maintenance. Every `StageSession` (single stage or loop unit) collapses to this.
 *
 * `isScript` toggles the `onStageError` ref construction in
 * `recordTerminalFailure` from `skillStageRef` to `scriptStageRef` (the
 * script branch carries no `skill` field). Defaulting to `undefined`
 * preserves the skill-path behaviour for every existing caller.
 *
 * `unit` is present iff the failure/cancellation belongs to a loop unit — its
 * identity is spread into the JSONL row so failed trailers carry the
 * structured fields the resume guard consumes.
 */
export type AuditCtx = Pick<
	SessionContext,
	"cwd" | "runId" | "state" | "stageName" | "skill" | "lifecycle" | "runIdentity" | "allocatedStageNumber"
> & {
	isScript?: boolean;
	unit?: UnitRef;
};

/**
 * The read-only run identity (`workflow` name + `totalStages` + `trigger`)
 * threaded onto every `SessionContext` and `AuditCtx`. Single source for the
 * `runIdentity` sub-literal that session/audit constructions across the runner
 * would otherwise re-spell by hand.
 */
export function runIdentityOf(run: RunContext): SessionContext["runIdentity"] {
	return { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger };
}

/**
 * Build the `AuditCtx` `recordTerminalFailure` needs for a stage failure that
 * escaped a session (preflight halts, downstream throws, routing errors,
 * resume-time refusals). One source for the shape so every halt path records
 * a uniform row. `isScript: true` drops the `skill` field from the JSONL row
 * and switches `onStageError` to `scriptStageRef`.
 */
export function auditCtxFor(
	run: RunContext,
	stageName: string,
	skill: string,
	opts?: { isScript?: boolean; unit?: UnitRef; allocatedStageNumber?: number },
): AuditCtx {
	return {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		stageName,
		skill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		...(opts?.isScript ? { isScript: true } : {}),
		...(opts?.unit ? { unit: opts.unit } : {}),
		...(opts?.allocatedStageNumber !== undefined ? { allocatedStageNumber: opts.allocatedStageNumber } : {}),
	};
}

/**
 * Lifecycle ref for the CURRENT activation — ONE numbering base (the
 * allocator value) for every event of one execution, so a listener can
 * correlate a retry ref with the end/error ref it belongs to. Valid once the
 * activation allocated its number (`allocatedStageNumber`); falls back to the
 * last allocated number for record-time allocators (failure paths that never
 * reached output production).
 */
export function currentStageRef(
	s: Pick<SessionContext, "stageName" | "skill" | "state" | "allocatedStageNumber">,
): ReturnType<typeof skillStageRef> {
	return skillStageRef(s.stageName, s.allocatedStageNumber ?? s.state.lastAllocatedStageNumber, s.skill);
}

/**
 * DISPLAY decoration for a loop-unit row's `stage` value —
 * `"implement (phase-2)"`, `"breakdown (r0·judge)"`. Pure human label: the
 * machine channel is the structured `parent`/`role`/`unitId`/`unitIndex`
 * fields (`unitRowFields`); nothing may parse this string back. The driver
 * builds the tag (`unit.id ?? unit.label` for fanout/iterate;
 * `r{round}·{phase}` for assess) and decorates once at session construction.
 */
export const decorateStage = (parent: string, tag: string): string => `${parent} (${tag})`;

/**
 * Project a session's unit identity into the structured row fields. Returns
 * `{}` for single stages so call sites spread unconditionally —
 * `JSON.stringify` drops nothing because nothing is added.
 */
export function unitRowFields(
	unit: UnitRef | undefined,
): Pick<WorkflowStage, "parent" | "role" | "unitId" | "unitIndex"> {
	if (!unit) return {};
	return { parent: unit.parent, role: unit.role, unitId: unit.id, unitIndex: unit.index };
}

/**
 * Advance the monotonic stage-number allocator and return the assigned
 * number. Call ONCE per stage activation, BEFORE the activation's output
 * envelope is built — the envelope's `meta.stageNumber`, the JSONL row, and
 * every lifecycle ref for the activation then share one explicit value
 * instead of peeking `lastAllocatedStageNumber + 1` and relying on a
 * "no record in between" convention.
 */
export function allocateStageNumber(state: RunState): number {
	state.lastAllocatedStageNumber += 1;
	return state.lastAllocatedStageNumber;
}

/**
 * Attempts the append and returns the assigned `stageNumber` on success (or
 * undefined on I/O failure). The number comes from `preAllocated` when the
 * activation already ran `allocateStageNumber` (output-producing paths), or
 * is allocated here (pre-output halts). Either way the allocator advances
 * monotonically — once per activation — so a transient failure doesn't cause
 * the next stage to reuse the lost row's number. Higher-level counters
 * (e.g. `stagesCompleted`) gate on the returned value being defined.
 */
export function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunState,
	preAllocated?: number,
): number | undefined {
	const stageNumber = preAllocated ?? allocateStageNumber(state);
	return appendStage(cwd, runId, { stageNumber, ...stage }) ? stageNumber : undefined;
}

/** Surface every artifact recorded so far — recap on stage failure. */
export function notifyPartialArtifacts(ctx: WorkflowHostContext, cwd: string, runId: string): void {
	const items = listArtifacts(cwd, runId);
	if (items.length === 0) return;
	const artifactList = items.map((i) => `  • ${i.stage}: ${handleToString(i.artifact.handle)}`).join("\n");
	ctx.ui.notify(MSG_PARTIAL_ARTIFACTS(artifactList), "info");
}

export async function recordTerminalFailure(
	ctx: WorkflowHostContext,
	audit: AuditCtx,
	args: {
		status: "failed" | "aborted";
		notifyMsg: string;
		notifyLevel: "warning" | "error";
		errMsg: string;
	},
	onFailure?: (ctx: WorkflowHostContext) => void,
): Promise<void> {
	const written = recordStage(
		audit.cwd,
		audit.runId,
		// Script-stage failure rows omit `skill` (the row split landed in A.0);
		// skill rows continue to carry it. `undefined` is dropped by JSON.stringify.
		// `errMsg` mirrors `state.termination.error` so the failure reason
		// survives in JSONL even when the `ctx.ui.notify` toast is missed.
		{
			stage: audit.stageName,
			skill: audit.isScript ? undefined : audit.skill,
			status: args.status,
			ts: nowIso(),
			errMsg: args.errMsg,
			...unitRowFields(audit.unit),
		},
		audit.state,
		// Reuse the activation's pre-allocated number when output production
		// already burned one — the failure row carries the SAME stage number
		// the activation's output/lifecycle refs used (no gap, no skew).
		audit.allocatedStageNumber,
	);
	if (written === undefined) {
		// A dropped FAILURE row corrupts resume: the trail's last row reads
		// "completed" and a resume would route onward past this stage. The run
		// is already halting — surface loudly + flag the envelope so callers
		// know the trail is unsafe to resume from.
		ctx.ui.notify(MSG_FAILURE_ROW_DROPPED(audit.stageName), "warning");
		audit.state.telemetry.droppedFailureRows.push(audit.stageName);
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(args.notifyMsg, args.notifyLevel);
	onFailure?.(ctx);
	audit.state.termination.error = args.errMsg;
	const ref = audit.isScript
		? scriptStageRef(audit.stageName, audit.state.lastAllocatedStageNumber)
		: skillStageRef(audit.stageName, audit.state.lastAllocatedStageNumber, audit.skill);
	await audit.lifecycle.fire(
		ctx,
		"onStageError",
		ref,
		args.errMsg,
		buildLifecycleContext({
			cwd: audit.cwd,
			runId: audit.runId,
			workflow: audit.runIdentity.workflow,
			totalStages: audit.runIdentity.totalStages,
			trigger: audit.runIdentity.trigger,
			state: audit.state,
		}),
	);
}

/**
 * One arm per StopSignal variant (minus `"stop"`, the success path).
 * JSONL `status` stays `"aborted" | "failed"` for downstream-reader
 * compatibility; the per-signal distinction surfaces via MSG_STAGE_*
 * and state.termination.error.
 */
export async function recordStopFailure(
	ctx: WorkflowHostContext,
	audit: AuditCtx,
	stop: Exclude<StopSignal, "stop">,
	errorMessage: string,
	onFailure?: (ctx: WorkflowHostContext) => void,
): Promise<void> {
	await recordTerminalFailure(ctx, audit, stopFailureArgs(audit.skill, stop, errorMessage), onFailure);
}

function stopFailureArgs(
	skill: string,
	stop: Exclude<StopSignal, "stop">,
	errorMessage: string,
): {
	status: "failed" | "aborted";
	notifyMsg: string;
	notifyLevel: "warning" | "error";
	errMsg: string;
} {
	switch (stop) {
		case "aborted":
			return {
				status: "aborted",
				notifyMsg: MSG_STAGE_ABORTED(skill),
				notifyLevel: "warning",
				errMsg: ERR_STAGE_ABORTED(skill),
			};
		case "length":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_TRUNCATED(skill),
				notifyLevel: "error",
				errMsg: ERR_STAGE_TRUNCATED(skill),
			};
		case "toolUse":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_TOOL_STALLED(skill),
				notifyLevel: "error",
				errMsg: ERR_STAGE_TOOL_STALLED(skill),
			};
		case "noResponse":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_NO_RESPONSE(skill),
				notifyLevel: "error",
				errMsg: ERR_STAGE_NO_RESPONSE(skill),
			};
		case "error":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_FAILED(skill),
				notifyLevel: "error",
				errMsg: errorMessage,
			};
		default:
			return assertNever(stop);
	}
}

export function recordCancellation(ctx: WorkflowHostContext, audit: AuditCtx): void {
	// `success: false` alone can't distinguish "cancelled" from "never started";
	// the error string is the signal. Mirrored into the JSONL row's `errMsg`
	// so post-mortems work from the trail alone (same posture as
	// `recordTerminalFailure`).
	const errMsg = `${audit.skill} cancelled by user`;
	recordStage(
		audit.cwd,
		audit.runId,
		{
			stage: audit.stageName,
			skill: audit.skill,
			status: "skipped",
			ts: nowIso(),
			errMsg,
			...unitRowFields(audit.unit),
		},
		audit.state,
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	audit.state.termination.error = errMsg;
}

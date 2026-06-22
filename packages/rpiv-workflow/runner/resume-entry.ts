/**
 * Resume entry selection — translate a reconstructed trail (`resume.ts`)
 * into the chain re-entry thunk `resumeWorkflow` hands to `executeRun`, plus
 * the refusal-reason rendering for a reconstruct that declined. Companion to
 * `resume-loop.ts` (which owns the loop-trailer arm's dispatch).
 */

import {
	ERR_RESUME_MALFORMED_ROW,
	ERR_RESUME_NO_ROWS,
	ERR_RESUME_STAGE_GONE,
	ERR_RESUME_VERSION_MISMATCH,
} from "../messages.js";
import { STATE_SCHEMA_VERSION } from "../state/index.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import { recordEntryThrow } from "./failure.js";
import type { ReconstructResult } from "./resume.js";
import { recordLoopDriftFailure, resumeLoopStage } from "./resume-loop.js";
import { advance, buildLoopDeps, resumeStageWithSession, runStageOrRecordFailure } from "./run-stage.js";

/**
 * Pick the chain re-entry thunk from the trail trailer. Dispatch keys on the
 * STRUCTURED `parent` field — no string matching, no per-primitive arms:
 *   - fold-detected drift → record the parent-attributed terminal failure
 *     (zero dispatch; lifecycle bracketing identical to every other entry);
 *   - trailing unit row → re-enter the loop with the fold's cursor;
 *   - completed normal trailer → route onward (finished run hits stop ⇒ no-op);
 *   - failed/aborted trailer → session-backed rows try promotion/reattach
 *     (`resumeStageWithSession`); sessionless rows re-run cold (today's
 *     behavior). Dispatch keys on the STRUCTURED `session` field, mirroring
 *     the `parent !== undefined` arm.
 */
export function selectResumeEntry(
	ctx: WorkflowHostContext,
	recon: Extract<ReconstructResult, { ok: true }>,
	run: RunContext,
): () => Promise<unknown> {
	if (recon.drift) {
		const { parent, errMsg } = recon.drift;
		return () => recordLoopDriftFailure(ctx, run, parent, errMsg);
	}

	// The fold's reconstructed chain index — NOT `stageNumber - 1`: the
	// allocator counts every row including loop units, so past any loop the
	// two diverge (a 10-unit loop would resume showing "stage 14/5").
	const last = recon.rows[recon.rows.length - 1]!;
	const idx = recon.lastChainIndex; // status-line / routing index; JSONL number comes from the allocator

	if (last.parent !== undefined) {
		// `recon.trailing` is set by construction: the fold always produces a
		// trailing point for an open generation, and a unit-row trailer means
		// the generation is open.
		return () =>
			guardResumeEntry(ctx, last.parent!, run, () =>
				resumeLoopStage(ctx, recon.trailing!, idx, run, buildLoopDeps()),
			);
	}
	if (last.status === "completed") {
		// route onward; finished run ⇒ hits stop ⇒ no-op
		return () => guardResumeEntry(ctx, last.stage, run, () => advance(ctx, last.stage, idx, run));
	}
	// failed/aborted trailer — session-backed rows try promotion/reattach,
	// sessionless rows re-run cold (today's behavior).
	return last.session !== null
		? () => resumeStageWithSession(ctx, last, idx, run)
		: () => runStageOrRecordFailure(ctx, last.stage, idx, run);
}

/**
 * Resume-entry counterpart of `runStageOrRecordFailure`'s catch. The live
 * chain reaches user fns (loop `next`/`done`/`feedForward`, judge prompts,
 * route predicates) only under that catch; the resume-loop and route-onward
 * entry thunks call the same fns directly, so a throw would otherwise escape
 * `executeRun` as a raw rejection — `onWorkflowEnd` never fires and the
 * caller loses the result envelope.
 */
async function guardResumeEntry(
	curCtx: WorkflowHostContext,
	name: string,
	run: RunContext,
	entry: () => Promise<unknown>,
): Promise<void> {
	try {
		await entry();
	} catch (e) {
		await recordEntryThrow(curCtx, name, run, e);
	}
}

export function resumeRefusalError(recon: Extract<ReconstructResult, { ok: false }>, workflow: string): string {
	switch (recon.reason) {
		case "no-rows":
			return ERR_RESUME_NO_ROWS(recon.detail);
		case "stage-gone":
			return ERR_RESUME_STAGE_GONE(recon.detail, workflow);
		case "malformed-row":
			return ERR_RESUME_MALFORMED_ROW(recon.detail);
		case "version-mismatch":
			return ERR_RESUME_VERSION_MISMATCH(recon.detail, STATE_SCHEMA_VERSION);
	}
}

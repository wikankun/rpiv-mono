/**
 * Assess-resume dispatch. When a resumed run's trail trailer is a `def.assess`
 * round row (`r{n}·produce` / `r{n}·judge`), `resumeWorkflow` routes here instead
 * of the single-stage arms.
 *
 * Re-enters the producer→judge loop at the pending sub-step the reconstruction
 * fold computed (`reconstructState`'s `assessProgress` — the TRAILING generation
 * only). Unlike fanout/iterate (one sub-step kind), assess has two, so the
 * re-entry forks:
 *   - pending JUDGE → call `runJudgeRound` directly with the last producer's
 *     output/artifact (recovered by the fold), grading round `n` WITHOUT
 *     re-running the producer;
 *   - pending PRODUCE → either advance downstream (a completed judge's verdict is
 *     `done`) or re-enter `runAssess` at round `n` (feeding the recovered verdict
 *     forward via `feedForward`, no re-grade).
 *
 * REQUIRES `feedForward` + `judge.done` to be deterministic w.r.t. their inputs.
 * Completed sub-steps are trusted, never replayed; only the pending sub-step runs.
 * The ONE checkable boundary — a failed trailer's recorded decoration vs. the
 * recomputed pending tag — is guarded; on drift, terminal failure rather than a
 * wrong re-run (mirror `resume-iterate.ts`).
 *
 * `deps` are injected by `resumeWorkflow` (the same primitives `tryAssess` injects),
 * so this module mirrors `runAssess`'s primitive-injection shape and imports no cycle
 * back into the session layer.
 */

import type { StageDef } from "../api.js";
import type { AssessDeps } from "../assess.js";
import { runAssess, runJudgeRound } from "../assess.js";
import { assessRowStage, auditCtxFor, recordTerminalFailure } from "../audit.js";
import { handleToString } from "../handle.js";
import { currentPrimaryArtifact, resolveSkill } from "../internal-utils.js";
import { skillStageRef } from "../lifecycle.js";
import {
	ERR_MISSING_ARTIFACT,
	ERR_RESUME_ASSESS_MISMATCH,
	MSG_MISSING_ARTIFACT,
	MSG_RESUME_ASSESS_MISMATCH,
} from "../messages.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import type { AssessResumePoint } from "./resume.js";
import { lifecycleCtxFor } from "./runner.js";

/**
 * Resume an assess stage at the sub-step the fold marked pending. `point` is
 * `reconstructState`'s `assessProgress` entry for this parent. `pendingDecorated`
 * is the failed/aborted trailer row's decorated `stage` string when the run died
 * ON a sub-step (the boundary-guard input); undefined when the trailer was a
 * COMPLETED row (a completed producer awaiting its judge, or a completed judge
 * whose verdict drives advance-vs-continue).
 *
 * `idx` is the display/audit index (the trailer row's `stageNumber - 1`),
 * consistent with the single-stage arms. Routing keys on the parent NAME, not `idx`.
 */
export async function resumeAssessStage(
	ctx: WorkflowHostContext,
	parent: string,
	idx: number,
	point: AssessResumePoint,
	pendingDecorated: string | undefined,
	run: RunContext,
	deps: AssessDeps,
): Promise<void> {
	const def = run.workflow.stages[parent]!; // caller verified parent is an assess stage
	const skill = resolveSkill(def, parent); // mirror resolveStage; aliased nodes tag rows with the skill body

	// Boundary determinism guard: a run that died ON a sub-step recorded that
	// sub-step's decoration. The fold's cursor must recompute the same pending tag;
	// a mismatch means the trail and the cursor disagree (a corrupted trail or a
	// fold bug) — refuse rather than re-run the wrong sub-step (mirror resume-iterate.ts:60-66).
	if (pendingDecorated !== undefined) {
		const recomputed = assessRowStage(parent, point.round, point.phase);
		if (recomputed !== pendingDecorated) {
			await recordAssessDriftFailure(ctx, run, parent, skill);
			return;
		}
	}

	// Round-0 producer arg, recomputed the way `tryAssess` does (see helper). Only
	// load-bearing on the re-run-produce-round-0 path; harmless elsewhere. The
	// forward path's `ensureUpstreamArtifact` preflight guaranteed the primary at
	// entry, so a missing one here means the trail no longer carries the upstream
	// produces row — refuse with a recorded failure rather than crash (mirror the
	// drift guard's posture; `executeRun` does not catch resume-entry throws).
	const entryArgs = entryArgsForResume(parent, def, run);
	if (entryArgs === undefined) {
		await recordAssessMissingArtifactFailure(ctx, run, parent, skill, idx);
		return;
	}

	// Pending JUDGE — the producer for `point.round` completed (or a judge failed);
	// re-grade WITHOUT re-running the producer. The fold left `state.output` and the
	// rolling primary on that producer, so they are the judge's input. A completed
	// produce row always rolls the primary (>=1-artifact completion contract), so a
	// missing one is the same corrupted-trail case as above.
	if (point.phase === "judge") {
		const producerArtifact = currentPrimaryArtifact(run.state);
		if (producerArtifact === undefined) {
			await recordAssessMissingArtifactFailure(ctx, run, parent, skill, idx);
			return;
		}
		await run.lifecycle.fire(ctx, "onStageStart", skillStageRef(parent, idx + 1, skill), lifecycleCtxFor(run));
		await runJudgeRound(
			ctx,
			idx,
			parent,
			skill,
			def,
			point.entryArtifact,
			entryArgs,
			point.round,
			point.lastProducerOutput!,
			producerArtifact,
			run,
			deps,
		);
		return;
	}

	// Pending PRODUCE. A COMPLETED judge trailer (pendingDecorated undefined) carries
	// a verdict the fold stashed as `lastVerdict`: re-check `judge.done` — done ⇒ the
	// original run already advanced downstream, so advance with no re-run (the all-done
	// fast path); not-done ⇒ run the next producer round. A FAILED producer trailer
	// re-runs that producer round (its prior round's verdict was already not-done).
	const trailerCompleted = pendingDecorated === undefined;
	if (trailerCompleted && point.lastVerdict !== undefined && def.assess!.judge.done(point.lastVerdict)) {
		await deps.advanceAfter(ctx, parent, idx, run);
		return;
	}

	// Round 0 uses the recomputed entry arg (no prior pair); later rounds feed the
	// just-recovered (producer, verdict) pair forward via `feedForward` inside runAssess.
	const prev = point.round === 0 ? undefined : { output: point.lastProducerOutput!, verdict: point.lastVerdict! };
	await run.lifecycle.fire(ctx, "onStageStart", skillStageRef(parent, idx + 1, skill), lifecycleCtxFor(run));
	await runAssess(ctx, idx, parent, skill, def, point.entryArtifact, entryArgs, point.round, prev, run, deps);
}

/**
 * Recompute the round-0 producer arg the way `tryAssess` does via `inputForStage`
 * (stage-lifecycle.ts) — minus the `reads` branch, which v1 validation rejects for
 * assess. Load-bearing only when re-running round-0 produce (no producer has rolled
 * the primary yet, so it still points at the stage-entry artifact); harmlessly
 * recomputed-but-unused on the judge / later-round paths (which build their arg from
 * `feedForward`).
 *
 * Returns `undefined` when a non-start, inheriting stage has no primary — the
 * forward `ensureUpstreamArtifact` preflight made that impossible at entry, so on
 * resume it means a corrupted trail; the caller records a terminal failure.
 */
function entryArgsForResume(parent: string, def: StageDef, run: RunContext): string | undefined {
	if (parent === run.workflow.start) return run.state.originalInput;
	if (def.inheritsArtifacts === false) return run.state.originalInput;
	const primary = currentPrimaryArtifact(run.state);
	return primary === undefined ? undefined : handleToString(primary.handle);
}

/**
 * Record the terminal failure when the reconstructed state lacks the upstream
 * primary an assess re-entry needs (corrupted/truncated trail) — the resume
 * mirror of the forward `ensureUpstreamArtifact` halt, reusing its messages.
 */
function recordAssessMissingArtifactFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
	idx: number,
): Promise<void> {
	return recordTerminalFailure(ctx, auditCtxFor(run, parent, skill), {
		status: "failed",
		notifyMsg: MSG_MISSING_ARTIFACT(skill),
		notifyLevel: "error",
		errMsg: ERR_MISSING_ARTIFACT(skill, idx + 1),
	});
}

/** Record the terminal failure for a drifted assess resume (boundary tag mismatch). */
function recordAssessDriftFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
): Promise<void> {
	return recordTerminalFailure(ctx, auditCtxFor(run, parent, skill), {
		status: "failed",
		notifyMsg: MSG_RESUME_ASSESS_MISMATCH(parent),
		notifyLevel: "error",
		errMsg: ERR_RESUME_ASSESS_MISMATCH(parent),
	});
}

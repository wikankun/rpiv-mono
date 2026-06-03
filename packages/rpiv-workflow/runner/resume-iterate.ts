/**
 * Iterate-resume dispatch. When a resumed run's trail trailer is a `def.iterate`
 * unit row, `resumeWorkflow` routes here instead of the single-stage arms.
 *
 * Re-enters `runIterate` at the next pull index using the reconstructed entry
 * artifact + accumulated prefix (`reconstructState`'s `iterateProgress` — the
 * TRAILING generation only). The pull model re-derives each remaining unit from
 * `accumulated`, so resume only needs the prefix, not a stored unit list.
 *
 * REQUIRES the IterateFn to be deterministic w.r.t. its entry artifact +
 * accumulated outputs. We guard the ONE checkable boundary: a failed trailer unit
 * recorded the decoration of the unit that was about to run, so the re-pulled unit
 * at `index = accumulated.length` must match it. Earlier completed units are NOT
 * replayed (the generator sees a mutating `state` per unit; faithful intermediate
 * replay is infeasible) — the contract covers them.
 *
 * `deps` are injected by `resumeWorkflow` (the same primitives `tryIterate` injects),
 * so this module mirrors `runIterate`'s primitive-injection shape and imports no cycle
 * back into the session layer.
 */

import type { IterateUnit, StageDef } from "../api.js";
import { auditCtxFor, iterateRowStage, recordTerminalFailure } from "../audit.js";
import type { IterateDeps } from "../iterate.js";
import { runIterate } from "../iterate.js";
import { skillStageRef } from "../lifecycle.js";
import { ERR_RESUME_ITERATE_MISMATCH, MSG_RESUME_ITERATE_MISMATCH } from "../messages.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import type { IterateResumePoint } from "./resume.js";
import { lifecycleCtxFor } from "./runner.js";

/**
 * Resume an iterate stage whose trailing-generation units are a completed prefix
 * `1..k` (with the failure/cutoff at `k+1`). `point` is `reconstructState`'s
 * `iterateProgress` entry for this parent. `pendingDecorated` is the failed trailer
 * unit's decorated `stage` string when the run died ON a unit (the boundary-guard
 * input); undefined when the process died between units (no recorded next unit).
 *
 * `idx` is the display/audit index (the trailer unit row's `stageNumber - 1`),
 * consistent with the single-stage arms. Routing keys on the parent NAME, not `idx`.
 */
export async function resumeIterateStage(
	ctx: WorkflowHostContext,
	parent: string,
	idx: number,
	point: IterateResumePoint,
	pendingDecorated: string | undefined,
	run: RunContext,
	deps: IterateDeps,
): Promise<void> {
	const def = run.workflow.stages[parent]!; // caller verified parent is an iterate stage
	const skill = def.skill ?? parent; // mirror resolveStage; aliased nodes tag rows with the skill body

	// Pre-pull the next unit ONCE to branch: drift-guard + already-complete no-op.
	const next = await pullNextUnit(def, point, run);

	// Boundary determinism guard: if the run died on a unit, the recomputed unit must
	// match the recorded decoration. A different (or null) unit means the IterateFn drifted.
	if (pendingDecorated !== undefined) {
		const recomputed = next ? iterateRowStage(parent, next.id ?? next.label) : undefined;
		if (recomputed !== pendingDecorated) {
			await recordIterateDriftFailure(ctx, run, parent, skill);
			return;
		}
	}

	// Generation already complete (generator now terminates at index=accumulated.length)
	// → route onward, no re-announce, no toast (mirror fanout's silent no-op path).
	if (!next) {
		await deps.advanceAfter(ctx, parent, idx, run);
		return;
	}

	// Re-fire onStageStart for listener coherence (mirror tryIterate; onStageEnd fires
	// per unit inside runStageSession). Then re-enter the pull loop — runIterate re-pulls
	// the same unit (a second, harmless deterministic call) and runs the remaining units;
	// advanceAfter → advanceChain carries the chain onward.
	await run.lifecycle.fire(ctx, "onStageStart", skillStageRef(parent, idx + 1, skill), lifecycleCtxFor(run));
	await runIterate(ctx, idx, parent, skill, def, point.entryArtifact, point.accumulated, run, deps);
}

/** Re-derive the unit at the resume index — the same call `runIterate` makes (idempotent, deterministic). */
function pullNextUnit(
	def: StageDef,
	point: IterateResumePoint,
	run: RunContext,
): Promise<IterateUnit | null> | IterateUnit | null {
	return def.iterate!({
		cwd: run.cwd,
		artifact: point.entryArtifact,
		state: run.state,
		accumulated: point.accumulated,
		index: point.accumulated.length,
	});
}

/** Record the terminal failure for a non-deterministic IterateFn (boundary drift). */
function recordIterateDriftFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
): Promise<void> {
	return recordTerminalFailure(ctx, auditCtxFor(run, parent, skill), {
		status: "failed",
		notifyMsg: MSG_RESUME_ITERATE_MISMATCH(parent),
		notifyLevel: "error",
		errMsg: ERR_RESUME_ITERATE_MISMATCH(parent),
	});
}

/**
 * Fanout iteration. When a node opts in via `NodeDef.fanout`, the runner
 * calls the user's `FanoutFn` to get a list of units and iterates one Pi
 * session per unit. This module owns the iteration loop; `runner.ts`
 * injects its primitives via `PhaseFanoutDeps` so the module never
 * imports back (cycle-free).
 *
 * No markdown regex, no per-convention counter, no cap — rpiv-workflow
 * stays convention-agnostic. Consumers (rpiv-pi etc.) own the FanoutFn
 * body and any safety bounds it needs.
 */

import type { FanoutUnit } from "./api.js";
import { MSG_STAGE_COMPLETE, STATUS_KEY, STATUS_PHASE } from "./messages.js";
import type { PhaseSession, RunContext, RunnerCtx } from "./types.js";

export interface PhaseFanoutDeps {
	runPhaseSession: (ctx: RunnerCtx, session: PhaseSession) => Promise<void>;
	/**
	 * Resume the chain after the fanout node's units finish. Receives the
	 * fanout node's name so the routing layer can look up the outgoing
	 * edge from it.
	 */
	advanceAfter: (curCtx: RunnerCtx, completedName: string, completedIdx: number, run: RunContext) => Promise<void>;
}

/**
 * `skill` is the bundled skill body (threaded by the runner), not the node
 * name. Aliased nodes (e.g. `implement-after-revise` invoking `implement`)
 * tag unit rows + prompts with the skill body so audit consumers don't see
 * two labels for the same work. Caller verifies node + fanout shape before
 * invoking (see `runStage`).
 *
 * `currentName` is the fanout node's name in the workflow — passed to
 * `advanceAfter` once the final unit completes so the routing layer can
 * look up the outgoing edge from it.
 *
 * `units` was already produced by the user's `FanoutFn`; the iteration loop
 * walks it in order. `p` is the 1-based index into `units` for the next
 * session to run — the continuation-style self-call increments it.
 */
export async function runImplementPhases(
	curCtx: RunnerCtx,
	stageIdx: number,
	currentName: string,
	skill: string,
	p: number,
	units: readonly FanoutUnit[],
	run: RunContext,
	deps: PhaseFanoutDeps,
): Promise<void> {
	const { cwd, runId, totalStages, state } = run;

	if (p > units.length) {
		curCtx.ui.notify(MSG_STAGE_COMPLETE(skill), "info");
		await deps.advanceAfter(curCtx, currentName, stageIdx, run);
		return;
	}

	const unit = units[p - 1]!;
	curCtx.ui.setStatus(STATUS_KEY, STATUS_PHASE(stageIdx + 1, totalStages, skill, unit.label));

	await deps.runPhaseSession(curCtx, {
		cwd,
		runId,
		state,
		prompt: `/skill:${skill} ${unit.prompt}`,
		skill,
		unitIndex: p,
		label: unit.label,
		stageIndex: stageIdx,
		onSuccess: (freshCtx) => runImplementPhases(freshCtx, stageIdx, currentName, skill, p + 1, units, run, deps),
	});
}

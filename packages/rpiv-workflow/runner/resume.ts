/**
 * State reconstruction for resuming a failed (or cut-off) workflow run.
 * Pure fold over the JSONL audit trail — no I/O beyond `readAllStages`.
 *
 * Used by `resumeWorkflow` (runner.ts) to rebuild `RunState` from a past
 * run's stage rows, then re-enter the chain machinery at the right seam.
 * New rows **append to the same JSONL file** so the trail reads as one
 * story: *ran → failed → resumed → continued*.
 *
 * Folds `def.fanout` unit rows so fanout runs are resumable; this REQUIRES the
 * stage's FanoutFn to be deterministic w.r.t. its entry artifact (the resume
 * dispatch re-calls it and guards the unit prefix — see `resume-fanout.ts`). The
 * fold is generation-aware: a looped fanout records only the TRAILING generation's
 * unit prefix, so a second-pass resume compares against the right pass.
 * Folds `def.iterate` unit rows as full produces passes (each unit ran the
 * produces path on the live run, so its `Output` is persisted in the row): it
 * rolls the primary, appends to `state.named`, and rebuilds the trailing
 * generation's `accumulated` prefix + frozen entry artifact for the resume
 * dispatch. This REQUIRES the IterateFn to be deterministic w.r.t. its entry
 * artifact + accumulated outputs — `resume-iterate.ts` guards only the ONE
 * checkable boundary (the re-pulled next unit vs the failed trailer's recorded
 * decoration); the already-completed prefix is covered by that contract, not
 * replayed (the generator sees a mutating `state` per unit, so faithful
 * intermediate replay is infeasible).
 */

import type { StageDef, Workflow } from "../api.js";
import type { Artifact } from "../handle.js";
import { applyCompletedStage } from "../internal-utils.js";
import type { Output } from "../output.js";
import { readAllStages } from "../state/index.js";
import type { WorkflowHeader, WorkflowStage } from "../state/state.js";
import type { RunState } from "../types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Per-fanout-parent record of the TRAILING generation's COMPLETED unit rows, in
 * trail order, as their decorated `WorkflowStage.stage` strings (`"impl (phase 1/4)"`).
 * Consumed by `resumeFanoutStage` to compute the resume point + guard FanoutFn
 * determinism by full-string comparison. A failed unit row is NOT recorded here
 * (it's the `k+1` that resume re-runs). On a looped fanout the array resets per
 * generation, so a second-pass resume compares only the second pass's prefix.
 */
export type FanoutProgress = ReadonlyMap<string, readonly string[]>;

/**
 * Per-iterate-parent resume point — the TRAILING contiguous generation's state.
 * Consumed by `resumeIterateStage` to re-enter the pull loop.
 *
 *   - `entryArtifact` — the primary FROZEN at the generation's first unit (units
 *     roll the primary forward, so the rebuilt `state.primaryArtifact` is the LAST
 *     unit's artifact, not this). `undefined` if the iterate stage was the entry.
 *   - `accumulated` — the completed `Output`s of the trailing generation, in order
 *     (the IterateFn pull prefix; `index` resumes at `accumulated.length`). A failed
 *     unit contributes nothing (it's the unit resume re-pulls + re-runs).
 *
 * Reset whenever a non-iterate row (or a different parent) breaks contiguity, so a
 * corrective-loop second pass overwrites the first pass's point. `state.named` still
 * accumulates across ALL generations — only this prefix resets.
 */
export interface IterateResumePoint {
	entryArtifact: Artifact | undefined;
	accumulated: Output[];
}
export type IterateProgress = ReadonlyMap<string, IterateResumePoint>;

export type ReconstructResult =
	| {
			ok: true;
			state: RunState;
			lastStageNumber: number;
			visited: Set<string>;
			rows: WorkflowStage[];
			fanoutProgress: FanoutProgress;
			iterateProgress: IterateProgress;
	  }
	| { ok: false; reason: "no-rows" | "stage-gone"; detail: string };

// ---------------------------------------------------------------------------
// Fanout-decoration helpers (shared with resumeWorkflow dispatch)
// ---------------------------------------------------------------------------

/** Stage record keys whose def opts into `fanout`. */
export function fanoutStageNames(workflow: Workflow): ReadonlySet<string> {
	const names = new Set<string>();
	for (const [name, def] of Object.entries(workflow.stages)) {
		if (def.fanout) names.add(name);
	}
	return names;
}

/** Stage record keys whose def opts into `iterate`. */
export function iterateStageNames(workflow: Workflow): ReadonlySet<string> {
	const names = new Set<string>();
	for (const [name, def] of Object.entries(workflow.stages)) {
		if (def.iterate) names.add(name);
	}
	return names;
}

/**
 * Recover the parent stage name from a decorated unit-row key. Matches the
 * `fanoutRowStage`/`iterateRowStage` projection (`${parent} (${id ?? label})`,
 * audit.ts:57,69) with an exact `${parent} (` prefix + `)` suffix. The space
 * before `(` disambiguates prefix-name collisions (`"build-extra (x)"` does NOT
 * start with `"build ("`); identifier-style stage names never contain `" ("`,
 * so at most one parent matches. Returns undefined for a non-decorated key.
 */
export function matchFanoutParent(stageKey: string, parents: ReadonlySet<string>): string | undefined {
	if (!stageKey.endsWith(")")) return undefined;
	for (const parent of parents) {
		if (stageKey.startsWith(`${parent} (`)) return parent;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Reconstruction fold
// ---------------------------------------------------------------------------

/**
 * Rebuild `RunState` by folding over the completed stage rows in a run's
 * JSONL audit trail. Returns a discriminated result so the entry point
 * (`resumeWorkflow`) maps refusals to error envelopes.
 *
 * Rules:
 *   - A row whose `stage` is a real `workflow.stages` key → fold as a normal
 *     stage (completed rows seed via `applyCompletedStage`; non-completed rows
 *     bump counters only). A bare `def.iterate`-parent row is never written by
 *     the runner; should one exist it folds harmlessly here (iterate mandates
 *     `kind: "produces"`).
 *   - A row whose `stage` is NOT a key — a decorated unit row, a renamed
 *     stage, or a removed one:
 *       - matches a `def.fanout` parent → fold counters-only (mirror the
 *         live `recordFanoutSuccess`: bump `stagesCompleted` on a completed
 *         row, add parent to `visited`, advance `lastStageNumber`; NO
 *         `applyCompletedStage`, NO `state.output` write) + record the
 *         completed decorated string under the parent in `fanoutProgress`,
 *         resetting that prefix on a new generation (a looped fanout).
 *       - matches a `def.iterate` parent → fold as a full produces pass
 *         (`foldIterateUnit`): roll the primary, append to `state.named`, set
 *         `state.output`, bump counters, and track the trailing generation's
 *         `accumulated` + frozen entry artifact in `iterateProgress`.
 *       - no match → refuse `stage-gone`.
 */
export function reconstructState(cwd: string, workflow: Workflow, header: WorkflowHeader): ReconstructResult {
	const rows = readAllStages(cwd, header.runId);

	if (rows.length === 0) {
		return { ok: false, reason: "no-rows", detail: header.runId };
	}

	const fanoutNames = fanoutStageNames(workflow);
	const iterateNames = iterateStageNames(workflow);

	const acc: FoldAcc = {
		state: {
			originalInput: header.input,
			primaryArtifact: undefined,
			output: undefined,
			named: {},
			stagesCompleted: 0,
			lastAllocatedStageNumber: 0,
			telemetry: { backwardJumps: 0, droppedRoutingRows: [] },
			termination: { success: false, error: undefined },
		},
		visited: new Set<string>(),
		fanoutProgress: new Map<string, string[]>(),
		iterateProgress: new Map<string, IterateResumePoint>(),
		lastFoldedUnitParent: undefined,
		lastStageNumber: 0,
	};

	for (const row of rows) {
		const def = workflow.stages[row.stage];
		const step = def
			? foldKnownStage(acc, def, row)
			: foldDecoratedRow(acc, workflow, row, fanoutNames, iterateNames);
		if (step.refuse) return { ok: false, reason: step.reason, detail: step.detail };
	}

	acc.state.lastAllocatedStageNumber = acc.lastStageNumber; // allocator continues monotonically on append

	return {
		ok: true,
		state: acc.state,
		lastStageNumber: acc.lastStageNumber,
		visited: acc.visited,
		rows,
		fanoutProgress: acc.fanoutProgress,
		iterateProgress: acc.iterateProgress,
	};
}

// ---------------------------------------------------------------------------
// Per-row fold helpers
// ---------------------------------------------------------------------------

/** Mutable accumulator threaded through the per-row fold. */
interface FoldAcc {
	state: RunState;
	visited: Set<string>;
	fanoutProgress: Map<string, string[]>;
	iterateProgress: Map<string, IterateResumePoint>;
	/** Parent of the immediately-preceding folded row IF it was a fanout OR iterate unit; else undefined. Drives generation reset for both. */
	lastFoldedUnitParent: string | undefined;
	lastStageNumber: number;
}

/** A folded row either advanced the accumulator (`refuse: false`) or hit an unresumable trail. */
type FoldStep = { refuse: false } | { refuse: true; reason: "stage-gone"; detail: string };

const FOLD_OK: FoldStep = { refuse: false };
const refuse = (reason: "stage-gone", detail: string): FoldStep => ({
	refuse: true,
	reason,
	detail,
});

/**
 * Fold a row whose `stage` is a real `workflow.stages` key — a normal stage:
 * completed rows seed `state.output` + primary + named via `applyCompletedStage`;
 * non-completed rows bump `visited`/`lastStageNumber` only. A bare (undecorated)
 * iterate-parent or fanout-parent row is never written by the runner; should one
 * exist it folds harmlessly here — iterate mandates `kind: "produces"` so
 * `applyCompletedStage` runs, and fanout rows carry no output so the `!row.output`
 * guard skips it. A real-key row always breaks iterate contiguity (it is not a
 * decorated unit), so the generation cursor resets.
 */
function foldKnownStage(acc: FoldAcc, def: StageDef, row: WorkflowStage): FoldStep {
	acc.lastFoldedUnitParent = undefined;
	acc.visited.add(row.stage);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);
	if (row.status !== "completed") return FOLD_OK;
	acc.state.stagesCompleted++;
	if (!row.output) return FOLD_OK;
	acc.state.output = row.output;
	applyCompletedStage(acc.state, def, row.stage, row.output);
	return FOLD_OK;
}

/**
 * Fold a row whose `stage` is NOT a key — a decorated unit row, a renamed stage,
 * or a removed one. A fanout-parent match folds counters-only; an iterate-parent
 * match folds a full produces pass (`foldIterateUnit`); no match refuses
 * `stage-gone`.
 */
function foldDecoratedRow(
	acc: FoldAcc,
	workflow: Workflow,
	row: WorkflowStage,
	fanoutNames: ReadonlySet<string>,
	iterateNames: ReadonlySet<string>,
): FoldStep {
	const fanoutParent = matchFanoutParent(row.stage, fanoutNames);
	if (fanoutParent) {
		foldFanoutUnit(acc, fanoutParent, row);
		return FOLD_OK;
	}
	const iterateParent = matchFanoutParent(row.stage, iterateNames);
	if (iterateParent) {
		foldIterateUnit(acc, workflow.stages[iterateParent]!, iterateParent, row);
		return FOLD_OK;
	}
	return refuse("stage-gone", row.stage);
}

/**
 * Counters-only fold for one decorated fanout-unit row — mirrors the live
 * `recordFanoutSuccess`: bump `stagesCompleted` on a completed row, add the
 * parent to `visited`, advance `lastStageNumber`; NO `applyCompletedStage`, NO
 * `state.output` write. The completed decorated string is recorded under the
 * parent in `fanoutProgress` (the resume point + determinism-guard input).
 *
 * Generation tracking: a row whose parent differs from the immediately-preceding
 * unit row STARTS a new fanout generation — reset `fanoutProgress[parent]` so a
 * looped fanout's trailing pass overwrites the prior pass's prefix. `stagesCompleted`
 * stays cumulative (it mirrors the live count); only the resume-point array resets.
 * Fanout units never roll the primary, so the reconstructed `state.primaryArtifact`
 * already sits on the trailing generation's entry — no entry-artifact capture (the
 * iterate asymmetry; see resume-iterate.ts).
 */
function foldFanoutUnit(acc: FoldAcc, parent: string, row: WorkflowStage): void {
	const newGeneration = acc.lastFoldedUnitParent !== parent;
	acc.visited.add(parent);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);
	acc.lastFoldedUnitParent = parent;
	// New generation → fresh prefix; same generation → the array already exists (set on its first row).
	if (newGeneration || !acc.fanoutProgress.has(parent)) acc.fanoutProgress.set(parent, []);
	if (row.status !== "completed") return;
	acc.state.stagesCompleted++;
	acc.fanoutProgress.get(parent)!.push(row.stage); // trailing generation only
}

/**
 * Fold one decorated iterate-unit row as a full produces pass (mirrors the live
 * `recordStageSuccess` → `applyCompletedStage`): roll the primary, append to
 * `state.named[outcome.name]`, set `state.output`, bump `stagesCompleted`. The
 * decorated `row.stage` is SAFE for named keying — iterate mandates `outcome.name`,
 * so `resolvePublishName` ignores the decoration (audit.ts:104).
 *
 * Generation tracking: a row whose parent differs from the immediately-preceding
 * iterate row STARTS a new generation — snapshot the (pre-apply) primary as the
 * frozen `entryArtifact` and reset `accumulated`. Contiguous units append. This
 * keeps `iterateProgress` pointed at the TRAILING generation for a corrective loop,
 * while `state.named` accumulates every generation (matching the live run).
 *
 * `visited` records the PARENT (not the decorated key), mirroring the live
 * `advanceChain` visit + `foldFanoutUnit`. The generation cursor is shared with
 * fanout — a fanout parent and an iterate parent are always distinct keys, so a
 * row of the other kind always reads as a new generation here.
 */
function foldIterateUnit(acc: FoldAcc, def: StageDef, parent: string, row: WorkflowStage): void {
	const newGeneration = acc.lastFoldedUnitParent !== parent;
	let point = acc.iterateProgress.get(parent);
	if (newGeneration || !point) {
		point = { entryArtifact: acc.state.primaryArtifact, accumulated: [] };
		acc.iterateProgress.set(parent, point);
	}
	acc.visited.add(parent);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);
	acc.lastFoldedUnitParent = parent;

	if (row.status !== "completed") return; // failed/aborted/skipped — not accumulated (the unit resume re-runs)
	acc.state.stagesCompleted++;
	if (!row.output) return; // defensive — completed iterate rows always carry output
	acc.state.output = row.output;
	applyCompletedStage(acc.state, def, row.stage, row.output); // rolls primary + pushes named[outcome.name]
	point.accumulated.push(row.output);
}

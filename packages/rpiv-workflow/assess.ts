/**
 * Assess loop — the model-judged "until-done" depth primitive. The third loop
 * alongside `fanout.ts` (breadth) and `iterate.ts` (TS-judged depth). Where
 * `iterate`'s termination predicate is synchronous in-process TS, `assess`
 * runs a SEPARATE model judge each round: a **producer** session (this stage's
 * skill/outcome) then a **judge** session (the `AssessJudge`). The judge emits
 * a validated `{ done, feedback }` verdict; `judge.done(verdict)` decides the
 * loop, and `feedForward` carries the verdict's feedback into the next
 * producer round.
 *
 * Continuation-style, like `runIterate` / `runFanout`: the producer's
 * `onSuccess` chains into the judge sub-step; the judge's `onSuccess` either
 * `advanceAfter` (done) or self-recurses `runAssess(round + 1)`. `runner.ts`
 * (via `stage-lifecycle.ts`) injects the runner primitives through `AssessDeps`
 * so this module never imports back (cycle-free), mirroring `IterateDeps`.
 *
 * The crux is state restore. Both sub-steps run through `runStageSession`, so
 * each leaves `state.output` + `state.primaryArtifact` pointing at its OWN
 * artifact. After the judge round the engine reassigns both back to the
 * producer's values — the verdict lives only in its own dedicated
 * `state.named[judge.outcome.name]` channel (distinct from the producer's
 * `outcome.name`), and the monotonic counters stay (each sub-step landed a real
 * JSONL row). On `done` the downstream stage therefore inherits the PRODUCER
 * output, never the verdict.
 *
 * Two bounds cap the loop: `assess.max` (default 8) and `run.maxIterations`
 * (the run-wide backstop). Hitting `min(max, maxIterations)` SOFT-stops — warn,
 * keep the last producer output, advance — never a terminal failure.
 *
 * Resume contract (see `runner/resume-assess.ts`): each round persists two
 * trusted rows, so `feedForward` and `judge.done` must be deterministic w.r.t.
 * their inputs; completed sub-steps are never replayed.
 */

import type { AssessJudgeContext, StageDef } from "./api.js";
import { assessRowStage, runIdentityOf } from "./audit.js";
import { type Artifact, handleToString } from "./handle.js";
import { STATUS_ASSESS_ROUND, STATUS_KEY } from "./messages.js";
import type { Output } from "./output.js";
import type { RunContext, StageSession, WorkflowHostContext } from "./types.js";

/** Default round cap when an `assess` stage omits `max`. Clamped by `run.maxIterations`. */
export const DEFAULT_ASSESS_ROUNDS = 8;

export interface AssessDeps {
	/**
	 * Dispatch one sub-step (producer or judge) through the standard
	 * stage-session path. The same `runStageSession` a `produces` stage uses —
	 * the producer runs the author's def, the judge a synthetic `produces` def.
	 */
	runStageSession: (ctx: WorkflowHostContext, s: StageSession) => Promise<void>;
	/**
	 * Resume the chain after the assess node finishes (judge returned `done`, or
	 * the cap soft-stopped). Receives the assess node's REAL name so routing
	 * looks up the outgoing edge from it — the per-round audit decoration never
	 * leaks into routing.
	 */
	advanceAfter: (
		curCtx: WorkflowHostContext,
		completedName: string,
		completedIdx: number,
		run: RunContext,
	) => Promise<void>;
	/** Re-capture an outcome's pre-stage snapshot per sub-step (each is its own produces pass). */
	captureSnapshot: (def: StageDef, idx: number, run: RunContext) => Promise<unknown>;
	/** Emit the soft-stop warning when the round cap trips (no terminal failure). */
	softStopAssess: (curCtx: WorkflowHostContext, skill: string, max: number) => void;
}

/**
 * `skill` is the producer's bundled skill body (threaded by the runner), not
 * the node name — aliased nodes tag rows + prompts with the skill body.
 *
 * `currentName` is the assess node's REAL name — passed to `advanceAfter` once
 * the loop terminates, and the base for the decorated row labels.
 *
 * `entryArtifact` is the stage-entry primary, FROZEN across every round (the
 * rolling primary advances per producer round, but a dynamic `judge.prompt`
 * keeps seeing the true source via `AssessJudgeContext.entryArtifact`).
 *
 * `entryArgs` is the round-0 producer arg, computed ONCE in `tryAssess` via the
 * module-local `inputForStage` projection (start stage → originalInput;
 * otherwise the primary handle). Rounds ≥1 build their arg from `feedForward`.
 *
 * `prev` carries the just-judged round's producer output + verdict, threaded
 * through the self-recursion so round N's `feedForward` sees round N-1's pair.
 * Undefined on round 0 (the `entryArgs` path).
 */
export async function runAssess(
	curCtx: WorkflowHostContext,
	stageIdx: number,
	currentName: string,
	skill: string,
	def: StageDef,
	entryArtifact: Artifact | undefined,
	entryArgs: string,
	round: number,
	prev: { output: Output; verdict: Output } | undefined,
	run: RunContext,
	deps: AssessDeps,
): Promise<void> {
	const assess = def.assess!;
	const cap = Math.min(assess.max ?? DEFAULT_ASSESS_ROUNDS, run.maxIterations);

	// Cap reached without a `done` verdict — soft-stop. `state.output` /
	// `state.primaryArtifact` already hold the last producer round's values
	// (restored after the trailing judge), so the downstream stage inherits the
	// producer output. Warn (not error) and advance; no terminal failure row.
	if (round >= cap) {
		deps.softStopAssess(curCtx, skill, cap);
		await deps.advanceAfter(curCtx, currentName, stageIdx, run);
		return;
	}

	// Round 0 uses the precomputed entry arg; later rounds let the author build
	// the next producer arg from the prior round's output + verdict. `prev.round`
	// is the round just judged (this round minus one).
	const producerArg = prev
		? assess.feedForward({
				cwd: run.cwd,
				output: prev.output,
				verdict: prev.verdict,
				round: round - 1,
				state: run.state,
			})
		: entryArgs;

	curCtx.ui.setStatus(STATUS_KEY, STATUS_ASSESS_ROUND(stageIdx + 1, run.totalStages, skill, round, "produce"));
	const snapshot = await deps.captureSnapshot(def, stageIdx, run);

	await deps.runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt: `/skill:${skill} ${producerArg}`,
		// Decorated for the JSONL row + status; named keying still resolves to the
		// producer's outcome.name, so the decoration never splits the slot.
		stageName: assessRowStage(currentName, round, "produce"),
		skill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		stage: def,
		skillContracts: run.skillContracts,
		stageIndex: stageIdx,
		snapshot,
		branchOffset: undefined,
		onFailure: undefined,
		onSuccess: (freshCtx) => {
			// `tryRecordStage` set `state.output` to the producer's validated Output
			// and `applyCompletedStage` rolled the primary + published onto
			// `state.named[outcome.name]` before onSuccess fired. Capture both for
			// the post-judge restore (the callback arg is only `artifacts[0]`, NOT
			// the Output — the `iterate.ts:141` pattern). The primary `!` is safe:
			// `enforceCompletionContract` guarantees a produces session lands >=1
			// artifact, and `applyCompletedStage` rolled it into the slot.
			const producerOutput = run.state.output!;
			const producerArtifact = run.state.primaryArtifact!;
			return runJudgeRound(
				freshCtx,
				stageIdx,
				currentName,
				skill,
				def,
				entryArtifact,
				entryArgs,
				round,
				producerOutput,
				producerArtifact,
				run,
				deps,
			);
		},
	});
}

/**
 * The judge sub-step of round `round`. Runs on a SYNTHETIC `produces` def
 * carrying `judge.outcome` (so the verdict is validated + published into its
 * own channel) with `sessionPolicy: "fresh"` (so it never replays the
 * producer's branch). The parent stage's validation knobs — `onInvalid`,
 * `maxRetries`, `outputSchema`, `validateTimeoutMs` — are DELIBERATELY not
 * copied; judge sessions use framework defaults. A skill judge still picks up
 * its own declared contract for free because `effectiveOutputSchema` keys off
 * `s.skill`.
 *
 * Exported so resume can re-enter the JUDGE sub-step directly (without re-running
 * the producer) when a run died after a completed producer row — see
 * `runner/resume-assess.ts`. The forward path calls it from the producer's
 * `onSuccess`.
 */
export async function runJudgeRound(
	curCtx: WorkflowHostContext,
	stageIdx: number,
	currentName: string,
	skill: string,
	def: StageDef,
	entryArtifact: Artifact | undefined,
	entryArgs: string,
	round: number,
	producerOutput: Output,
	producerArtifact: Artifact,
	run: RunContext,
	deps: AssessDeps,
): Promise<void> {
	const assess = def.assess!;
	const judge = assess.judge;
	// Skill judge → `/skill:<judge.skill> <producerHandle>` (the latest producer
	// artifact auto-injected, exactly like any skill input). Prompt judge → the
	// resolved prompt verbatim; the author embeds the handle/output themselves
	// (judge.prompt is REQUIRED for prompt judges, validated at load).
	const judgeSkill = judge.skill ?? `${currentName}-judge`;
	const prompt =
		judge.skill !== undefined
			? `/skill:${judge.skill} ${handleToString(producerArtifact.handle)}`
			: await resolveJudgePrompt(judge.prompt!, {
					cwd: run.cwd,
					output: producerOutput,
					entryArtifact,
					state: run.state,
					round,
				});

	const judgeDef: StageDef = { kind: "produces", outcome: judge.outcome, sessionPolicy: "fresh" };

	curCtx.ui.setStatus(STATUS_KEY, STATUS_ASSESS_ROUND(stageIdx + 1, run.totalStages, judgeSkill, round, "judge"));
	const snapshot = await deps.captureSnapshot(judgeDef, stageIdx, run);

	await deps.runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt,
		stageName: assessRowStage(currentName, round, "judge"),
		skill: judgeSkill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		stage: judgeDef,
		skillContracts: run.skillContracts,
		stageIndex: stageIdx,
		snapshot,
		branchOffset: undefined,
		onFailure: undefined,
		onSuccess: (freshCtx) => {
			// `tryRecordStage` set `state.output` to the verdict and
			// `applyCompletedStage` published it onto `state.named[judge.outcome.name]`
			// + rolled the primary to the verdict artifact. Read the verdict, then
			// RESTORE the producer's output + primary — the verdict stays only in its
			// own named channel; counters stay (the judge row is real).
			const verdict = run.state.output!;
			run.state.output = producerOutput;
			run.state.primaryArtifact = producerArtifact;

			if (judge.done(verdict)) {
				return deps.advanceAfter(freshCtx, currentName, stageIdx, run);
			}
			return runAssess(
				freshCtx,
				stageIdx,
				currentName,
				skill,
				def,
				entryArtifact,
				entryArgs,
				round + 1,
				{ output: producerOutput, verdict },
				run,
				deps,
			);
		},
	});
}

/** Resolve a static or dynamic `judge.prompt`. A dynamic prompt may be async. */
async function resolveJudgePrompt(
	prompt: string | ((ctx: AssessJudgeContext) => string | Promise<string>),
	ctx: AssessJudgeContext,
): Promise<string> {
	if (typeof prompt === "string") return prompt;
	return prompt(ctx);
}

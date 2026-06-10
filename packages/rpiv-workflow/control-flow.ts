/**
 * Loop constructors + introspection — control flow as data, completed.
 *
 * `fanout()` / `iterate()` / `assess()` build the `LoopDef` a stage carries on
 * its single `loop` field. Unlike the retired spec-attaching builders (which
 * ATTACHED a `.spec` to a bare function), the LoopDef IS data with
 * function-valued fields — the spec is the source of truth in the
 * constructor, so introspection can never lag a new loop kind again (the
 * `09032b1` retrofit lesson). `loopSpecOf` projects the pure-data facet.
 *
 * Constructors validate at construction (the `defineRoute` pattern): a bad
 * `max`, an invalid judge shape, or a non-function `done`/`feedForward`
 * throws immediately at authoring time. Load-time validation re-checks the
 * same rules defensively for hand-rolled literals (jiti erases TS types).
 *
 * Skill-agnostic: the unit detectors (`units`/`next`) are consumer-supplied;
 * rpiv-workflow ships no conventions. Runner-free — safe on `registration`.
 */

import type {
	AssessLoop,
	CapPolicy,
	EdgeFn,
	FanoutFn,
	FanoutLoop,
	FeedForwardContext,
	IterateFn,
	IterateLoop,
	LoopDef,
	ResultProjection,
	UnitSelector,
	Workflow,
} from "./api.js";
import { STOP } from "./api.js";
import { type Judge, judgeShapeIssues } from "./judge.js";
import type { Output } from "./output.js";

// `UnitSelector` moved to api.ts (it lives with the loop vocabulary now);
// re-exported here so existing consumers' import path is unchanged.
export type { UnitSelector } from "./api.js";

// ===========================================================================
// Introspection — per-stage control-flow + edge shape
// ===========================================================================

/**
 * Per-stage control-flow + edge shape, read entirely from attached data — no
 * probing. The control-flow analogue of `legalNextSkills`: what an
 * analyzing/suggesting agent consumes to render or reason about a flow's
 * structure. `control.mode` now covers assess (previously read as "single").
 */
export interface StageShape {
	stage: string;
	skill?: string;
	control: { mode: "single" | LoopDef["kind"]; spec?: LoopSpec };
	edge: { mode: "linear" | "route" | "terminal"; targets?: readonly string[] };
}

/** Describe a workflow's structure stage-by-stage from attached metadata alone. */
export function describeFlow(w: Workflow): StageShape[] {
	return Object.entries(w.stages).map(([name, stage]) => {
		const control: StageShape["control"] = stage.loop
			? { mode: stage.loop.kind, spec: loopSpecOf(stage.loop) }
			: { mode: "single" };

		const target = w.edges[name];
		let edge: StageShape["edge"];
		if (target === undefined || target === STOP) {
			edge = { mode: "terminal" };
		} else if (typeof target === "string") {
			edge = { mode: "linear", targets: [target] };
		} else {
			edge = { mode: "route", targets: (target as EdgeFn).targets };
		}

		return { stage: name, skill: stage.skill, control, edge };
	});
}

// ===========================================================================
// Loop constructors — fanout() / iterate() / assess() build StageDef.loop
// ===========================================================================

/** Default round cap when an `assess()` call omits `max`. Clamped by `run.maxIterations`. */
export const DEFAULT_ASSESS_MAX = 8;

/** Options shared by all three constructors — the introspectable facet + policy knobs. */
interface LoopOptionsBase {
	/** The named channel the units are split FROM (a `consumes` hint for lints/agents). */
	source?: string;
	/** How units are detected (opaque convention — e.g. `{ by: "frontmatter-array", pattern: "phases" }`). */
	unit?: UnitSelector;
	/** Cardinality ceiling. Must be an integer >= 1 (throws at construction). */
	max?: number;
	/** Cap policy override. Defaults: fanout/iterate → "halt", assess → "advance". */
	onCap?: CapPolicy;
	/** Result projection override. Defaults: fanout → "entry", iterate/assess → "last". */
	result?: ResultProjection;
}

export interface FanoutOptions extends LoopOptionsBase {
	/** Push-model unit source — all units computed up front. */
	units: FanoutFn;
}

export interface IterateOptions extends LoopOptionsBase {
	/** Pull-model unit source — one unit per call, fed the accumulated prefix. */
	next: IterateFn;
}

export interface AssessOptions extends LoopOptionsBase {
	judge: Judge;
	/** Sync TS reading the model-made verdict. `true` → loop stops, producer output is the result. */
	done: (verdict: Output) => boolean;
	/** Builds the next producer prompt arg from the just-judged round's output + verdict. */
	feedForward: (ctx: FeedForwardContext) => string;
}

/**
 * Push loop: all units precomputed, each unit its own session. On a
 * `produces` stage units COLLECT (full collect→validate→publish per unit;
 * `outcome.name` required); on an `acts` stage units are side-effects.
 * Empty `units()` return ⇒ single-stage fall-through.
 */
export function fanout(opts: FanoutOptions): FanoutLoop {
	return {
		kind: "fanout",
		units: opts.units,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("fanout", opts.max),
		onCap: opts.onCap ?? "halt",
		result: opts.result ?? "entry",
	};
}

/**
 * Pull loop: sequential, accumulating — each `next()` call sees the prior
 * units' validated Outputs. Requires `kind: "produces"` + `outcome.name`
 * (workflow-level, checked at load). First-call `null` ⇒ zero-unit no-op.
 */
export function iterate(opts: IterateOptions): IterateLoop {
	return {
		kind: "iterate",
		next: opts.next,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("iterate", opts.max),
		onCap: opts.onCap ?? "halt",
		result: opts.result ?? "last",
	};
}

/**
 * Model-judged until-done loop: each round runs a producer session (this
 * stage's skill/outcome) then a judge session (`opts.judge`). `done(verdict)`
 * decides termination; `feedForward` carries the verdict into the next
 * producer round. The cap soft-stops by default (`onCap: "advance"`).
 * Requires `kind: "produces"` + `outcome.name` (workflow-level, checked at
 * load) — every round runs the produces collector, so the producer needs a
 * stable named slot like any other collecting loop.
 */
export function assess(opts: AssessOptions): AssessLoop {
	const issues = judgeShapeIssues(opts.judge);
	if (issues.length > 0) throw new Error(`assess(): ${issues[0]}`);
	if (typeof opts.done !== "function") {
		throw new Error("assess(): `done` must be a function deciding termination from the verdict");
	}
	if (typeof opts.feedForward !== "function") {
		throw new Error("assess(): `feedForward` must be a function building the next producer arg");
	}
	return {
		kind: "assess",
		judge: opts.judge,
		done: opts.done,
		feedForward: opts.feedForward,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("assess", opts.max) ?? DEFAULT_ASSESS_MAX,
		onCap: opts.onCap ?? "advance",
		result: opts.result ?? "last",
	};
}

/** `max < 1` would cap at unit 0 and silently produce nothing — reject at construction. */
function checkedMax(ctor: string, max: number | undefined): number | undefined {
	if (max === undefined) return undefined;
	if (!Number.isInteger(max) || max < 1) {
		throw new Error(`${ctor}(): max must be an integer >= 1 (got ${max})`);
	}
	return max;
}

// ===========================================================================
// Introspection — one channel for all loop kinds
// ===========================================================================

/**
 * Pure-data projection of a LoopDef — what `describeFlow`, `preview`, and the
 * `checkFanoutSource` lint consume. `judge` summarises the dispatch without
 * exposing functions: `prompt: true` means a prompt judge (the text/closure
 * itself stays opaque).
 */
export interface LoopSpec {
	kind: LoopDef["kind"];
	source?: string;
	unit?: UnitSelector;
	max?: number;
	onCap: CapPolicy;
	result: ResultProjection;
	judge?: { skill?: string; prompt: boolean; outcome: string };
}

/** Project the introspectable facet off a stage's loop, or undefined for non-loop stages. */
export function loopSpecOf(loop: LoopDef | undefined): LoopSpec | undefined {
	if (!loop) return undefined;
	const base: LoopSpec = {
		kind: loop.kind,
		source: loop.source,
		unit: loop.unit,
		max: loop.max,
		onCap: loop.onCap,
		result: loop.result,
	};
	if (loop.kind === "assess") {
		base.judge = {
			skill: loop.judge.skill,
			prompt: loop.judge.prompt !== undefined,
			outcome: loop.judge.outcome.name ?? "",
		};
	}
	return base;
}

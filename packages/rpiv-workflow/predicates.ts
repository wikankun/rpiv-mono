/**
 * Predicate factories for DAG edge routing. Pure manifest → target-node-id.
 *
 * Both factories observe the SAME missing-field policy: a missing field
 * yields `undefined` and the comparison decides the branch — `===` is false
 * against any literal, and `NaN > threshold` is always false. Net effect:
 * a missing field routes to `ifFalse` / `ifBelow`. This is symmetric across
 * the two factories so workflow authors don't have to remember per-factory
 * coercion rules. Thresholds with `threshold < 0` would not match a missing
 * field the way the old `?? 0` did, but negative thresholds are
 * semantically suspect for the "blocker / issue count" shapes these were
 * authored for.
 *
 * If a workflow author needs a different missing-field default, declare it
 * explicitly via `definePredicate`:
 * ```ts
 * definePredicate(["a","b"], ({ manifest }) =>
 *   Number((manifest?.data as Record<string, unknown>)?.foo ?? -1) > 0 ? "a" : "b"
 * )
 * ```
 */

import type { Manifest } from "./manifest.js";
import type { RunState } from "./types.js";

export interface PredicateContext {
	manifest: Manifest | undefined;
	state: Readonly<RunState>;
}

export type EdgePredicate = (ctx: PredicateContext) => string;

/** ifTrue when `manifest.data[field] === equals`, else ifFalse. */
export const predicateOnField =
	<T>(field: string, equals: T, ifTrue: string, ifFalse: string): EdgePredicate =>
	({ manifest }) => {
		const value = (manifest?.data as Record<string, unknown>)?.[field];
		return value === equals ? ifTrue : ifFalse;
	};

/** ifAbove when `Number(manifest.data[field]) > threshold`, else ifBelow. Missing field → NaN → ifBelow. */
export const predicateThreshold =
	(field: string, threshold: number, ifAbove: string, ifBelow: string): EdgePredicate =>
	({ manifest }) => {
		const value = Number((manifest?.data as Record<string, unknown>)?.[field]);
		return value > threshold ? ifAbove : ifBelow;
	};

/**
 * Process-wide nesting counter: current `session_start` was fired by
 * runWorkflow spawning an inner stage (not by the user opening Pi).
 * Only `ui.notify` calls in session_start handlers gate on this — state
 * mutation (advisor restore, agent sync, guidance injection) runs
 * unconditionally.
 *
 * **Integer counter, not boolean.** A stage skill that runs `/wf
 * <subworkflow>` (e.g. a `code-review` skill invoking a follow-up
 * `/wf revise`) nests the runner. A boolean would let the inner run's
 * `clearChildSession` zero out the outer flag mid-stage, so the outer
 * run's remaining stages would re-emit the startup banner and re-fire
 * the advisor restore notify. The counter is incremented per
 * `markChildSession` and decremented per `clearChildSession`;
 * `isChildSession()` is `count > 0`.
 *
 * `Symbol.for` so sibling packages (rpiv-advisor, rpiv-args) can read the
 * flag without taking a runtime dependency on rpiv-pi. The Phase-1 zero-
 * cross-imports contract forbids them from importing this constant, so
 * they re-derive the same symbol via `Symbol.for("@juicesharp/...")` —
 * keep the literal string in sync if you rename. Inlined sibling readers
 * also test `count > 0` (not `Boolean(value)`).
 */

/** Canonical key — exported so rpiv-pi-internal consumers can import. */
export const CHILD_SESSION_KEY = Symbol.for("@juicesharp/rpiv-workflow:child-session");

type Global = Record<symbol, number | undefined>;

export function markChildSession(): void {
	const g = globalThis as unknown as Global;
	g[CHILD_SESSION_KEY] = (g[CHILD_SESSION_KEY] ?? 0) + 1;
}

export function clearChildSession(): void {
	const g = globalThis as unknown as Global;
	const n = (g[CHILD_SESSION_KEY] ?? 0) - 1;
	if (n > 0) g[CHILD_SESSION_KEY] = n;
	else delete g[CHILD_SESSION_KEY];
}

export function isChildSession(): boolean {
	return ((globalThis as unknown as Global)[CHILD_SESSION_KEY] ?? 0) > 0;
}

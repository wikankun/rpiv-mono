import { afterEach, describe, expect, it } from "vitest";
import { clearChildSession, isChildSession, markChildSession } from "./child-session.js";

describe("child-session marker", () => {
	afterEach(() => {
		// Drain the counter to zero so a test that mark()s without clear()ing
		// doesn't leak into the next case.
		while (isChildSession()) clearChildSession();
	});

	it("isChildSession() returns false by default", () => {
		expect(isChildSession()).toBe(false);
	});

	it("markChildSession() flips the flag to true", () => {
		markChildSession();
		expect(isChildSession()).toBe(true);
	});

	it("clearChildSession() resets the flag to false", () => {
		markChildSession();
		clearChildSession();
		expect(isChildSession()).toBe(false);
	});

	it("clearChildSession() is idempotent on an unset flag", () => {
		clearChildSession();
		clearChildSession();
		expect(isChildSession()).toBe(false);
	});

	it("nested mark/clear stays true until the outermost clear (counter semantics)", () => {
		// Closes I6 from the 2026-05-24_08-00-42 review. A stage skill that
		// runs `/wf <subworkflow>` nests the runner. A boolean would let the
		// inner clear zero the outer flag mid-stage and re-emit startup
		// banners on remaining outer stages.
		markChildSession();
		markChildSession();
		expect(isChildSession()).toBe(true);
		clearChildSession();
		expect(isChildSession()).toBe(true); // outer still active
		clearChildSession();
		expect(isChildSession()).toBe(false);
	});

	it("clearChildSession() bottoms out at 0 (no negative counter)", () => {
		// Defensive: a stray clear without a matching mark must not push the
		// counter negative, which would then require multiple marks to
		// re-activate the gate.
		clearChildSession();
		clearChildSession();
		clearChildSession();
		markChildSession();
		expect(isChildSession()).toBe(true);
	});

	it("uses Symbol.for so a separate read path sees the same slot", () => {
		// Simulates the inlined predicate in rpiv-advisor / rpiv-args /
		// session-hooks — must read the SAME symbol slot the workflow runner
		// writes to. If this test fails, the key strings have drifted out of
		// sync. Counter, not boolean: inlined readers gate on `> 0`.
		const KEY = Symbol.for("@juicesharp/rpiv-workflow:child-session");
		markChildSession();
		const inlined = (globalThis as unknown as Record<symbol, number | undefined>)[KEY] ?? 0;
		expect(inlined > 0).toBe(true);
		clearChildSession();
		const inlinedAfter = (globalThis as unknown as Record<symbol, number | undefined>)[KEY] ?? 0;
		expect(inlinedAfter > 0).toBe(false);
	});
});

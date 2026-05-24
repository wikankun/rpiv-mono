import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdvisorEffort, getAdvisorModel, restoreAdvisorState } from "./advisor.js";

const WORKFLOW_CHILD_KEY = Symbol.for("@juicesharp/rpiv-workflow:child-session");
// Counter (not boolean) — see rpiv-workflow/child-session.ts. Tests flip the
// binary state; a single mark/clear pair is sufficient because the readers
// gate on `> 0`.
const setChildSession = (on: boolean) => {
	const g = globalThis as unknown as Record<symbol, number | undefined>;
	if (on) g[WORKFLOW_CHILD_KEY] = (g[WORKFLOW_CHILD_KEY] ?? 0) + 1;
	else delete g[WORKFLOW_CHILD_KEY];
};

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");

function writeConfig(contents: object) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

describe("restoreAdvisorState", () => {
	it("no-ops when config is missing", () => {
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
	});
	it("no-ops when modelKey is absent", () => {
		writeConfig({ effort: "high" });
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
		expect(getAdvisorEffort()).toBeUndefined();
	});
	it("no-ops when modelKey lacks ':' separator", () => {
		writeConfig({ modelKey: "malformed" });
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
	});
	it("notifies + no-ops when registry.find returns undefined", () => {
		writeConfig({ modelKey: "unknown:model" });
		const { pi } = createMockPi();
		const ctx = createMockCtx({ hasUI: true });
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => undefined) } as never;
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no longer available"), "warning");
	});
	it("happy path: sets model + effort + pushes advisor into active tools", () => {
		writeConfig({ modelKey: "a:m", effort: "high" });
		const model = { provider: "a", id: "m", name: "M" } as never;
		const { pi, captured } = createMockPi();
		const ctx = createMockCtx({ hasUI: true });
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toEqual(model);
		expect(getAdvisorEffort()).toBe("high");
		expect(captured.activeTools).toContain("advisor");
	});
	it("does NOT push advisor again if already active", () => {
		writeConfig({ modelKey: "a:m" });
		const model = { provider: "a", id: "m" } as never;
		const { pi, captured } = createMockPi({ getActiveTools: vi.fn(() => ["advisor"]) as never });
		const ctx = createMockCtx();
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
		restoreAdvisorState(ctx, pi);
		expect(captured.activeTools).not.toContain("advisor");
	});

	describe("workflow child-session filtering", () => {
		afterEach(() => {
			setChildSession(false);
		});

		it("suppresses the 'Advisor restored' notify on the happy path when child-session flag is set", () => {
			writeConfig({ modelKey: "a:m", effort: "high" });
			const model = { provider: "a", id: "m", name: "M" } as never;
			const { pi, captured } = createMockPi();
			const ctx = createMockCtx({ hasUI: true });
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
			const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

			setChildSession(true);
			restoreAdvisorState(ctx, pi);

			// State mutation still happened.
			expect(getAdvisorModel()).toEqual(model);
			expect(getAdvisorEffort()).toBe("high");
			expect(captured.activeTools).toContain("advisor");
			// But the cosmetic notify was suppressed.
			expect(notify).not.toHaveBeenCalled();
		});

		it("suppresses the 'no longer available' warning when child-session flag is set", () => {
			writeConfig({ modelKey: "unknown:model" });
			const { pi } = createMockPi();
			const ctx = createMockCtx({ hasUI: true });
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => undefined) } as never;
			const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

			setChildSession(true);
			restoreAdvisorState(ctx, pi);

			expect(notify).not.toHaveBeenCalled();
		});
	});
});

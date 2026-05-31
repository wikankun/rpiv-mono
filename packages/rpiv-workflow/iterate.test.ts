/**
 * Iterate executor tests — the sequential, accumulating dual of fanout.
 * Exercised end-to-end through `runWorkflow` + a scripted mock session chain
 * (same harness as runner.test.ts / named-registry.test.ts), since the
 * executor's whole point is its interaction with the produces session path.
 *
 * The generator encodes what it observed (`index`, `accumulated.length`, the
 * frozen `artifact`, prior plan paths) into each unit's prompt, so a single
 * `sentMessages` assertion pins ordering, accumulation, index, AND the frozen
 * entry artifact at once.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, type FanoutFn, gate, type IterateFn, produces } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import type { OutputSpec } from "./output.js";
import { eq, gt } from "./predicates.js";
import { runWorkflow } from "./runner/index.js";
import { typeboxSchema } from "./typebox-adapter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Transcript-scan outcome (rpiv-pi convention, inlined). Emits every matched path as an artifact. */
const makeOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const matches: string[] = [];
			const start = Math.max(ctx.branchOffset ?? 0, 0);
			for (let i = start; i < ctx.branch.length; i++) {
				const entry = ctx.branch[i]!;
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						const m = part.text.match(PATTERN);
						if (m) matches.push(...m);
					}
				}
			}
			if (matches.length === 0) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			return {
				kind: "ok",
				artifacts: matches.map((path) => ({ handle: fsHandle(path), role: "primary" as const })),
			};
		},
	},
	parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
});

/**
 * Per-phase blueprint generator. Reads the FROZEN review artifact for its phase
 * list, terminates once every phase is planned, and threads prior plan paths +
 * its observed index/accumulation into the prompt so tests can assert on them.
 */
const reviewPhaseIterate: IterateFn = ({ artifact, accumulated, index, cwd }) => {
	if (artifact?.handle.kind !== "fs") return null;
	const abs = artifact.handle.path.startsWith("/") ? artifact.handle.path : join(cwd, artifact.handle.path);
	const phases = [...readFileSync(abs, "utf-8").matchAll(/^### Phase (\d+) — (.+)$/gm)];
	if (index >= phases.length) return null;
	const prior = accumulated
		.flatMap((o) => o.artifacts)
		.filter((a) => a.handle.kind === "fs")
		.map((a) => (a.handle.kind === "fs" ? a.handle.path : ""));
	const num = phases[index]![1];
	const phaseName = phases[index]![2]!.trim();
	const prompt = `${artifact.handle.path} Phase ${num} idx=${index} acc=${accumulated.length} prior=[${prior.join(",")}]`;
	return { prompt, label: `phase ${index + 1}/${phases.length} — ${phaseName}`, id: `phase-${num}` };
};

/** Downstream fanout that reads EVERY accumulated plan straight from state.named. */
const plansFanout: FanoutFn = ({ state }) =>
	(state.named.plans ?? [])
		.flatMap((o) => o.artifacts)
		.filter((a) => a.handle.kind === "fs")
		.map((a, i) => ({ prompt: a.handle.kind === "fs" ? a.handle.path : "", label: `plan ${i + 1}` }));

const REVIEW_3_PHASES = "# Review\n\n### Phase 1 — Alpha\nx\n### Phase 2 — Beta\ny\n### Phase 3 — Gamma\nz\n";

describe("iterate executor", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-iterate-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const writeArtifact = (relPath: string, content = "") => {
		const parts = relPath.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, relPath), content);
	};

	const readState = (): Array<Record<string, unknown>> => {
		const dir = join(tmpDir, ".rpiv", "workflows", "runs");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		return lines.slice(1).map((l) => JSON.parse(l));
	};

	/** review (produces "reviews") → blueprint (iterate, produces "plans") → consume. */
	const wf = (consume = acts()) => ({
		name: "polish",
		start: "review",
		stages: {
			review: produces({ outcome: makeOutcome("reviews") }),
			blueprint: produces({ outcome: makeOutcome("plans"), iterate: reviewPhaseIterate }),
			consume,
		},
		edges: { review: "blueprint", blueprint: "consume", consume: "stop" } as Record<string, string>,
	});

	it("pulls units until null; runs one session per unit in order; threads accumulated + index + frozen artifact", async () => {
		writeArtifact(".rpiv/artifacts/reviews/rev.md", REVIEW_3_PHASES);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-3.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(), input: "x" });

		expect(result.success).toBe(true);
		// 1 review + 3 blueprint units + 1 consume
		expect(result.stagesCompleted).toBe(5);
		expect(chain.remaining()).toBe(0);
		// Each blueprint unit sees: the FROZEN review path (never rolls to plan-N),
		// a monotonic index, accumulated growing by one, and prior plan paths.
		expect(chain.sentMessages).toEqual([
			"/skill:review x",
			"/skill:blueprint .rpiv/artifacts/reviews/rev.md Phase 1 idx=0 acc=0 prior=[]",
			"/skill:blueprint .rpiv/artifacts/reviews/rev.md Phase 2 idx=1 acc=1 prior=[.rpiv/artifacts/plans/plan-1.md]",
			"/skill:blueprint .rpiv/artifacts/reviews/rev.md Phase 3 idx=2 acc=2 prior=[.rpiv/artifacts/plans/plan-1.md,.rpiv/artifacts/plans/plan-2.md]",
			// consume is a side-effect stage inheriting the rolling primary — the LAST unit's plan.
			"/skill:consume .rpiv/artifacts/plans/plan-3.md",
		]);
		// Rolling primary advanced to the last unit's artifact.
		expect(result.lastArtifact).toBe(".rpiv/artifacts/plans/plan-3.md");
	});

	it("decorates each unit's JSONL row with id; named keying still resolves to outcome.name (one slot)", async () => {
		writeArtifact(".rpiv/artifacts/reviews/rev.md", REVIEW_3_PHASES);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-3.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		await runWorkflow(chain.ctx, { workflow: wf(), input: "x" });

		const stages = readState();
		expect(stages[0]).toMatchObject({ stage: "review", skill: "review" });
		// Decorated row identity on `.stage`; raw skill body on `.skill`.
		expect(stages[1]?.stage).toBe("blueprint (phase-1)");
		expect(stages[2]?.stage).toBe("blueprint (phase-2)");
		expect(stages[3]?.stage).toBe("blueprint (phase-3)");
		expect(stages.slice(1, 4).every((s) => s.skill === "blueprint")).toBe(true);
		expect(stages.slice(1, 4).every((s) => s.status === "completed")).toBe(true);
	});

	it("accumulates every unit's Output under outcome.name; a downstream fanout reads all of them", async () => {
		writeArtifact(".rpiv/artifacts/reviews/rev.md", REVIEW_3_PHASES);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-3.md")] },
				// one consume-fanout unit per accumulated plan
				{ branch: [mockAssistantMessage("impl 1")] },
				{ branch: [mockAssistantMessage("impl 2")] },
				{ branch: [mockAssistantMessage("impl 3")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(acts({ fanout: plansFanout })), input: "x" });

		expect(result.success).toBe(true);
		// 1 review + 3 blueprint units + 3 consume fanout units
		expect(result.stagesCompleted).toBe(7);
		// The fanout read state.named["plans"] and saw ALL three accumulated plans,
		// proving the decorated rows did not split the named slot.
		expect(chain.sentMessages.slice(-3)).toEqual([
			"/skill:consume .rpiv/artifacts/plans/plan-1.md",
			"/skill:consume .rpiv/artifacts/plans/plan-2.md",
			"/skill:consume .rpiv/artifacts/plans/plan-3.md",
		]);
	});

	it("first generator call returns null → zero-unit no-op completes, advances, leaves primary at entry", async () => {
		writeArtifact(".rpiv/artifacts/reviews/rev.md", "# Review with no phases\n");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(), input: "x" });

		expect(result.success).toBe(true);
		// review + consume only — blueprint ran zero sessions.
		expect(result.stagesCompleted).toBe(2);
		expect(chain.remaining()).toBe(0);
		// consume inherited the UNCHANGED primary (the review artifact), proving
		// the no-op did not touch the rolling slot or publish anything.
		expect(chain.sentMessages).toEqual(["/skill:review x", "/skill:consume .rpiv/artifacts/reviews/rev.md"]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/reviews/rev.md");
	});

	it("maxIterations backstop halts with a terminal failure when the generator never returns null", async () => {
		writeArtifact(".rpiv/artifacts/reviews/rev.md", REVIEW_3_PHASES);
		// A generator that ALWAYS returns a unit (ignores the phase list).
		const runaway: IterateFn = ({ index }) => ({ prompt: `unit ${index}`, label: `u${index}` });
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-2.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "runaway",
				start: "review",
				stages: {
					review: produces({ outcome: makeOutcome("reviews") }),
					blueprint: produces({ outcome: makeOutcome("plans"), iterate: runaway }),
				},
				edges: { review: "blueprint", blueprint: "stop" },
			},
			input: "x",
			maxIterations: 2,
		});

		expect(result.success).toBe(false);
		// review + 2 units landed before the cap tripped on the 3rd pull.
		expect(result.stagesCompleted).toBe(3);
		expect(result.error).toMatch(/Iterate limit exceeded: generator produced 2 units \(max 2\)/);
	});

	it("generator throw halts the stage, attributed to the stage", async () => {
		writeArtifact(".rpiv/artifacts/reviews/rev.md", REVIEW_3_PHASES);
		const boom: IterateFn = () => {
			throw new Error("generator exploded");
		};
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "boom",
				start: "review",
				stages: {
					review: produces({ outcome: makeOutcome("reviews") }),
					blueprint: produces({ outcome: makeOutcome("plans"), iterate: boom }),
				},
				edges: { review: "blueprint", blueprint: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/generator exploded/);
		// review completed; blueprint recorded a failure row attributed to itself.
		const stages = readState();
		const failed = stages.find((s) => s.status === "failed");
		expect(failed?.stage).toBe("blueprint");
		expect(existsSync(join(tmpDir, ".rpiv", "artifacts", "plans"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Corrective back-edge re-entry (§10.1): a gate loops code-review → blueprint.
// state.named["plans"] is append-only across the loop; the generator sources
// its review from state.named (NOT the rolling primary, which is the
// code-review doc on re-entry).
// ---------------------------------------------------------------------------

describe("iterate executor — corrective back-edge", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-iterate-loop-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const writeArtifact = (relPath: string, content = "") => {
		const parts = relPath.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, relPath), content);
	};

	/** Sources the review from state.named — robust to the rolling primary being the code-review doc on re-entry. */
	const reviewFromState: IterateFn = ({ state, index, cwd }) => {
		const review = state.named.architecture_reviews?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");
		if (review?.handle.kind !== "fs") return null;
		const abs = review.handle.path.startsWith("/") ? review.handle.path : join(cwd, review.handle.path);
		const phases = [...readFileSync(abs, "utf-8").matchAll(/^### Phase (\d+) — (.+)$/gm)];
		if (index >= phases.length) return null;
		const num = phases[index]![1];
		return {
			prompt: `${review.handle.path} Phase ${num}`,
			label: `phase ${index + 1}/${phases.length}`,
			id: `phase-${num}`,
		};
	};

	const transcriptOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
		name,
		collector: {
			collect: (ctx) => {
				const matches: string[] = [];
				for (let i = Math.max(ctx.branchOffset ?? 0, 0); i < ctx.branch.length; i++) {
					const entry = ctx.branch[i]!;
					if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
					const content = entry.message.content;
					if (!Array.isArray(content)) continue;
					for (const part of content) {
						if (part.type === "text" && typeof part.text === "string") {
							const m = part.text.match(PATTERN);
							if (m) matches.push(...m);
						}
					}
				}
				if (matches.length === 0) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
				return { kind: "ok", artifacts: matches.map((p) => ({ handle: fsHandle(p), role: "primary" as const })) };
			},
		},
		parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
	});

	/** Like transcriptOutcome but parses blockers_count from the artifact's frontmatter (drives the gate). */
	const blockersOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
		name,
		collector: transcriptOutcome(name).collector,
		parser: {
			parse: (ctx) => {
				const primary = ctx.artifacts[0];
				if (primary?.handle.kind !== "fs") return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
				const abs = primary.handle.path.startsWith("/") ? primary.handle.path : join(ctx.cwd, primary.handle.path);
				if (!existsSync(abs)) return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
				const m = readFileSync(abs, "utf-8").match(/blockers_count:\s*(\d+)/);
				return { kind: "ok", payload: { kind: "artifact-md", data: { blockers_count: Number(m?.[1] ?? 0) } } };
			},
		},
	});

	const plansFanout: FanoutFn = ({ state }) =>
		(state.named.plans ?? [])
			.flatMap((o) => o.artifacts)
			.filter((a) => a.handle.kind === "fs")
			.map((a, i) => ({ prompt: a.handle.kind === "fs" ? a.handle.path : "", label: `plan ${i + 1}` }));

	it("accumulates plans append-only across a corrective loop; generator re-reads review from state.named", async () => {
		writeArtifact(
			".rpiv/artifacts/architecture_reviews/rev.md",
			"# Review\n\n### Phase 1 — A\nx\n### Phase 2 — B\ny\n",
		);
		writeArtifact(".rpiv/artifacts/reviews/cr1.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(".rpiv/artifacts/reviews/cr2.md", "---\nblockers_count: 0\n---\n");

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/architecture_reviews/rev.md")] },
				// pass 1: 2 plans
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/cr1.md")] }, // blockers=1 → loop
				// pass 2: 2 more plans (append-only)
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-3.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-4.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/cr2.md")] }, // blockers=0 → consume
				// consume fanout: one unit per accumulated plan (expects 4)
				{ branch: [mockAssistantMessage("impl 1")] },
				{ branch: [mockAssistantMessage("impl 2")] },
				{ branch: [mockAssistantMessage("impl 3")] },
				{ branch: [mockAssistantMessage("impl 4")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "polish-loop",
				start: "review",
				stages: {
					review: produces({ outcome: transcriptOutcome("architecture_reviews") }),
					blueprint: produces({ outcome: transcriptOutcome("plans"), iterate: reviewFromState }),
					"code-review": produces({
						outcome: blockersOutcome("reviews"),
						outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
					}),
					consume: acts({ fanout: plansFanout }),
				},
				edges: {
					review: "blueprint",
					blueprint: "code-review",
					"code-review": gate("blockers_count", { blueprint: gt(0), consume: eq(0) }),
					consume: "stop",
				},
			},
			input: "x",
		});

		expect(result.success).toBe(true);
		// review + 2 plans + cr1 + 2 plans + cr2 + 4 consume units = 11
		expect(result.stagesCompleted).toBe(11);
		// The consume fanout saw ALL FOUR plans — proving state.named["plans"] is
		// append-only across the back-edge (both loop generations survive).
		expect(chain.sentMessages.slice(-4)).toEqual([
			"/skill:consume .rpiv/artifacts/plans/plan-1.md",
			"/skill:consume .rpiv/artifacts/plans/plan-2.md",
			"/skill:consume .rpiv/artifacts/plans/plan-3.md",
			"/skill:consume .rpiv/artifacts/plans/plan-4.md",
		]);
	});
});

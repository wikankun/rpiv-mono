/**
 * Assess executor tests — the model-judged "until-done" depth loop. Exercised
 * end-to-end through `runWorkflow` + a scripted mock session chain (same harness
 * as iterate.test.ts), since the executor's whole point is its two-sessions-per-
 * round interaction with the produces session path: a producer round, then a
 * judge round whose validated verdict decides termination.
 *
 * The producer scans the transcript for `.rpiv/artifacts/<bucket>/<file>.md`;
 * the judge scans for a `.rpiv/verdicts/<file>.json` verdict file and parses it
 * to `{ done, feedback }`. Pre-writing the verdict files lets the test control
 * the judge's decision per round without a live model.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi, createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AssessConfig, acts, type FanoutFn, produces } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import type { Output, OutputSpec } from "./output.js";
import { runWorkflow } from "./runner/index.js";
import { typeboxSchema } from "./typebox-adapter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MD_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;
const JSON_PATTERN = /\.rpiv\/verdicts\/[\w.-]+\.json/g;

/** Last assistant-text match of `pattern` across the (offset-sliced) branch. */
const lastMatch = (ctx: { branch: unknown[]; branchOffset?: number }, pattern: RegExp): string | undefined => {
	let found: string | undefined;
	const start = Math.max(ctx.branchOffset ?? 0, 0);
	for (let i = start; i < ctx.branch.length; i++) {
		const entry = ctx.branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") {
				const m = part.text.match(pattern);
				if (m) found = m[m.length - 1];
			}
		}
	}
	return found;
};

/** Producer outcome: scan transcript for the last `.rpiv/artifacts/.../*.md`; parse its frontmatter. */
const producerOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const path = lastMatch(ctx, MD_PATTERN);
			if (!path) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			return { kind: "ok", artifacts: [{ handle: fsHandle(path), role: "primary" }] };
		},
	},
	parser: {
		parse: (ctx) => {
			const primary = ctx.artifacts[0];
			const path = primary?.handle.kind === "fs" ? primary.handle.path : undefined;
			if (!path) return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
			const abs = path.startsWith("/") ? path : join(ctx.cwd, path);
			if (!existsSync(abs)) return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
			return { kind: "ok", payload: { kind: "artifact-md", data: parseFm(readFileSync(abs, "utf-8")) } };
		},
	},
});

/** Verdict outcome: scan for the last `.rpiv/verdicts/*.json`; parse it to `{ done, feedback }`. */
const verdictOutcome = (name: string): OutputSpec<unknown, "verdict", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const path = lastMatch(ctx, JSON_PATTERN);
			if (!path) return { kind: "fatal", message: `${ctx.skill} produced no verdict path` };
			return { kind: "ok", artifacts: [{ handle: fsHandle(path), role: "primary" }] };
		},
	},
	parser: {
		parse: (ctx) => {
			const primary = ctx.artifacts[0];
			const path = primary?.handle.kind === "fs" ? primary.handle.path : undefined;
			if (!path) return { kind: "ok", payload: { kind: "verdict", data: {} } };
			const abs = path.startsWith("/") ? path : join(ctx.cwd, path);
			return { kind: "ok", payload: { kind: "verdict", data: JSON.parse(readFileSync(abs, "utf-8")) } };
		},
	},
});

/** A verdict outcome whose collector returns ZERO artifacts (structurally ok) — pins correction 4. */
const emptyVerdictOutcome = (name: string): OutputSpec<unknown, "verdict", Record<string, unknown>> => ({
	name,
	collector: { collect: () => ({ kind: "ok", artifacts: [] }) },
});

/** Minimal frontmatter parser (scalar `key: value` lines between `---` fences). */
const parseFm = (content: string): Record<string, unknown> => {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const fm: Record<string, unknown> = {};
	for (const line of match[1]!.split("\n")) {
		const m = line.match(/^([\w.-]+)\s*:\s*(.+)$/);
		if (m) fm[m[1]!] = m[2]!.trim();
	}
	return fm;
};

const done = (v: Output) => Boolean((v.data as { done?: boolean }).done);
const feedForward: AssessConfig["feedForward"] = ({ verdict, round }) =>
	`refine round=${round} done=${(verdict.data as { done?: boolean }).done} fb=${(verdict.data as { feedback?: string }).feedback}`;

/** Fanout probe reading both named channels — proves producer + verdict slots populated and separate. */
const channelProbe: FanoutFn = ({ state }) => [
	{ prompt: `tasks=${state.named.tasks?.length ?? 0} verdicts=${state.named.verdict?.length ?? 0}`, label: "probe" },
];

describe("assess executor", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-assess-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const writeFile = (relPath: string, content = "") => {
		const parts = relPath.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, relPath), content);
	};

	/** Pre-write a verdict file and return its relative path. */
	const writeVerdict = (n: number, isDone: boolean, feedback = `fb${n}`): string => {
		const rel = `.rpiv/verdicts/v${n}.json`;
		writeFile(rel, JSON.stringify({ done: isDone, feedback }));
		return rel;
	};

	const readState = (): Array<Record<string, unknown>> => {
		const dir = join(tmpDir, ".rpiv", "workflows", "runs");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		return lines.slice(1).map((l) => JSON.parse(l));
	};

	/** breakdown (assess; start) → consume. `consume` defaults to a plain side-effect. */
	const wf = (assess: AssessConfig, consume = acts()) => ({
		name: "decompose",
		start: "breakdown",
		stages: {
			breakdown: produces({ outcome: producerOutcome("tasks"), assess }),
			consume,
		},
		edges: { breakdown: "consume", consume: "stop" } as Record<string, string>,
	});

	const skillJudge = (outcomeName = "verdict"): AssessConfig => ({
		judge: { skill: "grade", outcome: verdictOutcome(outcomeName), done },
		feedForward,
	});

	it("runs producer→judge rounds sequentially; on done the downstream stage gets the PRODUCER output", async () => {
		writeVerdict(0, false);
		writeVerdict(1, false);
		writeVerdict(2, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t2.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v2.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(skillJudge()), input: "x" });

		expect(result.success).toBe(true);
		// 3 produce + 3 judge + 1 consume.
		expect(result.stagesCompleted).toBe(7);
		expect(chain.remaining()).toBe(0);
		// Round 0 uses the entry arg; later rounds carry feedForward (which embeds
		// the prior round's verdict). Skill judge gets the producer handle injected.
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown x",
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:breakdown refine round=0 done=false fb=fb0",
			"/skill:grade .rpiv/artifacts/tasks/t1.md",
			"/skill:breakdown refine round=1 done=false fb=fb1",
			"/skill:grade .rpiv/artifacts/tasks/t2.md",
			// consume inherits the rolling primary — the LAST producer output, NOT the verdict.
			"/skill:consume .rpiv/artifacts/tasks/t2.md",
		]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/tasks/t2.md");
	});

	it("decorates the two rows per round with r{n}·{phase}; producer + judge skills land on .skill", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		await runWorkflow(chain.ctx, { workflow: wf(skillJudge()), input: "x" });

		const stages = readState();
		expect(stages[0]).toMatchObject({ stage: "breakdown (r0·produce)", skill: "breakdown", status: "completed" });
		expect(stages[1]).toMatchObject({ stage: "breakdown (r0·judge)", skill: "grade", status: "completed" });
		expect(stages[2]).toMatchObject({ stage: "consume", skill: "consume" });
	});

	it("keeps producer outputs and verdicts in their own state.named channels (never collide)", async () => {
		writeVerdict(0, false);
		writeVerdict(1, false);
		writeVerdict(2, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t2.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v2.json")] },
				{ branch: [mockAssistantMessage("probed")] },
			],
		});

		await runWorkflow(chain.ctx, { workflow: wf(skillJudge(), acts({ fanout: channelProbe })), input: "x" });

		// The probe fanout read state.named — 3 producer outputs under "tasks",
		// 3 verdicts under "verdict", proving the channels are separate.
		expect(chain.sentMessages.at(-1)).toBe("/skill:consume tasks=3 verdicts=3");
	});

	it("soft-stops at the round cap: warns, keeps the last producer output, advances — no terminal failure", async () => {
		writeVerdict(0, false);
		writeVerdict(1, false);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf({ ...skillJudge(), max: 2 }),
			input: "x",
		});

		expect(result.success).toBe(true);
		// 2 produce + 2 judge + 1 consume — round 2 never produced.
		expect(result.stagesCompleted).toBe(5);
		// Soft-stop warning surfaced; NO failed/aborted row.
		const softStop = chain.notifications.find((n) => /max round cap/i.test(n.msg));
		expect(softStop?.level).toBe("warning");
		expect(readState().some((s) => s.status === "failed" || s.status === "aborted")).toBe(false);
		// Downstream inherits the LAST producer output.
		expect(chain.sentMessages.at(-1)).toBe("/skill:consume .rpiv/artifacts/tasks/t1.md");
		expect(result.lastArtifact).toBe(".rpiv/artifacts/tasks/t1.md");
	});

	it("clamps the round cap by run.maxIterations", async () => {
		writeVerdict(0, false);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		// max=10 but maxIterations=1 → cap = 1 → one round then soft-stop.
		const result = await runWorkflow(chain.ctx, {
			workflow: wf({ ...skillJudge(), max: 10 }),
			input: "x",
			maxIterations: 1,
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(3); // 1 produce + 1 judge + consume
		expect(chain.notifications.some((n) => /max round cap \(1\)/i.test(n.msg))).toBe(true);
	});

	it("supports a prompt judge: the resolved prompt is dispatched verbatim (no /skill prefix)", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const promptJudge: AssessConfig = {
			judge: {
				prompt: ({ output, round }) =>
					`grade r${round} ${output.artifacts[0]?.handle.kind === "fs" ? output.artifacts[0].handle.path : ""}`,
				outcome: verdictOutcome("verdict"),
				done,
			},
			feedForward,
		};

		const result = await runWorkflow(chain.ctx, { workflow: wf(promptJudge), input: "x" });

		expect(result.success).toBe(true);
		// The judge prompt is the author's raw text — the producer handle is embedded
		// by the author, NOT auto-prefixed with /skill:.
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown x",
			"grade r0 .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
	});

	it("an artifact-less judge is a FATAL halt via enforceCompletionContract (not a soft-stop)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("not done — but I wrote no verdict file")] },
				{ branch: [mockAssistantMessage("never reached")] },
			],
		});

		const judge: AssessConfig = {
			judge: { skill: "grade", outcome: emptyVerdictOutcome("verdict"), done },
			feedForward,
		};

		const result = await runWorkflow(chain.ctx, { workflow: wf(judge), input: "x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/without producing any artifact/i);
		// Producer round completed; judge round halted — consume never ran.
		expect(result.stagesCompleted).toBe(1);
		expect(chain.remaining()).toBe(1);
	});

	it("judge sessions ignore the parent stage's outputSchema (verdict shape would otherwise fail)", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});
		// Producer frontmatter satisfies requiredField; the verdict JSON does NOT.
		// If the judge round inherited this schema it would fail validation.
		writeFile(".rpiv/artifacts/tasks/t0.md", "---\nrequiredField: hello\n---\n\nbody");

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "decompose",
				start: "breakdown",
				stages: {
					breakdown: produces({
						outcome: producerOutcome("tasks"),
						outputSchema: typeboxSchema(Type.Object({ requiredField: Type.String() })),
						assess: skillJudge(),
					}),
					consume: acts(),
				},
				edges: { breakdown: "consume", consume: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(true);
		// No validation-retry notification fired on the judge round.
		expect(chain.notifications.some((n) => /validation/i.test(n.msg))).toBe(false);
		expect(result.stagesCompleted).toBe(3);
	});

	// -----------------------------------------------------------------------
	// Round-0 producer arg projection (start vs non-start) + missing upstream.
	// The start-stage path ("/skill:breakdown x", originalInput) is asserted by
	// the happy-path test above; these pin the inherited-primary and halt arms.
	// -----------------------------------------------------------------------

	/** review (produces "seed") → breakdown (assess; non-start) → consume. */
	const nonStartWf = (assess: AssessConfig) => ({
		name: "decompose",
		start: "review",
		stages: {
			review: produces({ outcome: producerOutcome("seed") }),
			breakdown: produces({ outcome: producerOutcome("tasks"), assess }),
			consume: acts(),
		},
		edges: { review: "breakdown", breakdown: "consume", consume: "stop" } as Record<string, string>,
	});

	it("round-0 producer of a NON-start assess stage reads the inherited upstream primary handle", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/seed/s0.md")] }, // review
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] }, // breakdown produce r0
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge r0
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: nonStartWf(skillJudge()), input: "x" });

		expect(result.success).toBe(true);
		// breakdown's round-0 arg is review's primary handle (the inputForStage projection),
		// NOT the original input "x".
		expect(chain.sentMessages[1]).toBe("/skill:breakdown .rpiv/artifacts/seed/s0.md");
	});

	it("halts at the inline ensureUpstreamArtifact preflight when a non-start assess stage has no upstream primary", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("did setup, produced no artifact")] }, // setup (side-effect)
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "decompose",
				start: "setup",
				stages: {
					setup: acts(),
					breakdown: produces({ outcome: producerOutcome("tasks"), assess: skillJudge() }),
					consume: acts(),
				},
				edges: { setup: "breakdown", breakdown: "consume", consume: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(false);
		// ensureUpstreamArtifact halts before round 0 — only setup dispatched, no producer/judge.
		expect(result.error).toMatch(/no upstream artifactPath/i);
		expect(chain.sentMessages).toEqual(["/skill:setup x"]);
	});

	it("the judge sees the FROZEN entryArtifact and the LATEST producer handle each round", async () => {
		writeVerdict(0, false);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/seed/s0.md")] }, // review (frozen entry)
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] }, // breakdown produce r0
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge r0
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] }, // breakdown produce r1
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] }, // judge r1
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const handleOf = (o: Output): string => (o.artifacts[0]?.handle.kind === "fs" ? o.artifacts[0].handle.path : "?");
		const entryProbeJudge: AssessConfig = {
			judge: {
				prompt: ({ output, entryArtifact, round }) =>
					`r${round} entry=${entryArtifact?.handle.kind === "fs" ? entryArtifact.handle.path : "?"} latest=${handleOf(output)}`,
				outcome: verdictOutcome("verdict"),
				done,
			},
			feedForward,
		};

		const result = await runWorkflow(chain.ctx, { workflow: nonStartWf(entryProbeJudge), input: "x" });

		expect(result.success).toBe(true);
		// entryArtifact stays the review artifact across BOTH rounds (frozen); the latest handle
		// follows the rolling producer primary (t0 → t1).
		expect(chain.sentMessages).toContain("r0 entry=.rpiv/artifacts/seed/s0.md latest=.rpiv/artifacts/tasks/t0.md");
		expect(chain.sentMessages).toContain("r1 entry=.rpiv/artifacts/seed/s0.md latest=.rpiv/artifacts/tasks/t1.md");
	});

	// -----------------------------------------------------------------------
	// Judge-skill registration — tryAssess verifies judge.skill the same way it
	// verifies the producer skill, but only when the host supplied a registry.
	// -----------------------------------------------------------------------

	it("halts before round 0 when the judge skill is not registered (host present)", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		// Host registers the producer ("breakdown") but NOT the judge ("grade").
		const host = createMockPi({ skills: ["breakdown", "consume"] }).pi;

		const result = await runWorkflow(chain.ctx, { workflow: wf(skillJudge()), input: "x", host });

		expect(result.success).toBe(false);
		// Halt fires in tryAssess before any session — nothing dispatched.
		expect(result.error).toMatch(/requires Pi skill "grade"/);
		expect(result.stagesCompleted).toBe(0);
		expect(chain.sentMessages).toEqual([]);
	});

	it("runs when the judge skill IS registered (host present)", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});
		const host = createMockPi({ skills: ["breakdown", "grade", "consume"] }).pi;

		const result = await runWorkflow(chain.ctx, { workflow: wf(skillJudge()), input: "x", host });

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(3);
	});

	it("skips the judge-skill registry check when hostless (registeredSkills undefined → fail-soft)", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		// No host → registeredSkills is undefined → the judge-skill check is skipped entirely
		// (mirrors ensureSkillRegistered's fail-soft posture for hostless embedders).
		const result = await runWorkflow(chain.ctx, { workflow: wf(skillJudge()), input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages[1]).toBe("/skill:grade .rpiv/artifacts/tasks/t0.md");
	});
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowDag } from "./dag.js";
import { countPhases, extractArtifactPath, runWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// extractArtifactPath — pure scan over a synthetic branch (no I/O)
// ---------------------------------------------------------------------------

/** Helper: build an assistant message branch entry with array content. */
const asst = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("extractArtifactPath", () => {
	it("extracts artifact path from text content block", () => {
		const branch = [asst("Done!\n\nNext step: `/skill:plan .rpiv/artifacts/research/report.md`")];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/report.md");
	});

	it("extracts last artifact when multiple text blocks present", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Wrote research to .rpiv/artifacts/research/res.md" },
						{ type: "text", text: "Also see .rpiv/artifacts/research/res2.md" },
					],
				},
			},
		];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/res2.md");
	});

	it("returns undefined when no artifact path found", () => {
		const branch = [asst("No artifacts here")];
		expect(extractArtifactPath(branch)).toBeUndefined();
	});

	it("skips non-message entries", () => {
		const branch = [{ type: "thinking_level_change" }, asst("Result: .rpiv/artifacts/designs/design.md")];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/designs/design.md");
	});

	it("skips user messages", () => {
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "/skill:discover test" }] },
			},
			asst("Produced .rpiv/artifacts/discover/frd.md"),
		];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/discover/frd.md");
	});

	it("ignores non-text content blocks (thinking, tool_call)", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", text: ".rpiv/artifacts/research/ignored.md" },
						{ type: "text", text: ".rpiv/artifacts/research/kept.md" },
					],
				},
			},
		];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/kept.md");
	});

	it("finds artifact in last assistant message (reverse scan)", () => {
		const branch = [asst("First: .rpiv/artifacts/research/old.md"), asst("Final: .rpiv/artifacts/research/new.md")];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/new.md");
	});
});

// ---------------------------------------------------------------------------
// countPhases — file-driven phase counter
// ---------------------------------------------------------------------------

describe("countPhases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-count-phases-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("counts ## Phase N: headings in an absolute-path plan file", () => {
		const planPath = join(tmpDir, "plan.md");
		writeFileSync(planPath, "## Phase 1: a\n## Phase 2: b\n## Phase 3: c\n");
		expect(countPhases(planPath)).toBe(3);
	});

	it("resolves a relative path against the provided cwd", () => {
		mkdirSync(join(tmpDir, "plans"), { recursive: true });
		writeFileSync(join(tmpDir, "plans", "p.md"), "## Phase 1: a\n## Phase 2: b\n");
		expect(countPhases("plans/p.md", tmpDir)).toBe(2);
	});

	it("returns 0 for a missing file", () => {
		expect(countPhases(join(tmpDir, "nope.md"))).toBe(0);
	});

	it("returns 0 for a file with no ## Phase N: headings", () => {
		const p = join(tmpDir, "empty.md");
		writeFileSync(p, "# Title\n## Summary\n## Not a Phase\n### Phase 1: sub-heading not matched\n");
		expect(countPhases(p)).toBe(0);
	});

	it("ignores headings without a numeric phase index", () => {
		const p = join(tmpDir, "weird.md");
		writeFileSync(p, "## Phase A: not a number\n## Phase 1: real\n");
		expect(countPhases(p)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runWorkflow — orchestration over a scripted session chain
// ---------------------------------------------------------------------------

describe("runWorkflow", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-run-workflow-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Minimal DAG factory — runWorkflow only consults `dag.presets[preset]`. */
	const dagWith = (presets: Record<string, string[]>): WorkflowDag => ({ edges: [], presets });

	/** Read the single JSONL state file produced for a run, as parsed objects. */
	const readState = (cwd: string): { header: Record<string, unknown>; stages: Array<Record<string, unknown>> } => {
		const dir = join(cwd, ".rpiv", "workflows");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		return {
			header: JSON.parse(lines[0]!),
			stages: lines.slice(1).map((l) => JSON.parse(l)),
		};
	};

	it("returns an error result for an unknown preset and writes nothing to disk", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, {
			preset: "nonexistent",
			input: "x",
			dag: dagWith({ tiny: ["research"] }),
		});

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toMatch(/Unknown preset: nonexistent/);
		expect(chain.ctx.newSession).not.toHaveBeenCalled();
		// No .rpiv/workflows directory was created — the unknown-preset guard
		// returns BEFORE writeHeader. This is the contract: a typo doesn't
		// pollute the audit trail.
		expect(existsSync(join(tmpDir, ".rpiv", "workflows"))).toBe(false);
	});

	it("returns an error result for a preset whose node list is empty", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, {
			preset: "empty",
			input: "x",
			dag: dagWith({ empty: [] }),
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Unknown preset: empty/);
		expect(chain.ctx.newSession).not.toHaveBeenCalled();
	});

	it("completes a single-step workflow on success and records header + completed step", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "tiny",
			input: "add dark mode",
			dag: dagWith({ tiny: ["research"] }),
		});

		expect(result).toEqual({
			success: true,
			stagesCompleted: 1,
			lastArtifact: ".rpiv/artifacts/research/r.md",
			error: undefined,
		});
		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		expect(chain.sentMessages).toEqual(["/skill:research add dark mode"]);

		const { header, stages } = readState(tmpDir);
		expect(header.preset).toBe("tiny");
		expect(header.input).toBe("add dark mode");
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({
			stage: 1,
			skill: "research",
			artifact: ".rpiv/artifacts/research/r.md",
			status: "completed",
		});
	});

	it("chains the second step on freshCtx — outer.newSession is called exactly once", async () => {
		// The runner contract: every newSession after the first MUST be invoked
		// on the freshCtx handed to the previous withSession callback. If the
		// runner ever regressed to capturing the outer ctx, this assertion
		// would fire (outer.newSession.calls would be 2).
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("step 1 → .rpiv/artifacts/research/r.md")] },
				{ branch: [mockAssistantMessage("step 2 → .rpiv/artifacts/designs/d.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "two",
			input: "x",
			dag: dagWith({ two: ["research", "design"] }),
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(2);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/designs/d.md");
		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		// Step 2's prompt uses the artifact produced by step 1 — not the
		// original user input. This is the artifact-handoff invariant.
		expect(chain.sentMessages).toEqual(["/skill:research x", "/skill:design .rpiv/artifacts/research/r.md"]);
		expect(chain.remaining()).toBe(0);

		const { stages } = readState(tmpDir);
		expect(stages.map((s) => s.status)).toEqual(["completed", "completed"]);
		expect(stages[1]?.artifact).toBe(".rpiv/artifacts/designs/d.md");
	});

	it("stops on step failure, records a failed entry, and never consumes later steps", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [] }, // No assistant message → runner classifies as failure
				{ branch: [mockAssistantMessage("never reached")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "two",
			input: "x",
			dag: dagWith({ two: ["research", "design"] }),
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("research failed");
		expect(result.stagesCompleted).toBe(0);
		// Second scripted step must still be in the queue
		expect(chain.remaining()).toBe(1);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "failed" });
		expect(stages[0]?.artifact).toBeUndefined();
	});

	it("records skipped + emits cancelled notification when outer newSession resolves cancelled", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ cancelled: true }],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "tiny",
			input: "x",
			dag: dagWith({ tiny: ["research"] }),
		});

		expect(result.success).toBe(false);
		expect(result.error).toBeUndefined();
		expect(result.stagesCompleted).toBe(0);
		expect(chain.notifications.some((n) => /cancelled/i.test(n.msg))).toBe(true);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "skipped" });
	});

	it("expands an implement step into N phases when its plan artifact has ## Phase headings", async () => {
		// Pre-write a plan artifact at the path step 1 will emit. The runner
		// reads it from disk during the implement-step multi-phase check.
		const planRelPath = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(
			join(tmpDir, planRelPath),
			"# Plan\n\n## Phase 1: alpha\nbody\n## Phase 2: beta\nbody\n## Phase 3: gamma\nbody\n",
		);

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				// research → emits plan path
				{ branch: [mockAssistantMessage(`Plan ready: ${planRelPath}`)] },
				// three implement phases
				{ branch: [mockAssistantMessage("phase 1 done")] },
				{ branch: [mockAssistantMessage("phase 2 done")] },
				{ branch: [mockAssistantMessage("phase 3 done")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "rip",
			input: "x",
			dag: dagWith({ rip: ["research", "implement"] }),
		});

		expect(result.success).toBe(true);
		// 1 research + 3 phase rows
		expect(result.stagesCompleted).toBe(4);
		expect(chain.remaining()).toBe(0);
		// Outer ctx still only initiates the very first step
		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		// Each phase's prompt suffixes the plan path with "Phase N"
		expect(chain.sentMessages).toEqual([
			"/skill:research x",
			`/skill:implement ${planRelPath} Phase 1`,
			`/skill:implement ${planRelPath} Phase 2`,
			`/skill:implement ${planRelPath} Phase 3`,
		]);

		const { stages } = readState(tmpDir);
		// header + research + 3 phase rows = 4 stage entries
		expect(stages).toHaveLength(4);
		expect(stages[0]).toMatchObject({ skill: "research", status: "completed" });
		expect(stages[1]?.skill).toBe("implement (phase 1/3)");
		expect(stages[2]?.skill).toBe("implement (phase 2/3)");
		expect(stages[3]?.skill).toBe("implement (phase 3/3)");
		expect(stages.slice(1).every((s) => s.status === "completed")).toBe(true);
	});

	it("falls back to the original input on the first step when no prior artifact exists", async () => {
		// Step 1's assistant message does NOT contain a .rpiv/artifacts/... path.
		// Step 2 must therefore receive the original input, not a missing artifact.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("ok, no artifact emitted")] },
				{ branch: [mockAssistantMessage("step 2 done .rpiv/artifacts/designs/d.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "two",
			input: "describe the thing",
			dag: dagWith({ two: ["research", "design"] }),
		});

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual(["/skill:research describe the thing", "/skill:design describe the thing"]);
	});
});

import { createMockCommandCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acts, defineWorkflow, produces } from "./api.js";

// Mock runner to avoid needing the full Pi session runtime.
vi.mock("./runner/index.js", () => ({
	runWorkflow: vi.fn(async () => ({ stagesCompleted: 2, success: true })),
	resumeWorkflow: vi.fn(async () => ({ stagesCompleted: 1, success: true })),
}));

// Mock state/resolveRun to avoid filesystem I/O. Default: not found.
vi.mock("./state/index.js", () => ({
	resolveRun: vi.fn(() => undefined),
}));

// Mock load.ts to avoid jiti + filesystem I/O. The mock provides a stable
// LoadedWorkflows shape every test reuses; per-test overrides via mockReturnValueOnce.
const tinyWorkflow = defineWorkflow({
	name: "tiny",
	start: "research",
	stages: { research: produces(), commit: acts() },
	edges: { research: "commit", commit: "stop" },
});
const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	stages: {
		research: produces(),
		implement: acts(),
		commit: acts(),
	},
	edges: { research: "implement", implement: "commit", commit: "stop" },
});
const reviewWorkflow = defineWorkflow({
	name: "review",
	start: "code-review",
	stages: { "code-review": produces(), commit: acts() },
	edges: { "code-review": "commit", commit: "stop" },
});

vi.mock("./load/index.js", () => ({
	loadWorkflows: vi.fn(async () => ({
		workflows: [tinyWorkflow, midWorkflow, reviewWorkflow],
		default: "mid",
		workflowSources: new Map([
			["tiny", "built-in"],
			["mid", "built-in"],
			["review", "built-in"],
		]),
		layers: ["built-in"],
		issues: [],
		skillAliases: {},
	})),
	findWorkflow: vi.fn((loaded: { workflows: { name: string }[] }, name: string) =>
		loaded.workflows.find((w) => w.name === name),
	),
}));

import { parseArgs, registerWorkflowCommand } from "./command.js";
import { loadWorkflows } from "./load/index.js";
import { resumeWorkflow, runWorkflow } from "./runner/index.js";
import { resolveRun } from "./state/index.js";

beforeEach(() => {
	vi.mocked(runWorkflow).mockReset();
	vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 2, success: true });
	vi.mocked(resumeWorkflow).mockReset();
	vi.mocked(resumeWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true });
	vi.mocked(resolveRun).mockReset();
	vi.mocked(resolveRun).mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
// parseArgs — pure helper
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};

	it("parses workflow name + input", () => {
		expect(parseArgs("mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
		});
	});

	it("defaults to the default workflow when no name is recognized", () => {
		expect(parseArgs("Add dark mode", built)).toEqual({ kind: "run", workflow: "mid", input: "Add dark mode" });
	});

	it("parses a workflow-name-only token with no input", () => {
		expect(parseArgs("review", built)).toEqual({ kind: "run", workflow: "review", input: "" });
	});

	it("handles empty string", () => {
		expect(parseArgs("", built)).toEqual({ kind: "run", workflow: "mid", input: "" });
	});

	it("handles whitespace-only string", () => {
		expect(parseArgs("   ", built)).toEqual({ kind: "run", workflow: "mid", input: "" });
	});

	it("uses custom default when no workflow name is recognized", () => {
		const customConfig = {
			workflowNames: new Set(["my-flow"]),
			default: "my-flow",
		};
		expect(parseArgs("Add feature", customConfig)).toEqual({
			kind: "run",
			workflow: "my-flow",
			input: "Add feature",
		});
	});
});

// ---------------------------------------------------------------------------
// parseArgs — resume sigil
// ---------------------------------------------------------------------------

describe("parseArgs — resume (@ref)", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};

	it("parses @ref as resume kind", () => {
		expect(parseArgs("@2026-06-03_07-30-00-ab12", built)).toEqual({
			kind: "resume",
			ref: "2026-06-03_07-30-00-ab12",
		});
	});

	it("parses @ alone as resume with empty ref", () => {
		expect(parseArgs("@", built)).toEqual({ kind: "resume", ref: "" });
	});

	it("extracts only the first token after @ (ignores trailing tokens)", () => {
		expect(parseArgs("@run-id extra stuff", built)).toEqual({ kind: "resume", ref: "run-id" });
	});

	it("@ with whitespace-only trailing content returns empty ref", () => {
		expect(parseArgs("@   ", built)).toEqual({ kind: "resume", ref: "" });
	});

	it("tolerates a space after the sigil (@ ref === @ref)", () => {
		expect(parseArgs("@ run-id", built)).toEqual({ kind: "resume", ref: "run-id" });
	});
});

// ---------------------------------------------------------------------------
// /wf handler shape + dispatch
// ---------------------------------------------------------------------------

describe("/wf — command shape", () => {
	it('registers under "wf"', () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		expect(captured.commands.has("wf")).toBe(true);
	});
});

describe("/wf — !hasUI", () => {
	it("notifies an error and exits without calling runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: false });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — no input", () => {
	it("shows the workflow listing when no input is provided", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — valid invocation", () => {
	it("calls runWorkflow with the resolved workflow object", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid Add dark mode", ctx);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.workflow.name).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
	});

	it("falls back to default workflow when first token is unknown", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("Add dark mode", ctx);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.workflow.name).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
	});

	it("bare workflow-name token shows that workflow's detail view (not the full list)", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("review", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("workflow: review"), "info");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("whitespace-only input shows the full workflow list", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("   ", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Issue surfacing — load + validation errors
// ---------------------------------------------------------------------------

describe("/wf — issue surfacing", () => {
	it("surfaces validation warnings as 'warning' notifies", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [tinyWorkflow],
			default: "tiny",
			workflowSources: new Map([["tiny", "built-in"]]),
			layers: ["built-in"],
			issues: [
				{
					kind: "validation",
					workflow: "tiny",
					stage: "research",
					severity: "warning",
					message: "orphan check",
					layer: "built-in",
				},
			],
			skillAliases: {},
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("tiny Add feature", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("orphan check"), "warning");
	});

	it("aborts on load errors — runWorkflow is not invoked", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [tinyWorkflow],
			default: "tiny",
			workflowSources: new Map([["tiny", "built-in"]]),
			layers: ["built-in"],
			issues: [{ kind: "load", layer: "project", path: "rpiv.config.ts", severity: "error", message: "broke" }],
			skillAliases: {},
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("tiny Add feature", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("config error"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Empty registry — standalone rpiv-workflow install (no rpiv-pi, no overlays).
// The loader used to return `default: "mid"` even with zero workflows; the
// dispatch then either silently went into a not-found notify or, worse,
// looked up "mid" in an empty map. Now: `default: undefined` and the command
// emits an explicit "no workflows registered" notify.
// ---------------------------------------------------------------------------

describe("/wf — empty registry", () => {
	it("emits MSG_NO_WORKFLOWS_REGISTERED when user provides input but no workflows are loaded", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [],
			default: undefined,
			workflowSources: new Map(),
			layers: [],
			issues: [],
			skillAliases: {},
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("Add dark mode", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no workflows registered"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("no-args still shows the (empty) workflow listing instead of erroring", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [],
			default: undefined,
			workflowSources: new Map(),
			layers: [],
			issues: [],
			skillAliases: {},
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("parseArgs — empty registry", () => {
	it('returns workflow="" when no default is set and the first token doesn\'t match a workflow', () => {
		const empty = { workflowNames: new Set<string>(), default: undefined };
		expect(parseArgs("Add feature", empty)).toEqual({ kind: "run", workflow: "", input: "Add feature" });
		expect(parseArgs("", empty)).toEqual({ kind: "run", workflow: "", input: "" });
	});
});

// ---------------------------------------------------------------------------
// /wf @<ref> — resume dispatch
// ---------------------------------------------------------------------------

const fakeHeader = {
	runId: "2026-06-03_07-30-00-ab12",
	workflow: "mid",
	input: "Add dark mode",
	ts: "2026-06-03T07:30:00Z",
};

describe("/wf @<ref> — guard: empty ref", () => {
	it("notifies usage message and does not call resumeWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("usage"), "error");
		expect(resumeWorkflow).not.toHaveBeenCalled();
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<ref> — guard: run not found", () => {
	it("notifies run-not-found and does not call resumeWorkflow", async () => {
		vi.mocked(resolveRun).mockReturnValue(undefined);
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@bogus-run-id", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no run found"), "error");
		expect(resumeWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<ref> — guard: workflow gone", () => {
	it("notifies workflow-gone when header's workflow is not in loaded set", async () => {
		vi.mocked(resolveRun).mockReturnValue({ ...fakeHeader, workflow: "deleted-wf" });
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${fakeHeader.runId}`, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no longer registered"), "error");
		expect(resumeWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<ref> — guard: load errors block resume", () => {
	it("aborts on load errors — resumeWorkflow is not invoked", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [midWorkflow],
			default: "mid",
			workflowSources: new Map([["mid", "built-in"]]),
			layers: ["built-in"],
			issues: [{ kind: "load", layer: "project", path: "rpiv.config.ts", severity: "error", message: "broke" }],
			skillAliases: {},
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${fakeHeader.runId}`, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("config error"), "error");
		expect(resumeWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<ref> — happy path", () => {
	it("calls resumeWorkflow once with the resolved header and workflow", async () => {
		vi.mocked(resolveRun).mockReturnValue(fakeHeader);
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${fakeHeader.runId}`, ctx);
		expect(resumeWorkflow).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(resumeWorkflow).mock.calls[0]?.[1];
		expect(opts?.header.runId).toBe(fakeHeader.runId);
		expect(opts?.workflow.name).toBe("mid");
		expect(opts?.ref).toBe(fakeHeader.runId);
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

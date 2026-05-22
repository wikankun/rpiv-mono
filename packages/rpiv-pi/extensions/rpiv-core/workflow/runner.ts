/**
 * Iterative session runner for the /rpiv workflow command.
 *
 * One `ctx.newSession()` per DAG node (one "stage" in the preset sequence).
 * Inside `withSession`, sends a single `freshCtx.sendUserMessage()` which
 * awaits the full agent loop. Extracts the artifact path from the session
 * branch after completion. The next stage's `newSession()` is then invoked
 * **on freshCtx** — never on the outer ctx, which is invalidated by Pi the
 * moment a session is replaced.
 *
 * Each level of the chain only ever touches the ctx it was handed:
 *   - On `cancelled === true` no replacement happened — the level's curCtx
 *     is still valid for the final notify/append.
 *   - On `cancelled === false` curCtx is stale after newSession returns; all
 *     further work was already performed inside the withSession callback on
 *     freshCtx, and the function simply unwinds.
 *
 * The session-spawn body itself lives in `executeSession` — runStage and
 * runImplementPhases are thin shells that build the prompt + labels for it.
 *
 * Vocabulary:
 *   - "stage" = one position in a preset's node sequence (a DAG node).
 *   - "phase" = one `## Phase N:` subdivision *inside an implement plan
 *     artifact* — only meaningful for the `implement` stage.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowDag } from "./dag.js";
import { WORKFLOW_DAG } from "./dag.js";
import { appendStage, generateRunId, readAllStages, type WorkflowStage, writeHeader } from "./state.js";
import { type BranchEntry, extractArtifactPath, hasAssistantMessage } from "./transcript.js";

// Re-export so existing imports of `extractArtifactPath` from "./runner.js"
// keep working — production callers and tests both rely on this surface.
export { extractArtifactPath } from "./transcript.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for running a workflow. */
export interface RunWorkflowOptions {
	/** Preset name (resolved to a linear sequence). */
	preset: string;
	/** User's input text — passed as argument to the first skill. */
	input: string;
	/** The DAG to traverse. Defaults to WORKFLOW_DAG. */
	dag?: WorkflowDag;
}

/** Result of a completed workflow run. */
export interface RunWorkflowResult {
	/** Total number of stages completed. */
	stagesCompleted: number;
	/** Whether the workflow completed all stages successfully. */
	success: boolean;
	/** The last artifact path produced, if any. */
	lastArtifact?: string;
	/** Error message if the workflow stopped due to failure. */
	error?: string;
}

// ---------------------------------------------------------------------------
// Message constants
// ---------------------------------------------------------------------------

const MSG_STAGE_PROGRESS = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;

const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;

const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;

const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

const MSG_PHASE_PROGRESS = (phase: number, total: number) => `rpiv: implement phase ${phase}/${total}`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * A ctx that can spawn the next session. Either the original handler ctx or a
 * freshCtx from `withSession` — both extend `ExtensionCommandContext`, which is
 * all we need (`ui.notify` + `newSession`). `ReplacedSessionContext` is not
 * publicly exported from `pi-coding-agent`, so we lean on the base type.
 */
type ChainCtx = ExtensionCommandContext;

const nowIso = () => new Date().toISOString();

/**
 * Run a workflow: iterate through a preset's skill sequence, creating a new
 * session for each stage, extracting artifact paths, and advancing.
 *
 * The chain is structured so that each subsequent `newSession()` is invoked
 * on the freshCtx returned from the previous withSession — never on a captured
 * outer ctx (which Pi invalidates as soon as the session is replaced).
 */
export async function runWorkflow(
	ctx: ExtensionCommandContext,
	options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
	const dag = options.dag ?? WORKFLOW_DAG;
	const nodes = dag.presets[options.preset];
	if (!nodes || nodes.length === 0) {
		return { stagesCompleted: 0, success: false, error: `Unknown preset: ${options.preset}` };
	}

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const totalStages = nodes.length;

	writeHeader(cwd, {
		runId,
		preset: options.preset,
		input: options.input,
		ts: nowIso(),
	});

	// Mutable state closed-over by the chain. Per-level closures update these
	// while their ctx is still valid; the top-level await returns the snapshot.
	// `originalInput` is frozen — the user's `/rpiv` argument. `artifactPath`
	// starts undefined and only takes a value once a stage actually produces a
	// `.rpiv/artifacts/...` path, so `countPhases` is never handed raw user
	// text masquerading as a file path.
	const state = {
		originalInput: options.input,
		artifactPath: undefined as string | undefined,
		stagesCompleted: 0,
		jsonlStage: 0,
		success: false,
		error: undefined as string | undefined,
	};

	await runStage(ctx, 0, { cwd, runId, nodes, totalStages, state });
	return {
		stagesCompleted: state.stagesCompleted,
		success: state.success,
		lastArtifact: state.artifactPath,
		error: state.error,
	};
}

interface RunContext {
	cwd: string;
	runId: string;
	nodes: string[];
	totalStages: number;
	state: {
		originalInput: string;
		artifactPath: string | undefined;
		stagesCompleted: number;
		jsonlStage: number;
		success: boolean;
		error: string | undefined;
	};
}

/**
 * Record a stage on disk and bump the in-memory counter only on a successful
 * write — keeps stage numbers in the JSONL file contiguous even if a write
 * silently fails (see `appendStage`'s boolean return).
 */
function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stage">,
	state: RunContext["state"],
): void {
	const nextStage = state.jsonlStage + 1;
	if (appendStage(cwd, runId, { stage: nextStage, ...stage })) {
		state.jsonlStage = nextStage;
	}
}

/**
 * After a stage fails, surface every artifact recorded so far so the user
 * doesn't have to grep the JSONL to see what survived.
 */
function notifyPartialArtifacts(ctx: ChainCtx, cwd: string, runId: string): void {
	const artifactPaths = readAllStages(cwd, runId)
		.filter((s) => s.artifact)
		.map((s) => `  • ${s.skill}: ${s.artifact}`)
		.join("\n");
	if (artifactPaths) {
		ctx.ui.notify(`Artifacts produced before failure:\n${artifactPaths}`, "info");
	}
}

/**
 * Parameters for one session spawn — fully captures the asymmetries between
 * runStage and runImplementPhases so the spawn body itself can live in one place.
 */
interface ExecuteSessionParams {
	cwd: string;
	runId: string;
	state: RunContext["state"];
	/** The `/skill:<name> <args>` line to send into the fresh session. */
	prompt: string;
	/** Base skill name — used for the JSONL "skill" field on failed and skipped rows. */
	skill: string;
	/** Optional override applied only to the *successful* JSONL row's "skill" field. */
	successSkill?: string;
	/** Message stored in state.error when the session yields no assistant message. */
	errorMessage: string;
	/** Whether to emit `MSG_STAGE_COMPLETE(skill)` on success (stages yes; phases hold until all phases done). */
	emitCompleteOnSuccess: boolean;
	/** Optional hook invoked inside withSession after the failed row is recorded — used for the partial-artifacts recap. */
	onFailure?: (freshCtx: ChainCtx) => void;
	/** Invoked inside withSession after success bookkeeping. `freshCtx` is the valid ctx for further chaining. */
	onSuccess: (freshCtx: ChainCtx, artifact: string | undefined) => Promise<void>;
}

/**
 * Spawn one fresh session, send `prompt`, inspect the resulting branch, and
 * fan into either `onSuccess(freshCtx, artifact)` (when the agent responded)
 * or `onFailure?.(freshCtx)` after recording a failed row.
 *
 * All chain recursion happens inside the success path on `freshCtx` — the
 * outer `curCtx` is invalid as soon as newSession resolves.
 */
async function executeSession(curCtx: ChainCtx, p: ExecuteSessionParams): Promise<void> {
	const { cancelled } = await curCtx.newSession({
		withSession: async (freshCtx) => {
			await freshCtx.sendUserMessage(p.prompt);

			const branch = freshCtx.sessionManager.getBranch() as unknown as BranchEntry[];
			const artifact = extractArtifactPath(branch);

			if (!hasAssistantMessage(branch)) {
				recordStage(p.cwd, p.runId, { skill: p.skill, status: "failed", ts: nowIso() }, p.state);
				freshCtx.ui.notify(MSG_STAGE_FAILED(p.skill), "error");
				p.onFailure?.(freshCtx);
				p.state.error = p.errorMessage;
				return;
			}

			if (artifact) p.state.artifactPath = artifact;
			recordStage(
				p.cwd,
				p.runId,
				{ skill: p.successSkill ?? p.skill, artifact, status: "completed", ts: nowIso() },
				p.state,
			);
			if (p.emitCompleteOnSuccess) {
				freshCtx.ui.notify(MSG_STAGE_COMPLETE(p.skill), "info");
			}
			p.state.stagesCompleted++;

			// Chain on freshCtx — outer curCtx is about to be invalidated.
			await p.onSuccess(freshCtx, artifact);
		},
	});

	if (cancelled) {
		recordStage(p.cwd, p.runId, { skill: p.skill, status: "skipped", ts: nowIso() }, p.state);
		curCtx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	}
}

/**
 * Run a single workflow stage at index `idx`, then chain into the next stage
 * (or finalize) using whichever ctx is valid inside withSession.
 */
async function runStage(curCtx: ChainCtx, idx: number, run: RunContext): Promise<void> {
	const { cwd, runId, nodes, totalStages, state } = run;

	if (idx >= nodes.length) {
		curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
		state.success = true;
		return;
	}

	const skill = nodes[idx]!;
	const stageNumber = idx + 1;

	// Multi-phase expand: when implement runs against a plan artifact with
	// `## Phase N:` headings, fan out one session per phase.
	if (skill === "implement" && state.artifactPath) {
		const phaseCount = countPhases(state.artifactPath, cwd);
		if (phaseCount > 0) {
			await runImplementPhases(curCtx, idx, 1, phaseCount, run);
			return;
		}
	}

	curCtx.ui.notify(MSG_STAGE_PROGRESS(stageNumber, totalStages, skill), "info");
	// First stage has no prior artifact yet — fall back to the original brief
	// so /skill:<name> gets a meaningful argument.
	const inputForStage = state.artifactPath ?? state.originalInput;

	await executeSession(curCtx, {
		cwd,
		runId,
		state,
		prompt: `/skill:${skill} ${inputForStage}`,
		skill,
		errorMessage: `${skill} failed`,
		emitCompleteOnSuccess: true,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, cwd, runId),
		onSuccess: (freshCtx) => runStage(freshCtx, idx + 1, run),
	});
}

/**
 * Run the multi-phase expansion of an `implement` stage for phase `p` of
 * `phaseCount`, then chain into the next phase or back into the main stage
 * loop. Specific to the `implement` skill — generic-stage logic lives in
 * `runStage`.
 */
async function runImplementPhases(
	curCtx: ChainCtx,
	stageIdx: number,
	p: number,
	phaseCount: number,
	run: RunContext,
): Promise<void> {
	const { cwd, runId, nodes, state } = run;
	const skill = nodes[stageIdx]!;

	if (p > phaseCount) {
		curCtx.ui.notify(MSG_STAGE_COMPLETE(skill), "info");
		await runStage(curCtx, stageIdx + 1, run);
		return;
	}

	curCtx.ui.notify(MSG_PHASE_PROGRESS(p, phaseCount), "info");

	await executeSession(curCtx, {
		cwd,
		runId,
		state,
		prompt: `/skill:implement ${state.artifactPath} Phase ${p}`,
		skill,
		// Successful phase rows are labelled with their position; failed/skipped
		// rows are stored under the base skill name (preserved invariant).
		successSkill: `implement (phase ${p}/${phaseCount})`,
		errorMessage: `${skill} phase ${p} failed`,
		emitCompleteOnSuccess: false,
		onSuccess: (freshCtx) => runImplementPhases(freshCtx, stageIdx, p + 1, phaseCount, run),
	});
}

// ---------------------------------------------------------------------------
// Multi-phase detection (implement skill)
// ---------------------------------------------------------------------------

/** Regex for phase headings in plan artifacts: ## Phase N: {name} */
const PHASE_HEADING_REGEX = /^## Phase (\d+):/gm;

/**
 * Count the number of phases in a plan artifact.
 * Reads the file synchronously and counts `## Phase N:` headings.
 * Returns 0 if the file doesn't exist or has no phase headings.
 * Fail-soft: never throws.
 */
export function countPhases(planPath: string, cwd?: string): number {
	const base = cwd ?? process.cwd();
	const absolutePath = planPath.startsWith("/") ? planPath : join(base, planPath);
	try {
		const content = readFileSync(absolutePath, "utf-8");
		const matches = content.match(PHASE_HEADING_REGEX);
		return matches ? matches.length : 0;
	} catch {
		return 0;
	}
}

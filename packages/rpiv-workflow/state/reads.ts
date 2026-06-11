/**
 * Fail-soft JSONL readers. Shape-filtered, never positional — the same
 * file can carry a header, stage rows, and routing rows, and readers
 * pluck whichever rows match their predicate.
 *
 * Per-line parse: each `JSON.parse` runs in its own try/catch — a single
 * truncated trailing line (process killed mid-append, ENOSPC, network
 * FS hiccup) MUST NOT erase prior rows.
 *
 * Public surface:
 *
 *   - Per-row readers (`readLastStage`, `readAllStages`,
 *     `readRoutingDecisions`) — open ONE run's JSONL and project rows
 *     of the matching shape.
 *   - Past-runs API (`readHeader`, `listRuns`, `listArtifacts`) —
 *     header-only or projection-only reads sized for inspect UIs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Artifact } from "../handle.js";
import { formatError } from "../internal-utils.js";
import { isValidName, readNamesIndex, rebuildIndex } from "./names.js";
import { runsDir, stateFilePath } from "./paths.js";
import type { LoopCapRow, RoutingDecision, RunSummary, WorkflowHeader, WorkflowStage } from "./state.js";

/**
 * Reads every line, filters by shape (not position). Header has no
 * `stageNumber`; routing rows carry `type: "routing"`; stage rows have
 * `stageNumber: number` and no `type`. Starting at line 0 keeps the first
 * stage row recoverable even if a transient writeHeader failure left the
 * file without its header.
 *
 * Each line's `JSON.parse` runs in its own try/catch — a truncated trailing
 * line (process killed mid-`appendFileSync`, ENOSPC, network FS hiccup)
 * MUST NOT erase prior rows. Malformed lines emit a one-shot warn and are
 * skipped; readers see every well-formed row that landed on disk.
 */
function readJsonlRows<T>(cwd: string, runId: string, match: (row: unknown) => row is T): T[] {
	const rows: T[] = [];
	for (const parsed of readParsedRows(cwd, runId)) {
		if (match(parsed)) rows.push(parsed);
	}
	return rows;
}

/** Every well-formed JSON row, unfiltered — the shared base under `readJsonlRows` + the strict resume reader. */
function readParsedRows(cwd: string, runId: string): unknown[] {
	let lines: string[];
	try {
		const filePath = stateFilePath(cwd, runId);
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		lines = content.split("\n");
	} catch (e) {
		console.warn(`[rpiv-workflow] workflow state: ${formatError(e)}`);
		return [];
	}

	const rows: unknown[] = [];
	for (const line of lines) {
		try {
			rows.push(JSON.parse(line));
		} catch (e) {
			console.warn(`[rpiv-workflow] workflow state: skipping malformed JSONL row — ${formatError(e)}`);
		}
	}
	return rows;
}

const STAGE_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "skipped", "aborted"]);

/**
 * Stage-SHAPED: carries a numeric `stageNumber` (no other row kind does).
 * Pre-filter for the strict resume reader — a stage-shaped row failing the
 * deep `isWorkflowStage` guard is a MALFORMED stage row, not a foreign kind.
 */
const isStageShaped = (row: unknown): row is { stageNumber: number; stage?: unknown } =>
	!!row && typeof (row as { stageNumber?: unknown }).stageNumber === "number";

/**
 * Deep guard for the fields downstream consumers actually depend on —
 * not just "has a stageNumber": `status` must be a member of the enum
 * (the resume fold branches on it), `output.artifacts` must be an array
 * when `output` is present (`applyCompletedStage` indexes it), and a
 * loop-unit row (`parent` set) must carry a numeric `unitIndex` (the
 * resume drift guard compares it).
 */
const isWorkflowStage = (row: unknown): row is WorkflowStage => {
	const r = row as Partial<WorkflowStage> | null;
	if (!r || typeof r.stageNumber !== "number" || typeof r.stage !== "string") return false;
	if (typeof r.status !== "string" || !STAGE_STATUSES.has(r.status)) return false;
	if (r.output !== undefined && !Array.isArray((r.output as { artifacts?: unknown } | null)?.artifacts)) return false;
	if (r.parent !== undefined && typeof r.unitIndex !== "number") return false;
	return true;
};

const isRoutingDecision = (row: unknown): row is RoutingDecision =>
	!!row && (row as { type?: unknown }).type === "routing";

/** Shape guard for loop-cap telemetry rows. */
const isLoopCapRow = (r: unknown): r is LoopCapRow => (r as { type?: unknown } | undefined)?.type === "loop-cap";

const isWorkflowHeader = (row: unknown): row is WorkflowHeader =>
	!!row &&
	typeof (row as { runId?: unknown }).runId === "string" &&
	typeof (row as { workflow?: unknown }).workflow === "string" &&
	typeof (row as { input?: unknown }).input === "string" &&
	typeof (row as { ts?: unknown }).ts === "string";

// ---------------------------------------------------------------------------
// Per-run readers
// ---------------------------------------------------------------------------

export function readLastStage(cwd: string, runId: string): WorkflowStage | undefined {
	const stages = readJsonlRows(cwd, runId, isWorkflowStage);
	return stages.length ? stages[stages.length - 1] : undefined;
}

export function readAllStages(cwd: string, runId: string): WorkflowStage[] {
	return readJsonlRows(cwd, runId, isWorkflowStage);
}

/**
 * Resume-grade reader: same projection as `readAllStages`, but a row that is
 * stage-SHAPED while failing the deep stage guard REFUSES instead of being
 * skipped. Display readers may shrug off a malformed row; the resume fold
 * replays the trail as its system of record, and silently dropping a row
 * would replay a hole ("this stage never ran") — e.g. route onward past a
 * stage whose failure row lost its `status`.
 */
export function readAllStagesForResume(
	cwd: string,
	runId: string,
): { ok: true; rows: WorkflowStage[] } | { ok: false; detail: string } {
	const rows: WorkflowStage[] = [];
	for (const parsed of readParsedRows(cwd, runId)) {
		if (isWorkflowStage(parsed)) {
			rows.push(parsed);
			continue;
		}
		if (isStageShaped(parsed)) {
			const label = typeof parsed.stage === "string" ? ` ("${parsed.stage}")` : "";
			return { ok: false, detail: `stage row ${parsed.stageNumber}${label} failed the shape guard` };
		}
	}
	return { ok: true, rows };
}

export function readRoutingDecisions(cwd: string, runId: string): RoutingDecision[] {
	return readJsonlRows(cwd, runId, isRoutingDecision);
}

/** All loop-cap telemetry rows for a run, in trail order. */
export function readLoopCaps(cwd: string, runId: string): LoopCapRow[] {
	return readJsonlRows(cwd, runId, isLoopCapRow);
}

/**
 * Project a run's stage rows to the (stage, artifact) pairs that
 * actually carried at least one artifact. One entry per artifact —
 * stages with multi-artifact collectors expand to N entries. Used by
 * `notifyPartialArtifacts` for the failure recap and by past-runs UIs
 * (the `listRuns` API) for run summaries.
 *
 * `stage` is the workflow stage's record key (always present); `skill`
 * is the Pi skill body when this row recorded a skill stage (absent
 * for script stages).
 *
 * Reads from `output.artifacts` (single source); rows without an
 * output, or with an empty artifacts list, contribute nothing.
 */
export function listArtifacts(
	cwd: string,
	runId: string,
): Array<{ stage: string; skill?: string; artifact: Artifact }> {
	const out: Array<{ stage: string; skill?: string; artifact: Artifact }> = [];
	for (const s of readAllStages(cwd, runId)) {
		const artifacts = s.output?.artifacts;
		if (!artifacts) continue;
		for (const artifact of artifacts) out.push({ stage: s.stage, skill: s.skill, artifact });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Past-runs enumeration (header-only)
// ---------------------------------------------------------------------------

/**
 * Read only the first JSONL line and parse it as a `WorkflowHeader`. Used
 * by `listRuns` so enumerating N past runs reads N first-lines instead
 * of fully parsing every row in every file. Returns undefined when the
 * file is missing, empty, or the first line doesn't match the header
 * shape.
 *
 * Fail-soft like every other reader — never throws.
 *
 * Takes a concrete `runId`. For a user-supplied reference that may later need
 * symbolic resolution (`@latest`, relative), call `resolveRun` instead.
 */
export function readHeader(cwd: string, runId: string): WorkflowHeader | undefined {
	try {
		const filePath = stateFilePath(cwd, runId);
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8");
		const firstLine = content.split("\n", 1)[0] ?? "";
		if (!firstLine) return undefined;
		const parsed = JSON.parse(firstLine);
		return isWorkflowHeader(parsed) ? parsed : undefined;
	} catch {
		// Malformed JSON or I/O error — caller treats as "header unreadable".
		return undefined;
	}
}

/**
 * Resolve a run *reference* to its header — the ref-resolution seam.
 *
 * Which to call: reach for `resolveRun` when the ref is **user-supplied** (the
 * `/wf @<ref>` token, a CLI arg); reach for `readHeader` when you already hold
 * a concrete `runId` (e.g. straight off `RunSummary.runId`). The split is
 * intent, not behaviour.
 *
 * Resolution order:
 *  1. Check the names index (`names.json`) for a name → runId mapping on the
 *     RAW ref. If found and the target JSONL exists, return its header.
 *  2. Fall back to runId lookup via `readHeader`, on the ref normalized to a
 *     slug — a trailing `.jsonl` is stripped and any directory prefix is
 *     dropped (`basename`). This lets `/wf @<path>` accept an editor's
 *     file-autosuggested path to the run's JSONL (`.../runs/<id>.jsonl`),
 *     a bare `<id>.jsonl`, or the plain `<id>` slug interchangeably.
 *  3. Index-miss recovery: if both lookups failed AND the ref is a
 *     well-formed run name absent from the index, rebuild `names.json` from
 *     the JSONL headers (`rebuildIndex`) and retry the name lookup once —
 *     a deleted/corrupt `names.json` no longer orphans named runs.
 *
 * Name lookup stays on the raw ref: a run name is never a path, so a name like
 * `auth.jsonl` (were it ever claimed) must match verbatim, not as a slug.
 *
 * Fail-soft like every reader — returns undefined when the ref doesn't resolve.
 */
export function resolveRun(cwd: string, ref: string): WorkflowHeader | undefined {
	// Try the names index first — O(1) lookup for human-readable aliases.
	// Matched on the raw ref: a name is never a path/`.jsonl` file.
	const index = readNamesIndex(cwd);
	if (index?.[ref]) {
		const resolved = readHeader(cwd, index[ref]!);
		if (resolved) return resolved;
	}
	// Fall back to runId lookup, tolerating a pasted/autosuggested path:
	// reduce to the bare slug (drop dir prefix + trailing `.jsonl`).
	const slug = basename(ref).replace(/\.jsonl$/, "");
	const bySlug = readHeader(cwd, slug);
	if (bySlug) return bySlug;
	// Recovery: a lost/corrupt names.json silently orphans named runs. Rebuild
	// from headers only when the ref LOOKS like a name the index should have
	// carried (valid shape, not present) — an unresolvable runId slug never
	// triggers the O(runs) rescan.
	if (isValidName(ref) && !index?.[ref]) {
		const runId = rebuildIndex(cwd)?.[ref];
		if (runId) return readHeader(cwd, runId);
	}
	return undefined;
}

/**
 * Enumerate every `<cwd>/.rpiv/workflows/runs/<run-id>.jsonl` and return its
 * header projected as a `RunSummary`. Empty array when the runs
 * directory doesn't exist (no runs yet). Files without a valid header
 * are skipped silently (corrupt / mid-write).
 *
 * Header-only reads — full stage rows aren't parsed (see `readHeader`'s
 * doc). Past-runs UIs page through the summary; opening a specific run
 * for inspection still calls `readAllStages` / `listArtifacts`.
 *
 * Sort is filesystem-order — callers that want chronological order can
 * sort by `ts` (run-id slug already encodes time, so a string sort on
 * `runId` is monotonic for runs created on the same host).
 */
export function listRuns(cwd: string): RunSummary[] {
	const dir = runsDir(cwd);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// Directory doesn't exist (no runs yet) or unreadable — treat as empty.
		return [];
	}
	const summaries: RunSummary[] = [];
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const runId = name.slice(0, -".jsonl".length);
		const header = readHeader(cwd, runId);
		if (header)
			summaries.push({
				runId: header.runId,
				workflow: header.workflow,
				input: header.input,
				ts: header.ts,
				trigger: header.trigger,
				name: header.name,
			});
	}
	return summaries;
}

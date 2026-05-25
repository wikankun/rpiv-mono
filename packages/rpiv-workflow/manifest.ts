/**
 * Manifest types — the inter-stage data channel. A manifest is extracted
 * by the runner (not authored by the agent), flows through RunState, and
 * is persisted to the JSONL audit log.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitCommitData } from "./extractors/git-commit.js";
import type { BranchEntry } from "./transcript.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Manifest envelope
// ---------------------------------------------------------------------------

export interface ManifestMeta {
	skill: string;
	/** 1-based; matches `WorkflowStage.stageNumber`. */
	stageNumber: number;
	/** ISO-8601. */
	ts: string;
	/** Duplicated from header for ergonomic JSONL reads. */
	runId: string;
}

export interface Manifest<K extends string = string, D = unknown> {
	kind: K;
	/** Present when the stage produced a file consumable by downstream stages. */
	artifact_path?: string;
	data: D;
	meta: ManifestMeta;
}

// ---------------------------------------------------------------------------
// Built-in manifest kinds
//
// Aliases enable consumer-side tagged-union narrowing on `manifest.kind` —
// the value of the abstraction is the narrowing pattern, not the count of
// current importers. Data shapes live with their producing extractors;
// `GitCommitData` is sourced from `extractors/git-commit.ts` (type-only
// import — no runtime cycle).
// ---------------------------------------------------------------------------

export type ArtifactMdManifest = Manifest<"artifact-md", Record<string, unknown>>;
export type SideEffectManifest = Manifest<"side-effect", Record<string, never>>;
export type GitCommitManifest = Manifest<"git-commit", GitCommitData>;

// ---------------------------------------------------------------------------
// Snapshot + extractor function signatures
// ---------------------------------------------------------------------------

export interface SnapshotCtx {
	cwd: string;
	runId: string;
	stageIndex: number;
	state: Readonly<RunState>;
	/** Optional — not all snapshots need pi; may be absent in tests. */
	pi?: ExtensionAPI;
}

/** Fail-soft: implementations catch and return undefined rather than throwing. */
export type SnapshotFn = (ctx: SnapshotCtx) => Promise<unknown> | unknown;

export interface ExtractorCtx extends SnapshotCtx {
	branch: BranchEntry[];
	/** Entries before this index belong to prior stages (continue policies). */
	branchOffset?: number;
	snapshot: unknown | undefined;
	/** Filled by the runner; extractors must NOT set `manifest.meta.skill` themselves. */
	skill: string;
}

export interface ExtractorPayload<K extends string = string, D = unknown> {
	kind: K;
	artifact_path?: string;
	data: D;
}

/**
 * Three-way return from an extractor — same shape as
 * `sessions.ts:ExtractionOutcome` so the runner's `runExtractor` is a
 * pure pass-through (no translation step).
 *
 *   `kind: "ok"` + `payload: ExtractorPayload`  — stage emitted an artifact.
 *   `kind: "ok"` + `payload: undefined`         — agent-end stage; chain inherits prior manifest.
 *   `kind: "fatal"`                              — extractor cannot satisfy its contract; runner halts.
 */
export type ExtractorResult =
	| { kind: "ok"; payload: ExtractorPayload | undefined }
	| { kind: "fatal"; message: string };

/**
 * Contract — when must an extractor return `{ kind: "fatal" }`? If the
 * protocol REQUIRES a structural output (artifact-emit nodes that promise
 * an `.rpiv/artifacts/...` path) and that output is absent, the extractor
 * MUST return `{ kind: "fatal", message }`. Agent-end / side-effect
 * extractors never return `"fatal"` — success follows from `classifyStop`.
 *
 * Every concrete extractor declares which side of the contract it sits on
 * by the `kind` values it can return.
 */
export type ExtractorFn = (ctx: ExtractorCtx) => Promise<ExtractorResult> | ExtractorResult;

/**
 * An extractor bundles the (optional) pre-stage capture with the post-stage
 * read. `before` runs once before the agent loop spawns; its return value
 * lands in `ctx.snapshot` for `extract`. Co-locating the pair makes the
 * relationship structural: a `before` without an `extract` to consume it
 * can't be declared.
 */
export interface Extractor {
	before?: SnapshotFn;
	extract: ExtractorFn;
}

/** Single source of manifest metadata authorship. */
export function finalizeManifest(payload: ExtractorPayload, meta: ManifestMeta): Manifest {
	return {
		kind: payload.kind,
		artifact_path: payload.artifact_path,
		data: payload.data,
		meta,
	};
}

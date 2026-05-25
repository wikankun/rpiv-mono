/**
 * jiti-based loader for user-authored workflows.
 *
 * Layered merge: `built-in` ← `user` ← `project`. Within each non-built-in
 * layer, drop-in files merge first (alpha-sorted filename), then the
 * canonical file — so the file the user wrote by hand wins over any packs
 * they installed via drop-in.
 *
 * Paths (per layer):
 *   user    — canonical  `~/.config/rpiv-workflow/workflows.config.ts`
 *             drop-ins   `~/.config/rpiv-workflow/workflows/*.ts`
 *   project — canonical  `<cwd>/.rpiv-workflow/workflows.config.ts`
 *             drop-ins   `<cwd>/.rpiv-workflow/workflows/*.ts`
 *
 * Canonical file — accepts three default-export shapes:
 *   1. A single `Workflow`              — single-entry namespace
 *   2. `Workflow[]`                     — multi-entry, default required if > 1
 *   3. `{ workflows, default? }`        — full envelope, explicit default
 *
 * Drop-in file — accepts only `Workflow | Workflow[]`. The envelope form
 * is rejected because `default` lives in the canonical file (one source of
 * truth per layer); a drop-in pack that tries to override the default
 * surfaces as a warning and the `default` field is ignored.
 *
 * `default` cascades layer-by-layer (project canonical > user canonical >
 * built-in `mid`); within a layer only the canonical file can set it.
 *
 * jiti loads `.ts` directly — no build step required of users. Loader
 * failures (file throws on import, exports the wrong shape) are captured as
 * `LoadIssue`s; the loader itself never throws to its caller.
 *
 * SECURITY NOTE — `jiti.import` synchronously evaluates every overlay
 * file's top-level code on every `/wf` invocation. The threat boundary
 * is the same as `npm install` (post-install scripts), `tsx some-script.ts`,
 * or any tool that respects `<cwd>` configuration: Pi already operates in
 * a context that implicitly trusts the current working directory. Users
 * running Pi in a freshly-cloned untrusted repo should diff
 * `.rpiv-workflow/workflows.config.ts` and `.rpiv-workflow/workflows/*.ts`
 * before running `/wf`, since each file executes arbitrary TypeScript on
 * load.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { createJiti } from "jiti";
import type { Workflow } from "./api.js";
import { getBuiltIns } from "./built-ins.js";
import type { ConfigLayer } from "./layers.js";
import { validateWorkflow, type WorkflowValidationIssue } from "./validate-workflow.js";

// ===========================================================================
// Public types
// ===========================================================================

export type { ConfigLayer } from "./layers.js";

export interface LoadIssue {
	kind: "load";
	layer: ConfigLayer;
	path?: string;
	severity: "error" | "warning";
	message: string;
}

export type Issue = LoadIssue | (WorkflowValidationIssue & { kind: "validation"; layer: ConfigLayer; path?: string });

export interface LoadedWorkflows {
	workflows: readonly Workflow[];
	default: string;
	/** Which layer each merged workflow name came from. */
	workflowSources: ReadonlyMap<string, ConfigLayer>;
	/** Every layer that registered at least one workflow, low-to-high. */
	layers: readonly ConfigLayer[];
	/** Aggregated load + validation issues. Errors block the runner; warnings are advisory. */
	issues: readonly Issue[];
}

// ===========================================================================
// Paths
// ===========================================================================

export interface OverlayPaths {
	/** Canonical file — the only place `default` may live. */
	canonical: string;
	/** Drop-in directory — alpha-sorted `*.ts` files merged before canonical. */
	dropInDir: string;
}

/** Project overlay paths under `<cwd>/.rpiv-workflow/`. */
export function projectOverlayPaths(cwd: string): OverlayPaths {
	const root = join(cwd, ".rpiv-workflow");
	return { canonical: join(root, "workflows.config.ts"), dropInDir: join(root, "workflows") };
}

/** User overlay paths under `~/.config/rpiv-workflow/`. */
export function userOverlayPaths(): OverlayPaths {
	return {
		canonical: configPath("rpiv-workflow", "workflows.config.ts"),
		dropInDir: configPath("rpiv-workflow", "workflows"),
	};
}

// ===========================================================================
// Loader
// ===========================================================================

/** Default workflow name when no overlay specifies one — matches the historic "mid". */
export const FALLBACK_DEFAULT_WORKFLOW = "mid";

const jiti = createJiti(import.meta.url, {
	// Bypass jiti's module cache so /reload picks up edits without restart.
	moduleCache: false,
	fsCache: false,
});

/**
 * mtime-keyed import cache. jiti's own caches are disabled so `/reload`
 * picks up edits without restart; this wrapper layers a stat-driven
 * cache on top so unchanged overlays don't re-evaluate top-level code
 * on every `/wf` invocation.
 *
 * Cache miss: stat the file, call `jiti.import`, store the
 * (mtimeMs, parsed) tuple keyed by absolute path. Cache hit: stat
 * the file, compare mtimeMs, return the cached value if equal.
 *
 * The cache does not invalidate on file deletion — a stale entry for
 * a deleted overlay sits dormant (the enumerator never passes it back
 * to `cachedImport`). The cache resets on `__resetLoadCache()` (wired
 * into test/setup.ts beforeEach) and on process exit.
 */
const overlayCache = new Map<string, { mtimeMs: number; parsed: unknown }>();

async function cachedImport(path: string): Promise<unknown> {
	const stat = statSync(path);
	const cached = overlayCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
	const value = await jiti.import(path, { default: true });
	overlayCache.set(path, { mtimeMs: stat.mtimeMs, parsed: value });
	return value;
}

/** Test-only reset. Wired into `test/setup.ts` `beforeEach` so per-test
 * cache isolation survives the mtime cache. */
export function __resetLoadCache(): void {
	overlayCache.clear();
}

interface ParsedConfig {
	workflows: Workflow[];
	default?: string;
}

/**
 * Mutable bag of state threaded through `loadLayer` → `loadOverlayFile`
 * → `mergeOverlay`. Each helper writes into `acc.issues` /
 * `acc.workflowMap` / `acc.sources` / `acc.sourcePaths` in place;
 * `loadWorkflows` reads them at the end to project the public
 * `LoadedWorkflows` envelope.
 *
 * Lives in a struct so future loader features add fields here rather
 * than threading another mutable parameter through three call layers.
 */
interface LoadAccumulator {
	issues: Issue[];
	workflowMap: Map<string, Workflow>;
	sources: Map<string, ConfigLayer>;
	sourcePaths: Map<string, string | undefined>;
}

/**
 * What a per-layer load returns to the orchestrator. `contributed`
 * controls the `LoadedWorkflows.layers` banner; `canonicalDefault`
 * feeds `resolveDefault` (drop-in files don't set defaults — see
 * `normalizeDefaultExport`'s drop-in hard-reject).
 */
interface LayerOutcome {
	contributed: boolean;
	canonicalDefault: string | undefined;
}

function loadError(acc: LoadAccumulator, layer: ConfigLayer, path: string | undefined, message: string): void {
	acc.issues.push({ kind: "load", layer, path, severity: "error", message });
}

/**
 * Load every active layer, merge by workflow name, validate, and return the
 * resolved set. Never throws — load + validation errors flow through `issues`.
 */
export async function loadWorkflows(cwd: string): Promise<LoadedWorkflows> {
	const acc: LoadAccumulator = {
		issues: [],
		workflowMap: new Map(),
		sources: new Map(),
		sourcePaths: new Map(),
	};
	const layers: ConfigLayer[] = getBuiltIns().length > 0 ? ["built-in"] : [];

	for (const w of getBuiltIns()) {
		acc.workflowMap.set(w.name, w);
		acc.sources.set(w.name, "built-in");
		acc.sourcePaths.set(w.name, undefined);
	}

	const userOutcome = await loadLayer(userOverlayPaths(), "user", acc);
	if (userOutcome.contributed) layers.push("user");

	const projectOutcome = await loadLayer(projectOverlayPaths(cwd), "project", acc);
	if (projectOutcome.contributed) layers.push("project");

	// Validate every merged workflow once. Validation runs even on built-in so
	// that a future built-in regression surfaces in the same channel as user
	// errors. Each issue is attributed to the exact file the surviving workflow
	// came from (drop-in or canonical) so `/wf` previews can render
	// `[<layer> config (<path>)] workflow "X": ...` errors.
	for (const w of acc.workflowMap.values()) {
		const layer = acc.sources.get(w.name) ?? "built-in";
		const path = acc.sourcePaths.get(w.name);
		for (const v of validateWorkflow(w)) acc.issues.push({ ...v, kind: "validation", layer, path });
	}

	const defaultName = resolveDefault(projectOutcome.canonicalDefault, userOutcome.canonicalDefault, acc);

	return {
		workflows: [...acc.workflowMap.values()],
		default: defaultName,
		workflowSources: acc.sources,
		layers,
		issues: acc.issues,
	};
}

// ---------------------------------------------------------------------------
// Per-layer loading
// ---------------------------------------------------------------------------

/**
 * Load one layer's drop-ins (alpha-sorted) then its canonical file, merging
 * into the accumulator in that order so the canonical file's workflows win
 * over drop-ins of the same name. The returned `LayerOutcome.canonicalDefault`
 * carries the canonical file's `default` field (or `undefined`) — drop-in
 * `default` fields are rejected at normalisation, so they never participate
 * in default resolution.
 *
 * `LayerOutcome.contributed` is `false` only when neither the canonical
 * file nor any drop-in existed; that signals to `loadWorkflows` not to
 * append the layer to the `layers` banner.
 */
async function loadLayer(paths: OverlayPaths, layer: ConfigLayer, acc: LoadAccumulator): Promise<LayerOutcome> {
	let contributed = false;
	let canonicalDefault: string | undefined;

	for (const dropInPath of enumerateDropIns(paths.dropInDir)) {
		const parsed = await loadOverlayFile(dropInPath, layer, acc, "drop-in");
		if (!parsed) continue;
		mergeOverlay(parsed, layer, dropInPath, acc);
		contributed = true;
	}

	if (existsSync(paths.canonical)) {
		const canonicalParsed = await loadOverlayFile(paths.canonical, layer, acc, "canonical");
		if (canonicalParsed) {
			mergeOverlay(canonicalParsed, layer, paths.canonical, acc);
			canonicalDefault = canonicalParsed.default;
			contributed = true;
		}
	}

	return { contributed, canonicalDefault };
}

/** Alpha-sorted `*.ts` files directly under `dir`. Empty array if `dir` doesn't exist. */
function enumerateDropIns(dir: string): string[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => join(dir, name));
}

// ---------------------------------------------------------------------------
// Per-file loading
// ---------------------------------------------------------------------------

type FileKind = "canonical" | "drop-in";

async function loadOverlayFile(
	path: string,
	layer: ConfigLayer,
	acc: LoadAccumulator,
	kind: FileKind,
): Promise<ParsedConfig | undefined> {
	let raw: unknown;
	try {
		raw = await cachedImport(path);
	} catch (e) {
		loadError(acc, layer, path, `failed to import ${path}: ${formatError(e)}`);
		return undefined;
	}

	const parsed = normalizeDefaultExport(raw, kind);
	if (parsed.kind === "err") {
		loadError(acc, layer, path, parsed.error);
		return undefined;
	}
	return parsed.value;
}

type NormalizeResult = { kind: "ok"; value: ParsedConfig } | { kind: "err"; error: string };

/**
 * Canonical files accept three default-export shapes; drop-ins accept only
 * the first two (`Workflow | Workflow[]`). The envelope form is rejected
 * for drop-ins so authors don't trip the silent "default lives somewhere
 * else" gotcha.
 */
function normalizeDefaultExport(raw: unknown, kind: FileKind): NormalizeResult {
	if (isWorkflow(raw)) return { kind: "ok", value: { workflows: [raw] } };
	if (Array.isArray(raw)) {
		if (raw.length === 0) {
			return { kind: "err", error: "default-export `Workflow[]` must contain at least one Workflow" };
		}
		if (!raw.every(isWorkflow)) {
			return { kind: "err", error: "default export array must contain only Workflow objects" };
		}
		// A bare Workflow[] omits the `default` slot; with more than one entry
		// there's no unambiguous pick. Require the envelope form so the choice
		// is explicit. (Single-entry arrays are accepted — only one workflow
		// to default to.) Drop-ins reject the envelope anyway, so a multi-entry
		// drop-in array gets the same hard error as a canonical one — that's
		// fine; the author should split into one file per workflow.
		if (raw.length > 1) {
			return {
				kind: "err",
				error:
					"default-export `Workflow[]` with more than one entry must be wrapped as " +
					'`{ workflows: [...], default: "<name>" }` so the default workflow is explicit',
			};
		}
		return { kind: "ok", value: { workflows: raw as Workflow[] } };
	}
	if (isEnvelope(raw)) {
		if (kind === "drop-in") {
			return {
				kind: "err",
				error:
					"drop-in workflow files must export a `Workflow` or `Workflow[]` — the " +
					"`{ workflows, default? }` envelope is only accepted in the canonical workflows.config.ts.",
			};
		}
		if (!raw.workflows.every(isWorkflow)) {
			return { kind: "err", error: "default-export `workflows` must contain only Workflow objects" };
		}
		return { kind: "ok", value: { workflows: raw.workflows, default: raw.default } };
	}
	return {
		kind: "err",
		error:
			"default export must be a Workflow, Workflow[], or { workflows: Workflow[]; default?: string } — " +
			`got ${describe(raw)}`,
	};
}

interface Envelope {
	workflows: Workflow[];
	default?: string;
}

function isWorkflow(v: unknown): v is Workflow {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.name === "string" &&
		typeof o.start === "string" &&
		typeof o.nodes === "object" &&
		o.nodes !== null &&
		typeof o.edges === "object" &&
		o.edges !== null
	);
}

function isEnvelope(v: unknown): v is Envelope {
	if (!v || typeof v !== "object") return false;
	return Array.isArray((v as Record<string, unknown>).workflows);
}

function describe(v: unknown): string {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	if (Array.isArray(v)) return "an array";
	return typeof v;
}

function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Merge + default resolution
// ---------------------------------------------------------------------------

function mergeOverlay(parsed: ParsedConfig, layer: ConfigLayer, path: string, acc: LoadAccumulator): void {
	for (const w of parsed.workflows) {
		acc.workflowMap.set(w.name, w);
		acc.sources.set(w.name, layer);
		acc.sourcePaths.set(w.name, path);
	}
}

/**
 * Project default wins over user default wins over built-in `mid`. An
 * explicit `default` that doesn't name an existing workflow records an
 * error and falls through to the next layer. Only the canonical file in
 * each layer can set `default` — drop-in `default` fields are stripped at
 * load time.
 */
function resolveDefault(
	projectDefault: string | undefined,
	userDefault: string | undefined,
	acc: LoadAccumulator,
): string {
	const candidates: Array<{ name: string | undefined; layer: ConfigLayer }> = [
		{ name: projectDefault, layer: "project" },
		{ name: userDefault, layer: "user" },
	];

	for (const { name, layer } of candidates) {
		if (!name) continue;
		if (acc.workflowMap.has(name)) return name;
		loadError(acc, layer, undefined, `default workflow "${name}" (from ${layer} config) is not declared`);
	}

	if (acc.workflowMap.has(FALLBACK_DEFAULT_WORKFLOW)) return FALLBACK_DEFAULT_WORKFLOW;

	// Last resort: first workflow we have. workflowMap is non-empty when at
	// least one layer (built-in or overlay) contributed.
	const first = acc.workflowMap.keys().next().value;
	return first ?? FALLBACK_DEFAULT_WORKFLOW;
}

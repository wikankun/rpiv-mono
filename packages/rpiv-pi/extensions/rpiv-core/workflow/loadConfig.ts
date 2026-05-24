/**
 * Layered JSON config: project `<cwd>/.rpiv/workflow.json` overrides user
 * `~/.config/rpiv/workflow.json` (full-replacement, no merge). Fail-soft:
 * malformed or invalid config falls back to built-in WORKFLOW_DAG with
 * warnings.
 *
 * Schema:
 *   { "presets": { "my-flow": ["discover", "research", "commit"] },
 *     "defaultPreset": "my-flow" }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { validateDag, WORKFLOW_DAG, type WorkflowDag } from "./dag.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowConfigFile {
	readonly presets?: Record<string, string[]>;
	readonly defaultPreset?: string;
}

/** Used when a config omits `defaultPreset` AND ships in WORKFLOW_DAG.presets. */
export const DEFAULT_PRESET_NAME = "mid";

export type ConfigSource = "project" | "user" | "built-in";

export interface LoadedConfig {
	dag: WorkflowDag;
	presetNames: ReadonlySet<string>;
	defaultPreset: string;
	/** Highest non-built-in layer that contributed, or "built-in" if none did. */
	source: ConfigSource;
	/** Every layer that contributed, low-to-high. Always starts with "built-in". */
	layers: readonly ConfigSource[];
	/** Which layer each effective preset name came from. */
	presetSources: ReadonlyMap<string, ConfigSource>;
	warnings?: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** ~/.config/rpiv/workflow.json */
export const USER_CONFIG_PATH = configPath("rpiv", "workflow.json");

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".rpiv", "workflow.json");
}

// ---------------------------------------------------------------------------
// Config file reading
// ---------------------------------------------------------------------------

/** Missing file → `{data: undefined}`; malformed → adds `warning`. */
export function readConfigFile(path: string): { data: WorkflowConfigFile | undefined; warning?: string } {
	if (!existsSync(path)) return { data: undefined };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { data: undefined, warning: `Invalid config at ${path}: not a JSON object` };
		}
		return { data: parsed as WorkflowConfigFile };
	} catch (err) {
		return {
			data: undefined,
			warning: `Malformed JSON at ${path}: ${(err as Error).message}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Resolution: built-in ← user ← project, low-to-high. Both overlay files are
 * read on every call; their `presets` blocks are merged by key (project wins
 * on collision) and added onto the built-in preset namespace. `defaultPreset`
 * cascades the same way. Validation runs once against the merged DAG; on
 * failure the loader falls back wholesale to built-in so help listings don't
 * lie about which layer is active. Never throws.
 */
export function loadConfig(cwd: string): LoadedConfig {
	const warnings: string[] = [];

	const project = readConfigFile(projectConfigPath(cwd));
	if (project.warning) warnings.push(project.warning);

	const user = readConfigFile(USER_CONFIG_PATH);
	if (user.warning) warnings.push(user.warning);

	const overlayLayers: ConfigSource[] = [];
	if (user.data) overlayLayers.push("user");
	if (project.data) overlayLayers.push("project");

	const builtInFallback = (extraWarnings: string[] = []): LoadedConfig => {
		warnings.push(...extraWarnings);
		// `defaultPreset` cascades even on fallback so a user who only set
		// defaultPreset (no presets) still gets their pick if it's a built-in name.
		const requested = project.data?.defaultPreset ?? user.data?.defaultPreset;
		return {
			dag: WORKFLOW_DAG,
			presetNames: new Set(Object.keys(WORKFLOW_DAG.presets)),
			defaultPreset: resolveDefaultPreset(WORKFLOW_DAG.presets, requested, warnings),
			source: "built-in",
			layers: ["built-in"],
			presetSources: builtInPresetSources(),
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	};

	// Shape-guard each overlay independently so a malformed key in one layer
	// doesn't poison the other. validateDag would iterate a stray string
	// character-by-character without this gate.
	const userShapeErrors = collectPresetShapeErrors(user.data, "user");
	const projectShapeErrors = collectPresetShapeErrors(project.data, "project");
	if (userShapeErrors.length + projectShapeErrors.length > 0) {
		return builtInFallback([...userShapeErrors, ...projectShapeErrors]);
	}

	// Neither overlay contributed a `presets` block — collapse to built-in by
	// reference so callers can still rely on `dag === WORKFLOW_DAG`.
	const userHasPresets = !!user.data?.presets && Object.keys(user.data.presets).length > 0;
	const projectHasPresets = !!project.data?.presets && Object.keys(project.data.presets).length > 0;
	if (!userHasPresets && !projectHasPresets) return builtInFallback();

	const merged = mergeConfigs(user.data, project.data);

	// Phase 1 only allows preset overrides — inherit nodes + edges.
	const configDag: WorkflowDag = {
		edges: WORKFLOW_DAG.edges,
		presets: merged.presets,
		nodes: WORKFLOW_DAG.nodes,
	};
	try {
		const { errors, warnings: dagWarnings } = validateDag(configDag);
		if (errors.length > 0) {
			return builtInFallback(errors.map((e) => `Config validation: ${e}`));
		}
		warnings.push(...dagWarnings.map((w) => `Config validation: ${w}`));
	} catch (err) {
		return builtInFallback([`Config validation error: ${(err as Error).message}`]);
	}

	const requestedDefault = project.data?.defaultPreset ?? user.data?.defaultPreset;
	const defaultPreset = resolveDefaultPreset(configDag.presets, requestedDefault, warnings);
	const layers: ConfigSource[] = ["built-in", ...overlayLayers];
	// Highest non-built-in layer becomes `source` — empty overlay set falls
	// through the fallback above, so this is always project or user here.
	const source: ConfigSource = overlayLayers[overlayLayers.length - 1] ?? "built-in";

	return {
		dag: configDag,
		presetNames: new Set(Object.keys(configDag.presets)),
		defaultPreset,
		source,
		layers,
		presetSources: merged.presetSources,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

interface MergedConfig {
	presets: Record<string, string[]>;
	presetSources: ReadonlyMap<string, ConfigSource>;
}

/**
 * Compose built-in → user → project preset namespaces. Higher layers replace
 * lower layers on key collision (no per-stage merging — a preset is owned
 * outright by the layer that defined it last). The returned `presetSources`
 * map records which layer each effective preset name came from; downstream
 * formatters use it to annotate list output.
 */
function mergeConfigs(
	userData: WorkflowConfigFile | undefined,
	projectData: WorkflowConfigFile | undefined,
): MergedConfig {
	const presets: Record<string, string[]> = { ...WORKFLOW_DAG.presets };
	const presetSources = new Map<string, ConfigSource>(
		Object.keys(WORKFLOW_DAG.presets).map((name) => [name, "built-in"]),
	);

	if (userData?.presets) {
		for (const [name, stages] of Object.entries(userData.presets)) {
			presets[name] = stages as string[];
			presetSources.set(name, "user");
		}
	}
	if (projectData?.presets) {
		for (const [name, stages] of Object.entries(projectData.presets)) {
			presets[name] = stages as string[];
			presetSources.set(name, "project");
		}
	}

	return { presets, presetSources };
}

/** Per-layer shape guard — non-array values would otherwise reach validateDag. */
function collectPresetShapeErrors(data: WorkflowConfigFile | undefined, layer: ConfigSource): string[] {
	if (!data?.presets || typeof data.presets !== "object" || Array.isArray(data.presets)) return [];
	const errors: string[] = [];
	for (const [name, stageIds] of Object.entries(data.presets)) {
		if (!Array.isArray(stageIds) || !stageIds.every((n) => typeof n === "string")) {
			errors.push(`Config validation: preset "${name}" (${layer}) must be an array of strings`);
		}
	}
	return errors;
}

/** Built-in preset names tagged as "built-in" — the bottom layer of any merge. */
function builtInPresetSources(): ReadonlyMap<string, ConfigSource> {
	return new Map(Object.keys(WORKFLOW_DAG.presets).map((name) => [name, "built-in" as const]));
}

/** requested → DEFAULT_PRESET_NAME → first preset key → DEFAULT_PRESET_NAME (last-resort, may not exist). */
function resolveDefaultPreset(
	presets: Record<string, unknown>,
	requested: string | undefined,
	warnings: string[],
): string {
	if (requested && requested in presets) return requested;
	if (requested) {
		warnings.push(`defaultPreset "${requested}" not found in presets — falling back to first preset`);
	}
	if (DEFAULT_PRESET_NAME in presets) return DEFAULT_PRESET_NAME;
	const first = Object.keys(presets)[0];
	if (first) {
		if (!requested) {
			warnings.push(`No defaultPreset specified and "${DEFAULT_PRESET_NAME}" not in presets — using "${first}"`);
		}
		return first;
	}
	return DEFAULT_PRESET_NAME;
}

/**
 * Pretty-print preset summaries (no-args path) and per-preset details
 * (preset-only path). Read-only against `LoadedConfig` — no I/O, no mutation.
 * Two public formatters, both returning a single multiline string that
 * `command.ts` hands straight to `ctx.ui.notify(..., "info")`.
 */

import type { DagNode } from "./dag.js";
import type { ConfigSource, LoadedConfig } from "./loadConfig.js";

const USAGE = "Usage: /rpiv [preset] <description>";
const USAGE_PREVIEW = "/rpiv <preset>             — preview stages";

// ===========================================================================
// Public formatters
// ===========================================================================

/** No-args listing: every reachable preset, its stage count, and its source. */
export function formatPresetList(config: LoadedConfig): string {
	const rows = [...config.presetNames].map((name) => {
		const stages = config.dag.presets[name] ?? [];
		const layer = config.presetSources.get(name) ?? "built-in";
		const tags = [`[${layer}]`];
		if (name === config.defaultPreset) tags.push("(default)");
		return `  ${name.padEnd(28)} ${String(stages.length).padStart(2)} stages  ${tags.join(" ")}`;
	});

	return ["Available presets:", ...rows, "", formatLayerBanner(config.layers), USAGE, USAGE_PREVIEW].join("\n");
}

/** Preset-only path: full stage list for one preset, with node decorations. */
export function formatPresetDetails(config: LoadedConfig, preset: string): string {
	const stages = config.dag.presets[preset];
	if (!stages) return formatPresetList(config);

	const layer = config.presetSources.get(preset) ?? "built-in";
	const heading = formatPresetHeading(preset, layer, preset === config.defaultPreset);
	const rows = stages.map((nodeId, i) => formatStageRow(i + 1, nodeId, config.dag.nodes[nodeId]));

	return [heading, "", ...rows, "", `Usage: /rpiv ${preset} <description>`].join("\n");
}

// ===========================================================================
// Stage / source rendering
// ===========================================================================

/** `preset: <name>  (<layer>[, default])` — header line for details view. */
function formatPresetHeading(preset: string, layer: ConfigSource, isDefault: boolean): string {
	const tags: string[] = [layer];
	if (isDefault) tags.push("default");
	return `preset: ${preset}  (${tags.join(", ")})`;
}

/** Numbered row showing completionStrategy · sessionPolicy + optional snapshot/extractor. */
function formatStageRow(idx: number, nodeId: string, node: DagNode | undefined): string {
	const num = `${idx}.`.padEnd(3);
	if (!node) return `  ${num} ${nodeId.padEnd(28)} (unknown node)`;

	const decorations = [node.completionStrategy.padEnd(13), node.sessionPolicy];
	if (node.snapshot) decorations.push("snapshot");
	if (node.extractor) decorations.push("extractor");
	return `  ${num} ${nodeId.padEnd(28)} ${decorations.join(" · ")}`;
}

/** "Sources: built-in + user + project" — single-line layer banner. */
function formatLayerBanner(layers: readonly ConfigSource[]): string {
	return `Sources: ${layers.join(" + ")}`;
}

/**
 * DAG definition for the /rpiv workflow command.
 *
 * Types, constants, and pure validation functions. The DAG is a static
 * adjacency map with edge conditions (auto or choice). Presets resolve
 * the DAG into a linear node sequence. Validation checks node names
 * against the bundled skill set (read from disk at module load via
 * readdirSync — same pattern as OWNED_SKILL_NAMES in session-hooks.ts).
 *
 * No ExtensionAPI dependency. Functions take the DAG explicitly for testability.
 *
 * Static-config style — sibling pattern to siblings.ts/agents.ts (const adjacency
 * array + lazy validation set), not the dynamic Map-based task-graph.ts.
 */

import { readdirSync } from "node:fs";
import { BUNDLED_SKILLS_DIR } from "../paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Edge condition: "auto" (single successor) or "choice" (user picks). */
export type EdgeCondition = "auto" | "choice";

/** A single directed edge in the DAG. */
export interface DagEdge {
	/** Source skill name (must match a skill directory name). */
	from: string;
	/** Target skill name(s). For "auto": exactly one. For "choice": two or more. */
	to: string[];
	/** How the target is selected. */
	condition: EdgeCondition;
}

/** Preset name — widened to string to support custom config-driven presets. */
export type PresetName = string;

/** The full DAG definition. */
export interface WorkflowDag {
	edges: DagEdge[];
	presets: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// DAG edge map
// ---------------------------------------------------------------------------

/** All edges extracted from SKILL.md "Next step:" conventions. */
export const WORKFLOW_DAG: WorkflowDag = {
	edges: [
		{ from: "discover", to: ["research"], condition: "auto" },
		{ from: "design", to: ["plan"], condition: "auto" },
		{ from: "plan", to: ["implement"], condition: "auto" },
		{ from: "blueprint", to: ["implement"], condition: "auto" },
		{ from: "implement", to: ["validate"], condition: "auto" },
		{ from: "validate", to: ["commit"], condition: "auto" },
		{ from: "revise", to: ["implement"], condition: "auto" },
		{ from: "outline-test-cases", to: ["write-test-cases"], condition: "auto" },
		{ from: "migrate-to-guidance", to: ["annotate-guidance"], condition: "auto" },

		{ from: "research", to: ["design", "blueprint"], condition: "choice" },
		{ from: "explore", to: ["design", "blueprint"], condition: "choice" },
		{ from: "code-review", to: ["commit", "design"], condition: "choice" },
	],

	// Linear research → build → verify chains. `commit` and `revise` are
	// intentionally left to the user once the working tree is in a known-good
	// state. `large` includes `code-review` since architectural changes earn
	// the parallel-specialist review pass.
	presets: {
		small: ["research", "blueprint", "implement", "validate"],
		mid: ["discover", "research", "blueprint", "implement", "validate"],
		large: ["discover", "research", "design", "plan", "implement", "validate", "code-review"],
	},
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Skill names that are valid DAG nodes. Lazily computed from bundled skills. */
const VALID_NODES: ReadonlySet<string> = (() => {
	try {
		return new Set(
			readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name),
		);
	} catch {
		return new Set<string>();
	}
})();

/**
 * Validate a DAG: all node names in edges and presets must reference actual
 * bundled skills. Returns an array of error strings (empty = valid).
 *
 * Pure function — takes the DAG explicitly so tests can pass alternatives.
 * Uses the module-level VALID_NODES set for skill name validation.
 */
export function validateDag(dag: WorkflowDag): string[] {
	const errors: string[] = [];
	for (const edge of dag.edges) {
		if (!VALID_NODES.has(edge.from)) errors.push(`Invalid edge source: "${edge.from}"`);
		for (const target of edge.to) {
			if (!VALID_NODES.has(target)) errors.push(`Invalid edge target: "${target}" in edge from "${edge.from}"`);
		}
	}
	for (const [name, nodes] of Object.entries(dag.presets)) {
		for (const node of nodes) {
			if (!VALID_NODES.has(node)) errors.push(`Invalid preset "${name}" node: "${node}"`);
		}
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Edge traversal
// ---------------------------------------------------------------------------

/**
 * Look up the next node(s) from the DAG for a given source skill.
 * Returns undefined if the skill has no outgoing edge (leaf/exit node).
 */
export function getEdge(dag: WorkflowDag, from: string): DagEdge | undefined {
	return dag.edges.find((e) => e.from === from);
}

/**
 * Resolve a preset name to its linear node sequence.
 * Returns undefined if the preset name is unknown.
 */
export function resolvePreset(dag: WorkflowDag, name: PresetName): string[] | undefined {
	return dag.presets[name];
}

/**
 * Check whether a skill name is a valid DAG node (references an actual bundled skill).
 */
export function isValidNode(skillName: string): boolean {
	return VALID_NODES.has(skillName);
}

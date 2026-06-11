/**
 * The loader's issue vocabulary — a LEAF module so `merge.ts` (and any other
 * pipeline stage) can name the `Issue` shape without importing the
 * orchestrator back (the one back-edge the load pipeline used to have, G4).
 *
 * `layer`/`path` attribution lives ONLY here: `validateWorkflow` knows
 * nothing about config layers; the loader is the seam that has both
 * `workflowSources` and the issue list in scope, so it wraps each validation
 * issue with the layer/path of the file the surviving workflow came from.
 */

import type { ConfigLayer } from "../layers.js";
import type { WorkflowValidationIssue } from "../validate/issue.js";

export interface LoadIssue {
	kind: "load";
	layer: ConfigLayer;
	path?: string;
	severity: "error" | "warning";
	message: string;
}

export type Issue = LoadIssue | (WorkflowValidationIssue & { kind: "validation"; layer: ConfigLayer; path?: string });

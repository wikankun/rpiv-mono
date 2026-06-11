/**
 * JSONL state public surface. Internal layout lives in `state.ts`'s
 * header; this barrel re-exports only the symbols the rest of the
 * package consumes.
 */

export type {
	ClaimResult,
	LoopCapRow,
	NamesIndex,
	RoutingDecision,
	RunSummary,
	StageStatus,
	WorkflowHeader,
	WorkflowStage,
} from "./state.js";
export {
	appendLoopCap,
	appendRoutingDecision,
	appendStage,
	claimName,
	generateRunId,
	isValidName,
	listArtifacts,
	listRuns,
	namesFilePath,
	readAllStages,
	readAllStagesForResume,
	readHeader,
	readLastStage,
	readLoopCaps,
	readNamesIndex,
	readRoutingDecisions,
	rebuildIndex,
	releaseName,
	resolveRun,
	runsDir,
	stateFilePath,
	VALID_NAME,
	writeHeader,
} from "./state.js";

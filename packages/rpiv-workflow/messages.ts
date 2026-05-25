/**
 * User-facing message constants.
 * - `STATUS_*` via `ctx.ui.setStatus` — persists across `newSession`.
 * - `MSG_*` / `ERR_*` via `ctx.ui.notify` — one-shot; may be repainted by
 *   Pi's session transition (the status line is the durable channel).
 */

export const STATUS_KEY = "rpiv-workflow";

export const STATUS_STAGE = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

/**
 * Status line for a fanout unit. `skill` is the node's resolved skill body,
 * `label` is whatever the user's `FanoutFn` returned for this unit
 * (`"phase 2/5"`, `"task 3/8"`, ...). The runner adds no implicit wording.
 */
export const STATUS_FANOUT_UNIT = (stage: number, total: number, skill: string, label: string) =>
	`rpiv: stage ${stage}/${total} — ${skill} (${label})`;

export const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;
export const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;
export const MSG_STAGE_ABORTED = (skill: string) => `⏸ ${skill} aborted (ESC) — stopping workflow`;
export const MSG_STAGE_TRUNCATED = (skill: string) =>
	`✗ ${skill} truncated — model hit output cap mid-reply, stopping workflow`;
export const MSG_STAGE_TOOL_STALLED = (skill: string) => `✗ ${skill} tool loop did not settle — stopping workflow`;
export const MSG_STAGE_NO_RESPONSE = (skill: string) => `✗ ${skill} produced no response — stopping workflow`;

export const ERR_STAGE_ABORTED = (skill: string) => `${skill} aborted by user (ESC)`;
export const ERR_STAGE_TRUNCATED = (skill: string) => `${skill} truncated — model hit output-length cap mid-reply`;
export const ERR_STAGE_TOOL_STALLED = (skill: string) =>
	`${skill} tool loop did not settle before the orchestrator inspected the branch`;
export const ERR_STAGE_NO_RESPONSE = (skill: string) => `${skill} produced no assistant message`;

export const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;
export const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

export const MSG_VALIDATION_RETRY = (skill: string, attempt: number) =>
	`rpiv: ${skill} output validation failed — asking agent to fix (attempt ${attempt})`;
export const MSG_VALIDATION_EXHAUSTED = (skill: string) => `rpiv: ${skill} output validation exhausted retries`;
export const ERR_VALIDATION_FAILED = (skill: string, failures: string) =>
	`${skill} output validation failed after retries: ${failures}`;

/**
 * Sent to the agent as a follow-up message when an output-schema validation
 * fails — instructs the agent to re-write the artifact at the same path with
 * a corrected frontmatter. `errorLines` is a pre-joined bullet list (one
 * line per failure) so the factory stays single-arg-typed.
 */
export const MSG_VALIDATION_RETRY_PROMPT = (skill: string, errorLines: string) =>
	`The artifact you produced for ${skill} doesn't satisfy the expected output schema. ` +
	"Please update the frontmatter and re-write the artifact at the same path.\n\n" +
	`Errors:\n${errorLines}`;

export const MSG_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string) =>
	`✗ ${currentSkill} input validation failed — upstream ${prevSkill} produced invalid data`;
export const ERR_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string, failures: string) =>
	`Input validation failed for '${currentSkill}': upstream '${prevSkill}' produced invalid data: ${failures}`;

/**
 * Bound on a single schema-validate call. Sync schemas resolve in one
 * microtask and never trip this; async schemas (filesystem probes, registry
 * lookups, async-by-default libs) that fail to settle within
 * `validateTimeoutMs` halt the stage rather than hang it. Skill
 * attribution is added by the caller's fatal-extraction wrapper, so the
 * factory itself doesn't repeat the skill prefix.
 */
export const ERR_SCHEMA_TIMEOUT = (slot: "outputSchema" | "inputSchema", ms: number) =>
	`${slot} validation exceeded ${ms}ms — schema's ~standard.validate did not settle`;

export const MSG_MISSING_ARTIFACT = (currentSkill: string) =>
	`✗ ${currentSkill} has no upstream artifact to consume — stopping workflow`;
export const ERR_MISSING_ARTIFACT = (currentSkill: string, stageNumber: number) =>
	`Stage ${stageNumber} (${currentSkill}) has no upstream artifactPath; only stage 1 may consume the user's original input`;

export const MSG_BACKWARD_JUMP_EXHAUSTED = (jumps: number, max: number) =>
	`rpiv: backward-jump limit exceeded (${jumps}/${max}) — stopping workflow to prevent infinite loop`;

export const ERR_BACKWARD_JUMP_EXHAUSTED = (jumps: number, max: number) =>
	`Backward-jump limit exceeded: ${jumps} backward jumps (max ${max})`;

export const MSG_AUDIT_WRITE_FAILED = (skill: string) =>
	`✗ ${skill} completed but audit row could not be written — stopping workflow`;
export const ERR_AUDIT_WRITE_FAILED = (skill: string) =>
	`${skill} completed but the JSONL audit row could not be appended; halting to keep in-memory state aligned with disk`;

export const MSG_CHAIN_ADVANCE_FAILED = (fromStage: string, reason: string) =>
	`✗ chain advance after ${fromStage} failed: ${reason} — stopping workflow`;

/**
 * Stage threw before it could record its own audit row — covers
 * `enforceSessionInvariants` violations, session-machinery errors, and any
 * other path that escapes `runStage` directly. Distinguished from
 * `MSG_CHAIN_ADVANCE_FAILED` (which is about an edge throwing AFTER a stage
 * succeeded) — the user needs to see *which* stage failed to start, not
 * which one preceded the failure.
 */
export const MSG_STAGE_THREW = (skill: string, reason: string) =>
	`✗ stage ${skill} failed to start: ${reason} — stopping workflow`;

/**
 * Stage references a Pi skill that isn't registered with the running Pi
 * instance. Surfaced loudly here instead of letting the `/skill:<name>` text
 * leak verbatim into the LLM context — `rpiv-args` is the only expander on
 * the programmatic dispatch path (`expandPromptTemplates: false`), so an
 * unknown skill name would otherwise reach the model as a bare user-message
 * imperative outside the `<skill>...</skill>` contract.
 */
export const MSG_SKILL_NOT_REGISTERED = (skill: string) =>
	`✗ ${skill} is not a registered Pi skill — stopping workflow`;
export const ERR_SKILL_NOT_REGISTERED = (skill: string, stageNumber: number) =>
	`Stage ${stageNumber} requires Pi skill "${skill}" but no skill by that name is registered with Pi (check installed sibling packages and \`pi.skills\` manifest entries)`;

/**
 * Notified live when a routing-decision row could not be appended. The chain
 * continues (the decision has already been made), but the user must know the
 * audit trail for this run has a gap — otherwise an absent row reads as
 * "no decision was made" rather than "decision made, write dropped."
 */
export const MSG_ROUTING_AUDIT_DROPPED = (fromStage: string, decision: string) =>
	`⚠ rpiv: routing decision ${fromStage} → ${decision} not persisted to audit trail (continuing run)`;

/** Recap surfaced on stage failure — pre-joined bullet list of artifact paths. */
export const MSG_PARTIAL_ARTIFACTS = (artifactList: string) => `Artifacts produced before failure:\n${artifactList}`;

// ---------------------------------------------------------------------------
// /wf command shell — notify-only (never lands in state.error; ERR_ reserved)
// ---------------------------------------------------------------------------

export const MSG_INTERACTIVE_ONLY = "/wf requires interactive mode";

export const MSG_WORKFLOW_THREW = (reason: string) => `/wf: workflow runner failed unexpectedly: ${reason}`;

export const MSG_LOAD_ABORTED = (count: number) =>
	`/wf: ${count} ${count === 1 ? "config error" : "config errors"} — see warnings above (fix and re-run)`;

export const MSG_WORKFLOW_NOT_FOUND = (name: string) => `/wf: workflow "${name}" not found`;

/**
 * No layer (built-in / user / project) contributed a workflow. Surfaced
 * instead of trying to run with an undefined default — without rpiv-pi
 * installed and no user overlay, the merged registry is genuinely empty
 * and the user needs to install a sibling that bundles workflows or
 * author one in `.rpiv-workflow/workflows.config.ts`.
 */
export const MSG_NO_WORKFLOWS_REGISTERED =
	"/wf: no workflows registered — install a sibling that bundles workflows or author one in `.rpiv-workflow/workflows.config.ts`";

/** Pi command registry — displayed by Pi's `/?` / command list. */
export const CMD_DESCRIPTION = "Run a skill workflow: /wf [workflow] [description]";

/** No-args listing footer — generic usage hint. */
export const CMD_USAGE_LIST = "Usage: /wf [workflow] <description>";

/** No-args listing footer — preview-mode hint paired with CMD_USAGE_LIST. */
export const CMD_USAGE_PREVIEW = "/wf <workflow>             — preview stages";

/** Per-workflow details footer — narrowed to the workflow the user previewed. */
export const CMD_USAGE_RUN = (name: string) => `Usage: /wf ${name} <description>`;

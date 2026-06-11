/**
 * Judge — the first-class model-judge concept. A `Judge` names a dispatchable
 * grading session: a **skill** (`/skill:<judge.skill> <producerHandle>`, the
 * latest producer artifact auto-injected as the input handle) or a raw
 * **prompt** (the author embeds the handle/output themselves). Exactly one of
 * `skill` / `prompt` is the dispatch discriminator — enforced at CONSTRUCTION
 * by `judge()` (the `defineRoute` pattern: invalid shapes are unrepresentable
 * past the factory).
 *
 * A judge session runs as a `produces`-kind session so its verdict is
 * VALIDATED by `outcome` and published into its own dedicated
 * `state.named[outcome.name]` channel. What the verdict DECIDES lives on the
 * consuming site, not here: the `assess()` constructor adds `done(verdict)`;
 * the per-stage `verify` field reuses `done(verdict)` as its pass gate; `panel()` will compose
 * N judges with a vote fold. Keeping the termination predicate off `Judge`
 * is what makes the concept reusable across all three.
 *
 * Leaf module — type-only imports; safe on the runner-free `registration`
 * surface (siblings register built-ins without dragging the runner in).
 */

import type { Artifact } from "./handle.js";
import type { Output, RunView } from "./output.js";
import type { Outcome } from "./output-spec.js";

/** Context handed to a dynamic `Judge.prompt`. */
export interface JudgeContext {
	cwd: string;
	/** Latest producer output (also the session's input handle). */
	output: Output;
	/** Frozen stage-entry primary, referenceable; the author embeds it if wanted. */
	entryArtifact: Artifact | undefined;
	state: RunView;
	/** 0-based round index. */
	round: number;
}

/** A judge's dynamic prompt — receives the producer output + round context. */
export type JudgePromptFn = (ctx: JudgeContext) => string | Promise<string>;

/**
 * An `Outcome` whose `name` is REQUIRED — a judge's verdict must publish
 * to its own dedicated `state.named` channel, so the optional-`name` outcome
 * shape isn't enough here.
 */
export interface NamedOutcome extends Outcome {
	name: string;
}

/**
 * Fields shared by both judge dispatch arms.
 *
 * `outcome` validates the verdict and names its dedicated `state.named`
 * channel (its `.name` must differ from the producer outcome's; that
 * collision needs the producer's identity, so it stays a workflow-level
 * check in `validateWorkflow`).
 *
 * ≥1-ARTIFACT CONSTRAINT: the collector MUST materialize at least one
 * artifact (e.g. a JSON verdict file whose parser yields `{ done, feedback }`).
 * A judge session whose collector returns zero artifacts is a **fatal halt**
 * via `enforceCompletionContract` — no retry, no soft-stop.
 */
interface JudgeBase {
	outcome: NamedOutcome;
}

/** Skill dispatch: `/skill:<skill> <producerHandle>` (handle auto-injected). */
export interface SkillJudge extends JudgeBase {
	skill: string;
	/** Structurally absent — skill XOR prompt (both is ambiguous). */
	prompt?: never;
}

/**
 * Raw-prompt dispatch: the session receives only the prompt text, so the
 * author embeds the producer handle/output themselves (via `JudgeContext`
 * for the dynamic form).
 */
export interface PromptJudge extends JudgeBase {
	prompt: string | JudgePromptFn;
	/** Structurally absent — skill XOR prompt (both is ambiguous). */
	skill?: never;
}

/**
 * The reusable judge shape — a union over the two dispatch arms, so
 * skill-XOR-prompt and the named verdict outcome are violations the type
 * system rejects on typed call sites, not just runtime checks. Authored via
 * the `judge()` factory; a hand-rolled object literal (jiti-loaded configs
 * erase TS types) is re-checked defensively at load time by
 * `validateWorkflow` through the same `judgeShapeIssues` rule source —
 * which is why the runtime checks stay.
 */
export type Judge = SkillJudge | PromptJudge;

/**
 * Single rule source for the judge shape. Returns human-readable violations
 * (empty array = valid). `judge()` throws on the first; `validateWorkflow`
 * maps each to a load issue for hand-rolled literals that bypassed the
 * factory. Takes `unknown` ON PURPOSE: the type system already rejects these
 * shapes on typed call sites (the `Judge` union), so everything reaching this
 * checker is an untyped jiti-loaded literal.
 */
export function judgeShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["a judge object is required"];
	const j = candidate as { skill?: unknown; prompt?: unknown; outcome?: { name?: unknown } };
	const issues: string[] = [];
	if (!j.outcome?.name) {
		issues.push("judge.outcome must carry a `name` so the verdict publishes to its own named channel");
	}
	const hasSkill = j.skill !== undefined;
	const hasPrompt = j.prompt !== undefined;
	if (hasSkill && hasPrompt) {
		issues.push("judge sets both `skill` and `prompt` — choose one dispatch (skill XOR prompt)");
	}
	if (!hasSkill && !hasPrompt) {
		issues.push("judge sets neither `skill` nor `prompt` — one is required to dispatch the judge");
	}
	return issues;
}

/**
 * Promote a judge literal to a validated `Judge` — identity passthrough that
 * throws on an invalid shape, so a `judge(...)`-authored value is correct by
 * construction (cf. `defineRoute`). Composes into `assess({ judge: judge({...}) })`
 * today and `panel(judge({...}), judge({...}))` in the follow-up.
 */
export function judge(spec: Judge): Judge {
	const issues = judgeShapeIssues(spec);
	if (issues.length > 0) throw new Error(`judge(): ${issues[0]}`);
	return spec;
}

/**
 * Resolve a static or dynamic `Judge.prompt`. A dynamic prompt may be async.
 * (Moved from loop.ts — the ONE resolver for every Judge dispatch site.)
 */
export async function resolveJudgePrompt(
	prompt: string | ((ctx: JudgeContext) => string | Promise<string>),
	ctx: JudgeContext,
): Promise<string> {
	if (typeof prompt === "string") return prompt;
	return prompt(ctx);
}

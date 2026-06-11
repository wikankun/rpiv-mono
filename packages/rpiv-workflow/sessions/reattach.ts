/**
 * Session-backed resume continuation — runs INSIDE the interrupted stage's
 * adopted session (the `withSession` callback of `ctx.switchSession`, wired
 * by `resumeStageWithSession` in runner/run-stage.ts). Companion to
 * `sessions.ts`, reusing its exported pipeline pieces instead of
 * duplicating them.
 *
 * Two arms, tried in order:
 *
 *  1. PROMOTION — adopt the session's existing branch and run the entire
 *     collector → parser → contract pipeline over it
 *     (`produceAndValidateOutput`, verbatim — including the frontmatter
 *     parser's disk-existence check). Success ⇒ a normal completed row via
 *     `recordStageSuccess` and the chain advances — the interrupted turn's
 *     work is adopted without sending anything. Deliberately NO
 *     `classifyStop` here: the old tail is an interrupted turn by
 *     definition; promotion only asks "did the artifact land".
 *
 *  2. REATTACH — on collector-fatal (the artifact pipeline found nothing),
 *     continue the session from its leaf with a nudge prompt, wait for the
 *     agent to settle, then run the standard `postStage` — from there the
 *     flow is byte-identical to live: stop classification, extraction
 *     (original offset, so a pre-interrupt announcement still counts),
 *     success persistence or halt. A second failure writes a normal
 *     failure row — itself session-backed, so the run stays resumable.
 *
 * Validation-exhausted from promotion halts exactly as live does.
 */

import type { WorkflowSessionContext } from "../host.js";
import { MSG_RESUME_PROMOTED, MSG_RESUME_REATTACHED, REATTACH_PROMPT } from "../messages.js";
import { readBranch, readSessionRef } from "../transcript.js";
import type { StageSession } from "../types.js";
import { produceAndValidateOutput } from "./extraction.js";
import { haltStageWithValidationFailure, postStage, recordStageSuccess } from "./sessions.js";
import { handlerFor } from "./spawn.js";

export async function reattachStageSession(ctx: WorkflowSessionContext, s: StageSession): Promise<void> {
	// Promotion: extraction over the adopted branch, scoped by the SAME
	// offset the interrupted activation ran under (persisted on its row and
	// threaded back via `s.branchOffset`; fresh stages scan the whole branch).
	const offset = handlerFor(s.stage.sessionPolicy).branchOffset(s.branchOffset);
	const session = readSessionRef(ctx, offset);
	const result = await produceAndValidateOutput(ctx, s, readBranch(ctx), offset);

	if (result.kind === "ok") {
		ctx.ui.notify(MSG_RESUME_PROMOTED(s.skill), "info");
		if (!(await recordStageSuccess(ctx, s, result.output, session))) return;
		await s.onSuccess(ctx, result.output);
		return;
	}
	if (result.kind === "validation-exhausted") {
		return haltStageWithValidationFailure(ctx, s, result.failureSummary, session);
	}

	// Promotion missed (collector-fatal) — reattach: nudge the session from
	// its leaf, let the agent finish with full prior context, then run the
	// standard post-session pipeline.
	ctx.ui.notify(MSG_RESUME_REATTACHED(s.skill), "info");
	await ctx.sendUserMessage(REATTACH_PROMPT(s.skill));
	await ctx.waitForIdle();
	await postStage(ctx, s);
}

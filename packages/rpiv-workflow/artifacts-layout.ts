/**
 * Single source for the on-disk artifacts directory layout. Every site
 * that names, validates, or pattern-matches against `.rpiv/artifacts/...`
 * paths reads its shape from here so the layout can be changed in one
 * place (e.g. when L0-02b adds the listRuns API and may evolve to
 * `.rpiv/runs/<run-id>/artifacts/`).
 *
 * The contract:
 *   <cwd>/.rpiv/artifacts/<bucket>/<filename>.md
 *
 *   - `<bucket>`   — `[\w.-]+` (the skill or domain, e.g. `research`,
 *                    `research.v2`, `code-review-large`).
 *   - `<filename>` — `[\w.-]+\.md`.
 *
 * Skill prompts that emit artifact paths reference the same prose; the
 * regex source below is what the runner uses to locate paths in
 * assistant transcripts.
 */

/**
 * Regex *source* (no flags) matching a relative artifact path. Consumers
 * construct the actual `RegExp` with whatever flags they need —
 * transcript.ts uses `g` to find every mention; ad-hoc validators may
 * anchor with `^…$`.
 *
 * Bucket capture matches filename rules so dirs with dots are accepted
 * (e.g. `.rpiv/artifacts/research.v2/x.md` is a real path agents emit).
 */
export const ARTIFACT_PATH_REGEX_SOURCE = String.raw`\.rpiv/artifacts/[\w.-]+/[\w.-]+\.md`;

/** Human-readable form of the path scheme — for error messages + JSDoc. */
export const ARTIFACT_PATH_DESCRIPTION = ".rpiv/artifacts/<bucket>/<file>.md";

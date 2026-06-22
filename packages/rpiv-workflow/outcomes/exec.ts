/**
 * Shared async `execFile` plumbing for the git-backed outcomes
 * (`git-commit.ts`, `collectors/workspace-diff.ts`). One promisified
 * instance + one timeout budget so the two collectors can't drift.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/**
 * Per git command. 5 s is generous for `rev-parse` / `log -1` /
 * `diff --shortstat` / `status --porcelain` on local repos, short enough
 * that a hung network mount can't pin the stage.
 */
export const GIT_EXEC_TIMEOUT_MS = 5_000;

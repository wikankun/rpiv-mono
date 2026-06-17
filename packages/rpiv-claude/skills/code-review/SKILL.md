---
name: code-review
description: Conduct comprehensive code reviews of pending changes, a branch, or a PR using parallel specialist agents that audit the diff, compare against peer code, and verify claims. Use when the user asks to 'review this', wants pending changes, a PR, a branch, or a diff reviewed, or asks for a code review. Produces review documents in .rpiv/artifacts/reviews/. Internal mechanics like row-only agent contracts and Gap-Finder set arithmetic are documented in the skill body.
---

# Code Review

Review changes across **Quality**, **Security**, **Dependencies** lenses with optional advisor adjudication. Valid scopes: `commit` | `staged` | `working` | hash | `A..B` | PR branch. **Empty scope defaults to feature-branch-vs-default-branch first-parent review** (default branch auto-detected; see Step 1).

## Input

`$ARGUMENTS` — scope: `commit` | `staged` | `working` | a commit hash | `A..B` range | PR branch name. Empty defaults to feature-branch-vs-default-branch (first-parent).

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Scope resolution (default branch, range, ChangedFiles) is LLM-invoked at Step 1.1 via the bundled `_helpers/review-range.mjs` — it depends on `$ARGUMENTS` and on conversational clarification, which render-time substitution cannot capture.

## Flow

1. Input → 2. Wave-1 dispatch → 3. Wave-2 dispatch → 4. Wave-3 dispatch → 5. Reconcile → 6. Verify → 7. Write artifact → 8. Present → 9. Follow-ups

**File-orientation contract**: agents reason about *files* as coherent units. Hunks are evidence *within* a file's analysis, never the unit of analysis. The `-U30` patch (Step 1) inlines function-level context so agents rarely need extra `Read` calls.

Every Wave-2 agent prompt contains EXACTLY: (a) `Known Context:` followed by the Discovery Map verbatim, and (b) the resolved `<patch_path>` value (the helper's `patch_path:` field) as the patch path. Nothing else from Wave-1 outputs — NOT the raw integration-scanner dump, NOT precedent-locator output, NOT Dependencies/CVE output. See "Wave-2 context isolation" in Step 3 for the failure mode when this is violated. Wave-1 agents that do not consume the Discovery Map (precedents, dependencies, CVE) get `ChangedFiles` / manifest-diff only.

## Steps

### Step 1: Resolve Scope and Assemble the Diff

1. **Resolve scope via the bundled helper.** Determine the scope spec from the value the user supplied (visible in `## Input` above as the substituted argument). If empty, use the literal string `auto`; if ambiguous (prose, mixed list, unrecognised branch name), clarify via ask_user — options: (A) "review current branch vs default branch (first-parent)" → `auto`, (B) "review every tracked change vs HEAD (staged + unstaged)" → `modified`, (C) "review unstaged changes only" → `working`, (D) "restate scope" → free-text — then re-invoke. Then run:

   ```bash
   node "${SKILL_DIR}/_helpers/review-range.mjs" "<scope-spec>"
   ```

   The helper emits labeled key/value lines (`default_branch:`, `strategy:`, `oldest:`, `newest:`, `base:`, `tip:`, `range:`, `fp_flag:`, `patch_path:`) followed by a `---changed-files---` block. Read those as authoritative for the rest of Step 1. If `strategy: unrecognised` appears, the `note:` field explains why — clarify via ask_user and re-invoke with a valid spec.

   `<scope-spec>` translation table — map the user's substituted argument to one of these forms:

   | Argument shape | Pass to helper |
   |---|---|
   | empty (no argument provided) | `auto` |
   | literal `commit` / `staged` / `working` / `modified` | same word verbatim |
   | hex commit hash (4-40 chars, e.g. `abc1234`) | the hash verbatim |
   | `<A>..<B>` (e.g. `HEAD~5..HEAD`, `main..feature`) | the range verbatim |
   | comma- or whitespace-separated hashes (`h1,h2,h3` or `h1 h2 h3`) | the list verbatim |
   | branch name (must be checked out at HEAD locally) | the branch name verbatim |
   | anything else (prose, mixed list, unresolvable ref) | clarify via ask_user, then re-invoke |

2. **Confirm strategy** from the helper output. The mapping into the rest of the skill:
   - `strategy: first-parent` (`auto` / PR branch / commit list) — use `<range>` AND `<fp_flag>` (which is `--first-parent`) in the subsequent git commands. `<base>` is the parent-of-first-feature-commit (helper computes via `merge-base`), so the range already includes OLDEST's own changes — do NOT add `^` anywhere.
   - `strategy: explicit-range` (single hash / `A..B`) — use `<range>` without `<fp_flag>` (it's empty for this strategy). `<base>` is OLDEST^ (so the range includes OLDEST itself, matching the original "user-inclusive endpoint" intent).
   - `strategy: working-tree` (`commit` / `staged` / `working`) — no `<range>`; use the working-tree commands listed in the next bullet.

   `--first-parent` is orthogonal to `--no-merges`: the former prunes second-parent subtrees from reachability, the latter drops merge commits themselves from the log. Both flags are independently controllable below.

3. **Assemble the UNION of changes** (not the net endpoint-diff — so reverted intermediate work stays visible). Save the patch to a tempfile once with generous context; do NOT re-run `git log --patch` to slice windows later. Substitute literal `<range>`, `<fp_flag>`, and `<patch_path>` values from the helper output (`<fp_flag>` is `--first-parent` or empty — omit the flag entirely when empty; `<patch_path>` is the worktree-safe diff tempfile — a literal `.git/…` path fails inside a worktree):
   - `ChangedFiles` — read from the helper's `---changed-files---` block. If a `(... N more files truncated ...)` footer appears, the change set exceeded the helper's 2000-line/40 KB cap; scope the review tighter or run the patch-tempfile command below to recover the full surface from disk.
   - `git log "<range>" <fp_flag> --stat --reverse` → per-commit size summary
   - `git log "<range>" <fp_flag> --patch --reverse --no-merges -U30 > <patch_path>` → union patches with **30 lines of surrounding context per hunk** (function-level context inline)
   - `git log "<range>" --reverse --format="%H %s%n%n%b%n---"` → commit-message context
   - **Working-tree branch** (`strategy: working-tree`, no `<range>`): for `staged` use `git diff --cached --stat` + `git diff --cached -U30 > <patch_path>`; for `working` use `git diff --stat` + `git diff -U30 > <patch_path>` (unstaged only); for `modified` use `git diff HEAD --stat` + `git diff HEAD -U30 > <patch_path>` (every tracked change vs HEAD — staged + unstaged, no untracked); for `commit` use `git show HEAD --stat` + `git show HEAD -U30 > <patch_path>`. Commit-message context is N/A for `staged` / `working` / `modified`; for `commit` use `git show HEAD --format="%H %s%n%n%b%n---" --no-patch`. ChangedFiles still comes from the helper.
   - **Patch-size fallback**: `-U30` produces ~2–3× the size of `-U0`. If the resulting patch exceeds ~1MB, drop to `-U10` for this run; never use `-U0` — it defeats the skill's design.

3. **Bail-out**: if `ChangedFiles` is empty, print `No changes in scope {scope}. Exiting.` and STOP. Do not write an artifact.

4. **Derive scope + flags** (orchestrator-side, used in later steps):
   - `InScopeFiles` — used by the Step 6 pre-filter. `ChangedFiles` reflects *tree-reachability* (inflated on branches that back-merged the default branch — each post-merge first-parent commit inherits the merge's tree, so `--name-only` includes every file the merge resolved); `InScopeFiles` reflects *commit-exclusive authorship* (only files actually modified by commits in `<range>` / `<fp_flag>`).
   - `ReviewTags` — derived from `$ARGUMENTS` or from Step 1.1 clarification (e.g. `[security, performance]`).

### Step 2: Wave-1 Dispatch — Parallel Discovery & Historical Context

Spawn the following discovery agents in parallel via the Agent tool. All Wave-1 agents run against the live codebase at HEAD, not the patch.

**1. Discovery Map (`integration-scanner`)**
@integration-scanner
- Prompt: "Scan connections for files modified in this review: {ChangedFiles}. Map inbound references, outbound dependencies, and infrastructure wiring (routes, DI, events) for these components."
- Goal: build the "reachability graph" that Wave-2 agents use to understand the blast radius.

**2. Precedent Sweep (`precedent-locator`)**
@precedent-locator
- Prompt: "Find past changes similar to {first 5 commit subjects}. Analyze follow-up fixes and lessons learned from these precedents."
- Goal: surface "recurring bug" patterns or divergence from team conventions.

**Wait for Wave-1 to complete.**

### Step 3: Wave-2 Dispatch — Parallel Specialist Audit

Spawn the following specialist agents in parallel via the Agent tool. **Critical Isolation Rule**: each agent receives ONLY the patch path and the Discovery Map as context. They do NOT see each other's outputs.

**Wave-2 context isolation**: agents must remain adversarial and independent. Merging findings early leads to "narrative drift" where one agent's observation softens another's audit. Reconcile only happens at Step 5.

**1. Patch Audit (`artifact-code-reviewer`)**
@artifact-code-reviewer
- Prompt: "Audit the supplied patch {patch_path} against the Discovery Map context. Focus on code quality, codebase fit, and actionability. Emit severity-tagged findings."

**2. Coverage Audit (`artifact-coverage-reviewer`)**
@artifact-coverage-reviewer
- Prompt: "Audit the supplied patch {patch_path} for verification coverage. Verify that new logic has corresponding test updates and that success criteria are actionable."

**3. Peer Verification (`peer-comparator`)**
- Only when the change introduces a new file that parallels a peer (e.g. `PhysicalSubscription` added beside `Subscription`).
@peer-comparator
- Prompt: "Compare the new files in the patch against their existing peers documented in the Discovery Map. Tag peer invariants as Mirrored/Missing/Diverged."

**Wait for Wave-2 to complete.**

### Step 4: Wave-3 Dispatch — Adversarial Verification (Gap-Finder)

Re-read all findings from Wave-2. Identify the most critical or surprising claims. Dispatch one adversarial verifier to ground these claims against reality.

**Gap-Finder (`claim-verifier`)**
@claim-verifier
- Prompt: "Verify the following high-severity claims from Wave-2: {List top 5 findings}. Ground each against the live codebase state at HEAD. Tag as Verified/Weakened/Falsified."

**Wait for Wave-3 to complete.**

### Step 5: Reconcile and Triage

1. **Reconcile findings**:
   - Merge rows across all waves into a single master table
   - Apply Wave-3's Verified/Weakened/Falsified tags to the master table
   - Group findings by file and severity

2. **Developer checkpoint**:
   - Present the reconciled findings to the developer via ask_user
   - Options: "Apply fix", "Defer", "Dismiss", "Discuss"
   - Iterate until all high-severity findings have a triage status

### Step 6: Write Review Artifact

Write the finalized review to `.rpiv/artifacts/reviews/YYYY-MM-DD_<topic>-review.md`.

Include:
- Summary of changes
- Triage status tally (blockers/concerns/suggestions)
- Reconciled findings table
- Verifier justifications
- Historical context from Wave-1

### Step 7: Present and Chain

Present the artifact path and status to the developer.

**Next step:** `/skill:implement <plan-path>` or direct code fixes if no plan exists.

## Important Notes

- **Parallelism**: Maximize parallelism in Wave-1 and Wave-2 dispatches
- **Isolation**: Keep specialist agents focused on their specific lenses
- **Adversarial**: Assume the changes are flawed until proven otherwise
- **Grounded**: Every finding must cite `file:line` references
- **Traceable**: Maintain a clear audit trail from discovery to triage

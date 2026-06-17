# PR Triage

Size up a pull request **before** spending review effort: read the PR thread, compare the diff against whatever standard the target repo carries, and emit a routing verdict. Triage **classifies and routes** — it does not adjudicate line by line (that's `code-review`, which the routed workflow runs). Read-only: no checkout, no mutation.

## Input

`$ARGUMENTS` — a PR number (`128`), a PR URL, or empty (= the open PR of the current branch).

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

## Workflow

1. **Resolve and Fetch**:
   - Use the bundled helper `_helpers/pr-fetch.mjs` to fetch PR data via `gh`.
   - If ambiguous, clarify via {{tool:ask_user}}.
2. **Discover Standards**:
   - Walk from changed files up to repo root to find `ARCHITECTURE.md`, `CLAUDE.md`, linter configs, or peer code.
3. **Dispatch Assessment (Wave 1 parallel agents)**:
   - {{dispatch:diff-auditor}} for security scan on the raw patch.
   - {{dispatch:codebase-analyzer}} for convention drift vs the discovered standards.
   - {{dispatch:codebase-analyzer}} for intent vs diff + scope-creep check.
4. **Triage Checkpoint**:
   - Tally findings (security tier, blockers, drift).
   - Present Top Blockers and recommended disposition (Review · Request changes · Hold · Decline) via {{tool:ask_user}}.
5. **Write Triage Artifact**:
   - Write to `.rpiv/artifacts/triage/YYYY-MM-DD_pr-N-topic.md`.
6. **Present & Recommend**:
   - Show summary and next step (e.g. `/wf vet` for Review).

## Important Guidelines

- **Always read-only**: Never `git checkout` or mutate the tree.
- **Standards are discovered, not assumed**: Find what the repo has.
- **Security tier is fixed**: Never override a BLOCK finding.

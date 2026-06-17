# Validate

You are tasked with validating that an implementation plan was correctly executed, verifying all success criteria and identifying any deviations or issues.

## Input

`$ARGUMENTS` — optional path to a plan in `.rpiv/artifacts/plans/`.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
echo
echo "### recent (read only in case of empty user input)"
echo "recent plans:"
node "${SKILL_DIR}/../_shared/list-recent.mjs" .rpiv/artifacts/plans 10
```

## Steps

### Step 1: Input Handling and Context Discovery

1. **Locate the plan**: Use provided path or confirm recent plans via {{tool:ask_user}}.
2. **Read the plan completely**.
3. **Identify what should have changed**.
4. **Gather implementation evidence**:
   - `git log` and `git diff` for commit context.
   - Run the plan's `#### Automated Verification:` commands as-written.
5. **Spawn parallel research agents**:
   - {{dispatch:codebase-analyzer}} to verify requirement implementation.
   - {{dispatch:codebase-pattern-finder}} to check pattern conformance.
   - Wait for ALL agents to complete.

### Step 2: Systematic Validation

For each phase:
1. **Check completion status** (`- [x]`).
2. **Run automated verification** commands; investigate failures.
3. **Assess manual criteria** and provide clear steps for the user.
4. **Think deeply about edge cases** and potential regressions.

### Step 3: Write the Validation Report

1. **Determine metadata and verdict** (`pass` or `fail`).
2. **Write the artifact** using the Write tool to `.rpiv/artifacts/validation/YYYY-MM-DD_topic.md`.
   - Sections: Findings, Deviations, Pattern Conformance, Potential Issues.

### Step 4: Present Summary

1. Present artifact path and verdict.
2. **Next step:** `/skill:commit` if `pass`; otherwise fix gaps and re-validate.

## Important Guidelines

- **Thorough but practical**: Don't skip verification commands.
- **Document everything**: Be honest about shortcuts or incomplete items.
- **Think critically**: Question if the implementation truly solves the problem.
- **No append mode**: Each run produces a fresh report.

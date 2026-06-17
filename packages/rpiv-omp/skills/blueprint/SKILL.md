---
name: blueprint
description: Answer structured research questions about a codebase, then synthesize a phased implementation plan. Combines research, design, and plan skills into one pass. Use for smaller tasks where separate research/design/plan phases are overkill, or when the user asks to "draft a plan for X" and you have enough context to start.
---

# Blueprint

`blueprint` is a fast-track skill that combines `research`, `design`, and `plan` into a single interleaved workflow. It is designed for small-to-medium tasks where separate artifacts for each stage would be too much overhead.

## Workflow

1. **Research (Interleaved)**:
   - Dispatch @scope-tracer to bound the scope.
   - Dispatch @codebase-analyzer and @codebase-pattern-finder in parallel to answer the core questions.
   - Interleave Step 3 Synthesis (checkpointing findings) with Step 4 Architectural Decisions.

2. **Design & Plan (Interleaved)**:
   - Skip the separate design document.
   - Go straight to phased plan decomposition (Step 5 of `plan`).
   - Create a single `.rpiv/artifacts/plans/YYYY-MM-DD_<topic>-blueprint.md` artifact using the combined template.

3. **Slice Generation**:
   - Generate slice code and success criteria (Step 6 of `plan`).
   - Use @slice-verifier for each slice.
   - Present condensed micro-checkpoints via ask_user.

4. **Finalize**:
   - Run post-finalization review dispatches: @artifact-code-reviewer and @artifact-coverage-reviewer.
   - Triage findings with the user.

## Guidelines

- Use this when the research findings lead directly to an obvious design choice.
- If the research reveals multiple competing approaches, stop and switch to the full `research` -> `design` -> `plan` flow.
- The final artifact must meet the same completeness standards as a regular implementation plan.

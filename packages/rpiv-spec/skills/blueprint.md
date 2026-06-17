# Blueprint

`blueprint` is a fast-track skill that combines `research`, `design`, and `plan` into a single interleaved workflow. It is designed for small-to-medium tasks where separate artifacts for each stage would be too much overhead.

## Workflow

1. **Research (Interleaved)**:
   - Dispatch {{dispatch:scope-tracer}} to bound the scope.
   - Dispatch {{dispatch:codebase-analyzer}} and {{dispatch:codebase-pattern-finder}} in parallel to answer the core questions.
   - Interleave Step 3 Synthesis (checkpointing findings) with Step 4 Architectural Decisions.

2. **Design & Plan (Interleaved)**:
   - Skip the separate design document.
   - Go straight to phased plan decomposition (Step 5 of `plan`).
   - Create a single `.rpiv/artifacts/plans/YYYY-MM-DD_<topic>-blueprint.md` artifact using the combined template.

3. **Slice Generation**:
   - Generate slice code and success criteria (Step 6 of `plan`).
   - Use {{dispatch:slice-verifier}} for each slice.
   - Present condensed micro-checkpoints via {{tool:ask_user}}.

4. **Finalize**:
   - Run post-finalization review dispatches: {{dispatch:artifact-code-reviewer}} and {{dispatch:artifact-coverage-reviewer}}.
   - Triage findings with the user.

## Guidelines

- Use this when the research findings lead directly to an obvious design choice.
- If the research reveals multiple competing approaches, stop and switch to the full `research` -> `design` -> `plan` flow.
- The final artifact must meet the same completeness standards as a regular implementation plan.

---
name: design
description: Synthesize a design artifact in .rpiv/artifacts/designs/ from research findings. Uses vertical-slice decomposition to break down complex changes into reviewable architectural units. The design artifact's code fences and success criteria are inherited by `plan` or `blueprint`. Use when research is complete and you need to specify the architectural approach and file-level implementation details before planning execution.
---

# Design

You are tasked with synthesizing architectural designs into a design artifact based on research findings. Your goal is to specify the vertical-slice decomposition of a feature, defining exactly what code changes are needed and how they will be verified.

## Input

`$ARGUMENTS` — path to a research artifact in `.rpiv/artifacts/research/*.md`.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

## Workflow

1. **Read Research**:
   - Read the provided research artifact FULLY using the Read tool.
   - Extract the core research question, summary, and integration points.

2. **Identify Ambiguities (Wave 1 Dispatch)**:
   - Spawn parallel agents to fill gaps in the research:
     - @codebase-pattern-finder to find canonical examples for the proposed change.
     - @integration-scanner to confirm outbound dependencies.
     - @precedent-locator to check for similar architectural decisions.
   - Wait for all agents to complete.

3. **Developer Checkpoint**:
   - Present the identified approach and any remaining ambiguities via ask_user.
   - Get approval on the high-level design before proceeding to slicing.

4. **Vertical-Slice Decomposition**:
   - Break the design into logical slices (e.g. Schema → API → UI).
   - Each slice must be an atomic, reviewable unit.

5. **Generate Slice Code**:
   - For each slice, generate the complete implementation code for all affected files.
   - Use @slice-verifier for each slice to catch cross-slice mismatches.
   - Present condensed micro-checkpoints for each slice via ask_user.

6. **Write Design Artifact**:
   - Write the finalized design to `.rpiv/artifacts/designs/YYYY-MM-DD_<topic>-design.md`.
   - Frontmatter `status: ready`.

7. **Present & Chain**:
   - Present the artifact path.
   - **Next step:** `/skill:plan <design-path>`.

## Guidelines

- **Architecture first**: Ground every decision in codebase evidence.
- **Complete code**: Code blocks must be copy-pasteable. No TODOs.
- **Interactive**: Get buy-in at the checkpoint and each micro-checkpoint.
- **Atomic slices**: Each slice should be implementable in isolation.

---
name: implement
description: Execute an implementation plan by sequentially applying code changes to source files and running automated verification steps. Checkpoints with the user after every change. Use when an implementation plan is ready in .rpiv/artifacts/plans/ and you are ready to begin the work.
---

# Implement

You are tasked with executing a phased implementation plan by applying code changes and verifying them sequentially.

## Input

`$ARGUMENTS` — path to an implementation plan in `.rpiv/artifacts/plans/*.md`, optionally followed by `Phase N` to start at a specific phase.

## Workflow

1. **Read Plan**: Read the provided plan artifact FULLY.
2. **Determine Starting Phase**: Start at Phase 1 or the requested phase.
3. **Execute Phase**:
   - For each file modification in the phase:
     - Read the target file.
     - Apply the code change from the plan using the Edit tool.
     - todo_write update: mark task as complete.
   - Run **Automated Verification**:
     - Extract commands from the phase's `#### Automated Verification:` bullets.
     - Run each command. If any fail, STOP and ask the user for direction.
4. **Developer Checkpoint**:
   - Present the changes and verification results.
   - Use ask_user to confirm proceeding to the next phase.
5. **Repeat** until all phases are complete.

## Guidelines

- **Follow the plan**: Do not deviate from the plan's code fences without user approval.
- **Verify early**: Run tests as soon as the plan specifies.
- **Atomic commits**: Encourage the user to commit after each successful phase.

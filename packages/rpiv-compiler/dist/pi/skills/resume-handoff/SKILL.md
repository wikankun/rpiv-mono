---
name: resume-handoff
description: Resume work from a handoff document produced by create-handoff. Reads the handoff, verifies current repo, branch, and state, and continues from where the previous session left off. Use at the start of a new session when the user references a handoff file, says "resume from handoff", "continue from where we left off", or invokes /resume-handoff.
---

# Resume Handoff

You are tasked with resuming work from a handoff document through an interactive process. These handoffs contain critical context, learnings, and next steps from previous work sessions that need to be understood and continued.

## Input

`$ARGUMENTS` — path to a handoff document under `.rpiv/artifacts/handoffs/`. If omitted, the skill lists available handoffs and asks which to resume from.

## Metadata

```!
echo "### recent (read only in case of empty user input)"
echo "recent handoffs:"
node "${SKILL_DIR}/../_shared/list-recent.mjs" .rpiv/artifacts/handoffs 10
```

## Flow

1. Input → 2. Read & analyze handoff → 3. Synthesize & present → 4. Create action plan → 5. Begin implementation

## Steps

### Step 1: Input Handling

When this command is invoked:

1. **If the path to a handoff document was provided**:
   - If a handoff document path was provided as a parameter, skip the default message
   - Immediately read the handoff document FULLY using the Read tool
   - Immediately read any research or plan documents that it links to under `.rpiv/artifacts/plans` or `.rpiv/artifacts/research` or `.rpiv/artifacts/solutions`. Read these critical files DIRECTLY using the Read tool - do NOT invoke skills for this initial reading phase.
   - Begin the analysis process by ingesting relevant context from the handoff document, reading additional files it mentions
   - Then propose a course of action to the user and confirm, or ask for clarification on direction.

2. **If no parameters provided**, branch on the `recent handoffs:` listing in the Metadata block:
   - **Empty** — no handoffs exist; tell the user and ask for a path in prose.
   - **Exactly one entry** — confirm with ask_user_question: "Resume this handoff?" with options "Resume `<filename>` (Recommended)" and "Pick a different path".
   - **Two or more entries** — present the top 4 filenames as ask_user_question options.

### Step 2: Read and Analyze Handoff

1. **Read handoff document completely**:
   - Use the Read tool WITHOUT limit/offset parameters
   - Extract all sections (Tasks, Changes, Learnings, Artifacts, Next Steps).

2. **Spawn focused research agents**:
   Dispatch agents in parallel to gather artifact context and verify current state.
   - Agent({ subagent_type: "artifacts-analyzer", description: "analyze artifacts-analyzer", prompt: "$PROMPT" }) to summarize mentioned artifacts.
   - Agent({ subagent_type: "codebase-analyzer", description: "analyze codebase-analyzer", prompt: "$PROMPT" }) to verify recent changes and learnings still apply.
   - Wait for ALL agents to complete before proceeding.

3. **Verify current state**:
   - Use git log/diff to check history since handoff.
   - Re-read implementation files mentioned.

### Step 3: Synthesize and Present Analysis

1. **Present comprehensive analysis**:
   - Show status of original tasks, validated learnings, and recent changes.
   - List reviewed artifacts and recommended next actions.

2. **Confirm approach** via ask_user_question. Options: "Proceed (Recommended)"; "Adjust approach"; "Re-analyze".

### Step 4: Create Action Plan

1. **Create a task list**:
   - Convert action items from handoff into todos.
   - Add new tasks from analysis.
   - Prioritize and present.

### Step 5: Begin Implementation

1. Start with the first approved task.
2. Update progress as tasks complete.

## Important Guidelines

- **Validate before acting**: Never assume handoff state matches current state.
- **Leverage handoff wisdom**: Pay special attention to "Learnings".
- **Be interactive**: Get buy-in before starting work.

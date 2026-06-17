# Revise

You are tasked with updating existing implementation plans based on user feedback. You should be skeptical, thorough, and ensure changes are grounded in actual codebase reality.

## Input

`$ARGUMENTS` — plan path, workflow flags (`--plans`, `--reviews`), and feedback.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
echo "### recent (read only in case of empty user input)"
echo "recent plans:"
node "${SKILL_DIR}/../_shared/list-recent.mjs" .rpiv/artifacts/plans 10
```

## Flow

1. Input → 2. Research if needed → 3. Present approach → 4. Update plan → 5. Sync & review → 6. Follow-ups

## Steps

### Step 1: Input Handling

1. **Parse input** for workflow form or manual form.
2. **Handle missing input**:
   - If no plan, offer recent plans via {{tool:ask_user}}.
   - If no feedback, ask for it.
3. **Read plan COMPLETELY** using the Read tool.

### Step 2: Research If Needed

**Only spawn research tasks if the changes require new technical understanding.**

1. **Spawn parallel agents** for research:
   - {{dispatch:codebase-locator}} / {{dispatch:codebase-analyzer}} / {{dispatch:codebase-pattern-finder}} for code investigation.
   - {{dispatch:artifacts-locator}} / {{dispatch:artifacts-analyzer}} for historical context.
2. **Read identified files** fully.
3. **Wait for ALL agents to complete**.

### Step 3: Present Understanding and Approach

1. **Confirm understanding** with the developer.
2. **Confirm plan edits** via {{tool:ask_user}}. Options: "Proceed (Recommended)"; "Adjust approach"; "Show me first".

### Step 4: Update the Plan

1. **Make precise edits** using the Edit tool. NEVER use Write.
2. **Maintain structure and file:line references**.
3. **Uncheck modified work**: change `- [x]` back to `- [ ]` for items no longer guaranteed.
4. **Rebuild `phases:` array** in frontmatter if present.

### Step 5: Sync and Review

1. **Present changes made** and key improvements.
2. **Chain forward** to `/skill:implement`.

## Important Guidelines

- **Be skeptical and surgical**: Question vague feedback; avoid wholesale rewrites.
- **Thorough and interactive**: Ensure success criteria are still measurable; confirm before editing.
- **Track progress**: Update todos as research completes.

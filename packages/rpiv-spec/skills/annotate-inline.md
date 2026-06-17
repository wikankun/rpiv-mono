# Annotate Inline

You are tasked with generating or updating `CLAUDE.md` files inline within a project's source tree to document its architecture and patterns. This is the inline version of the guidance annotation system.

## Input

`$ARGUMENTS` — optional target directory. Defaults to the current working directory.

## Workflow

This skill follows the same logic as `annotate-guidance` but writes to `CLAUDE.md` files instead of `.rpiv/guidance/**/architecture.md`.

1. **Map and Decompose**: Same as `annotate-guidance` Step 2 and 3.
2. **Analyze**: Same as `annotate-guidance` Step 4.
3. **Write Inline**:
   - Write synthesized analysis to `CLAUDE.md` in each confirmed target directory.
   - Use the same template as `annotate-guidance`.
   - If a `CLAUDE.md` already exists, append or merge the new content intelligently.

## Important Guidelines

- Follow the **Guidance Depth Rules** from `annotate-guidance`.
- Ensure `CLAUDE.md` files remain compact and high-signal.
- Use `{{tool:ask_user}}` to confirm target locations.

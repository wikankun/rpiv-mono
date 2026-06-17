# RPIV Specification Notes

## Macro Mapping Table

| Pi Pattern | Macro | Target Tool (CC) |
|---|---|---|
| `Agent({ subagent_type: "...", ... })` | `{{dispatch:<id>}}` | `@<id>` |
| `web_search(...)` | `{{tool:web_search}}` | `google_web_search` |
| `web_fetch(...)` | `{{tool:web_fetch}}` | `web_fetch` |
| `todo_write(...)` | `{{tool:todo_write}}` | `write_todos` |
| `ask_user_question(...)` | `{{tool:ask_user}}` | `ask_user` |
| `advisor()` | `{{tool:advisor}}` | `advisor()` |

## Resolved Items

- **Leakage**: Pi-specific `pi.sendMessage` and `Agent({ ... })` patterns have been removed from the spec and replaced with generic descriptions or macros.
- **Advisor**: Mapped to `slow` role in OMP and preserved as a macro in Claude Code.
- **Shell execution**: Shell scripts in `SKILL.md` (e.g., `now.mjs`) are preserved as they are supported by target runners.

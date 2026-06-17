# RPIV Porting Matrix: Claude Code & omp

This document tracks the porting status of RPIV features from the original `pi-mono` / `rpiv-pi` implementation to the new Claude Code (`rpiv-claude`) and oh-my-pi (`rpiv-omp`) targets.

## Core Pipeline (The "Big 5")

| Feature | Claude Code | omp | Status / Notes |
| :--- | :---: | :---: | :--- |
| **Discover** | ✅ | ✅ | **Full**. Interview loop works via `ask_user`. |
| **Research** | ✅ | ✅ | **Full**. Parallel analyzer agents work via `Agent()`. |
| **Design** | ✅ | ✅ | **Full**. Slicing and code-fence generation ported. |
| **Plan** | ✅ | ✅ | **Full**. Phased breakdown and post-review gates. |
| **Implement** | ✅ | ✅ | **Full**. Sequentially applies edits and runs tests. |

## Specialized Skills

| Feature | Claude Code | omp | Status / Notes |
| :--- | :---: | :---: | :--- |
| **Code Review** | ✅ | ✅ | **Full**. Parallel Waves (Discovery, Audit, Verify). |
| **PR Triage** | ✅ | ✅ | **Full**. Security and drift assessment. |
| **Changelog** | ✅ | ✅ | **Full**. Idempotent regeneration from git log. |
| **Handoffs** | ✅ | ✅ | **Full**. Context compaction (Create/Resume). |
| **Guidance** | ⚠️ | ✅ | **Partial (CC)**: `sync-guidance` works, but CC lacks native subfolder guidance injection. **Full (omp)**: Native. |
| **Frontend Design** | ✅ | ✅ | **Full**. Aesthetic principles and interview. |

## Sibling Plugin Integrations (Macros)

RPIV relies on sibling plugins for certain platform-level capabilities. These are handled via `{{tool:id}}` macros.

| Pi Plugin | Macro | Status (CC / omp) | Notes |
| :--- | :--- | :---: | :--- |
| **rpiv-args** | N/A | ✅ | Ported via skill-body variable interpolation. |
| **rpiv-ask-user** | `ask_user` | ✅ | Maps to native `ask_user` tool in both. |
| **rpiv-todo** | `todo_write` | ⚠️ | **Partial**. Logic ported, but lacks Pi's TUI overlay. |
| **rpiv-advisor** | `advisor` | ✅ | **Full**. Maps to stronger model (CC) or `slow` role (omp). |
| **rpiv-web-tools** | `web_search` | ✅ | Maps to `google_web_search` (CC) or native (omp). |
| **rpiv-web-tools** | `web_fetch` | ✅ | Maps to native `web_fetch` in both. |
| **rpiv-btw** | N/A | ❌ | **Not Ported**. Requires UI side-thread capability. |
| **rpiv-warp** | N/A | ❌ | **Not Ported**. Terminal-specific (Warp). |

## Key Platform Differences

### Claude Code (`rpiv-claude`)
- **Macro Mapping**: Uses `@agent` syntax and `google_web_search`.
- **Guidance Injection**: Managed via `rpivc sync-guidance` which merges project rules into the top-level `CLAUDE.md`.
- **Lifecycle**: Uses `session_start` hook for repo scaffolding.

### oh-my-pi (`omp`)
- **Macro Mapping**: Uses `@agent` or `Agent()` compatibility layer.
- **Model Tiers**: `advisor` prompts are automatically routed to the `slow` model role.
- **Discovery**: `omp` auto-discovers skills in the `skills/` directory via the fixed `omp` manifest key.

## Known Gaps (Not Ported)
1. **TUI Overlays**: The persistent progress overlay from `rpiv-todo` is not available in the standard CLI output.
2. **Interactive TUI Pickers**: Selection UIs (like the guidance target picker) are currently text-only / list-based.
3. **By-The-Way threads**: Side-conversations that don't pollute history are not yet supported by current CLI agent runners.

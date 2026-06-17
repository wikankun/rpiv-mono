# omp Diagnosis (Verified Findings)

Based on remote source analysis of `can1357/oh-my-pi` and documentation:

## 1. Path Conventions (Confirmed)
- **Home Dir**: `~/.omp/`.
- **Agents Dir**: `~/.omp/agent/agents/` (global), `.omp/agents/` (project).
- **Discovery**: `omp` natively ingests `.claude/skills/` and `.claude/agents/` on startup.

## 2. Plugin Manifest & Compatibility (Issue #433)
- **Root Cause**: `omp`'s loader (`loader.ts`) checks for `pkg.omp ?? pkg.pi`. It **does not** implement the composite `pi/omp` key used by many `pi-mono` packages.
- **Fix**: The `omp` target (or the `rpiv-pi` export) must use a single `omp` or `pi` key in `package.json`.

## 3. Tool & Dispatch Deltas
- **Dispatch Tool**: Referred to as the **Task tool** in docs. Signature `Agent({ subagent_type, ... })` is supported for compatibility, but underlying mechanic is `newSession`.
- **Model Tiers**: Roles are `default`, `smol`, `slow`, `plan`, `commit`. 
- **Mapping**: `model_tier: advisor` maps to **`slow`**.

## 4. Hook & Lifecycle (Verified)
- **Event Names**: **snake_case** (e.g., `session_start`, `session_compact`, `before_agent_start`, `agent_end`). Identical to `pi-mono`.
- **API Reference**: The hook factory receives a `HookAPI` (commonly aliased as `pi` or `omp`).

## 5. Environment Macros
- **Syntax**: Uses standard environment variable syntax: **`$SKILL_DIR`**.
- **Migration**: Recent versions have moved away from `{{skill_dir}}` placeholders in favor of direct env var resolution.

## UI & Toggling (Issue #413)
- **Status**: `disabledExtensions` exists in TUI config but might not effectively block discovery in all versions.

## Experiment: Claude Code Compatibility
- `omp`'s discovery layer is designed to ingest `.claude/` output directly. 
- **Strategy**: We should first attempt to load the Phase 3 `dist/claude-code/` output into `omp`. If discovery works, the `--target omp` compiler phase may only need to handle the `package.json` manifest delta and any `omp`-specific thinking-level optimizations.

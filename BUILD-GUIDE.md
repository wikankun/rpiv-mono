# Build Guide: RPIV Porting

This document explains how to build the RPIV compiler and generate the target-specific plugins for Claude Code and oh-my-pi (omp).

## Build Infrastructure

The porting architecture uses a three-tier build system:
1.  **`rpiv-spec`**: Canonical source for skills and agents using universal macros.
2.  **`rpiv-compiler`**: A TypeScript CLI (`rpivc`) that expands macros into target-specific syntax.
3.  **Target Packages**: Auto-generated folders (`rpiv-claude`, `rpiv-omp`) ready for installation.

---

## 1. Setup the Compiler

Before generating any plugins, you must build the compiler:

```bash
# Navigate to the compiler package
cd packages/rpiv-compiler

# Install dependencies
npm install

# Compile TypeScript to JavaScript
npx tsc -p tsconfig.json
```

---

## 2. Generate Target Plugins

Use the `rpivc` CLI to build for your desired platform. All commands are run from the `packages/rpiv-compiler` directory.

### For Claude Code
Generates a version-controlled plugin structure at the monorepo root.

```bash
bin/rpivc.js build --target claude-code --out ../rpiv-claude
```

### For oh-my-pi (omp)
Generates an OMP-native plugin with specific manifest fixes and model routing.

```bash
bin/rpivc.js build --target omp --out ../rpiv-omp
```

### For Pi Agent (Regression Baseline)
Generates the original Pi-style layout used for verification against the source.

```bash
bin/rpivc.js build --target pi --out dist/pi
```

---

## 3. Validation

To ensure the canonical spec is coherent and all agent dispatches resolve correctly:

```bash
bin/rpivc.js validate
```

---

## 4. Sync Guidance (Claude Code)

To inject RPIV architectural guidance into a target repository's `CLAUDE.md`:

```bash
cd /path/to/your/project
/path/to/rpiv-mono/packages/rpiv-compiler/bin/rpivc.js sync-guidance --target . --guidance-file CLAUDE.md
```

---

## Technical Details

- **Macros**: The compiler expands `{{dispatch:id}}` into platform-native sub-agent calls and `{{tool:id}}` into native tool invocations.
- **Manifests**: The compiler auto-generates `.claude-plugin/plugin.json` for Claude Code and ensures `package.json` has the correct `omp` keys.
- **Advisor Routing**: OMP builds automatically route `model_tier: advisor` to the `slow` model role.

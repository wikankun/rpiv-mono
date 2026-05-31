# Workflow Basics

A workflow chains Pi skills into a typed multi-stage graph with audited JSONL state, predicate routing, and per-stage output validation. Workflows are **skill-agnostic** — they name skills by their installed name, and the runner dispatches `/skill:<name>` via Pi's native skill loader.

## Table of Contents

- [Running workflows](#running-workflows)
- [File structure](#file-structure)
- [Layer merging](#layer-merging)
- [Config files](#config-files)
- [Pack files](#pack-files)
- [Skill aliases](#skill-aliases)
- [Example](#example)

## Running workflows

```bash
/wf                        # Preview every loaded workflow
/wf <name>                 # Preview one workflow's stage graph
/wf <name> <input>         # Run a workflow with <input> piped to the start stage
```

Running `/wf` without arguments shows a list of every loaded workflow and its stages. Running `/wf <name>` without input shows that workflow's stage graph in detail. The `<input>` string becomes the start stage's prompt.

## File structure

```
<cwd>/.rpiv/workflows/
├── config.ts                 # The project's workflow config (hand-edited)
├── packs/                    # Pack files (installable bundles)
│   ├── my-pipeline.ts
│   └── ship.ts
└── runs/                     # Audited JSONL run state (<run-id>.jsonl)

~/.config/rpiv-workflow/
├── config.ts                 # User-level config
└── packs/                    # User-level packs
```

Every workflow file is TypeScript, loaded via `jiti` (no build step required). Import the authoring DSL from `@juicesharp/rpiv-workflow`:

```typescript
import { defineWorkflow, produces, acts, gate, gt, eq } from "@juicesharp/rpiv-workflow";
```

## Layer merging

The loader merges workflows from five layers. Each later layer overrides earlier by workflow name:

```
built-in (registered by sibling packages like rpiv-pi)
  ← user packs        (~/.config/rpiv-workflow/packs/*.ts, alpha-sorted)
  ← user config       (~/.config/rpiv-workflow/config.ts)
  ← project packs     (<cwd>/.rpiv/workflows/packs/*.ts, alpha-sorted)
  ← project config    (<cwd>/.rpiv/workflows/config.ts)
```

Within a layer, the config file wins by workflow name over pack files. Only the config file may set the `default` workflow (the one `/wf <input>` runs without specifying a name). Defaults cascade: `project config > user config > first registered workflow`.

## Config files

The config file (`config.ts`) is the one TypeScript file you hand-edit. It accepts three default-export shapes:

```typescript
// 1. A single Workflow
import { defineWorkflow, produces, acts } from "@juicesharp/rpiv-workflow";
export default defineWorkflow({
  name: "ship",
  start: "implement",
  stages: { implement: acts(), commit: acts() },
  edges: { implement: "commit", commit: "stop" },
});

// 2. A Workflow[] with a single entry
export default [/* one workflow */];

// 3. The envelope form — required when shipping multiple workflows
export default {
  workflows: [/* many */],
  default: "ship",   // which one `/wf <input>` runs without a name
};
```

## Pack files

Pack files (`packs/*.ts`) are installable bundles others can drop in. They accept only `Workflow | Workflow[]`. Packs **cannot** set `default` — that lives in the config file.

```typescript
// workflows/my-pipeline.ts
import { defineWorkflow, produces, acts } from "@juicesharp/rpiv-workflow";
export default defineWorkflow({
  name: "my-pipeline",
  start: "research",
  stages: { research: produces({ outcome: myOutcome }), implement: acts() },
  edges: { research: "implement", implement: "stop" },
});
```

This is what makes installable workflow packs safe: a pack contributes new workflows without overriding the user's default.

## Skill aliases

`skillAliases` remaps a skill name everywhere — across built-in, user, and project workflows — with one declarative config entry. It lives in the config-file envelope (packs can't set it) and is applied at load time, so `/wf` preview, the JSONL audit, and the runtime skill-registry preflight all see the final skill:

```typescript
// .rpiv/workflows/config.ts
export default {
  skillAliases: { commit: "attributed-commit" },
};

// composes with workflows + default:
export default {
  workflows: [myWorkflow],
  default: "ship",
  skillAliases: { commit: "attributed-commit", "code-review": "strict-review" },
};
```

Every dispatching stage whose effective skill (`stage.skill ?? <stage key>`) matches an alias key is remapped to the target — note the key is the **skill** name, not the stage id. The mapping is one hop only (no transitive chains), skips `run`/`prompt` stages (they don't dispatch a `/skill:`), and merges **project over user** per key. An alias-only config (no `workflows`) is valid. `/wf` shows a `Skill aliases in effect: commit → attributed-commit` banner; an alias key that matches no dispatched skill in any workflow surfaces a load-time warning (a harmless no-op). A bad alias **target** (a skill that doesn't exist) is caught by the existing runtime "skill not found" preflight.

## Example

A minimal workflow that chains two skills:

```typescript
import { defineWorkflow, produces, acts } from "@juicesharp/rpiv-workflow";

export default defineWorkflow({
  name: "review-and-ship",
  start: "code-review",
  stages: {
    "code-review": produces({ outcome: myOutcome }),
    commit: acts(),
  },
  edges: {
    "code-review": "commit",
    commit: "stop",
  },
});
```

Save this as `.rpiv/workflows/config.ts` in your project, then run `/wf review-and-ship implement auth feature`.

For the full DSL reference (all stage factories, routing, outcomes, validators), see [workflow-authoring.md](./workflow-authoring.md).

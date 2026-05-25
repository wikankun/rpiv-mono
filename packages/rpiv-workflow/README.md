# @juicesharp/rpiv-workflow

Pi extension. Chain Pi skills into typed multi-stage workflows with audited JSONL state, predicate routing, and per-stage manifest validation.

**Skill-agnostic.** The runner sends `/skill:<name>` via Pi's native dispatch — it doesn't know or care who shipped the skill. Install on its own and write workflows over your own `~/.pi/agent/skills/`, or pair with [`@juicesharp/rpiv-pi`](../rpiv-pi) to use rpiv-pi's bundled `mid`, `large`, `small` workflows over rpiv-pi's bundled skills.

## Install

```sh
pi install @juicesharp/rpiv-workflow
```

## Use

```
/wf                        # preview every loaded workflow
/wf <name>                 # preview one workflow's stage graph
/wf <name> <input>         # run a workflow with <input> piped to the start node
```

## Configure

The loader merges workflows from three layers (each later layer overrides earlier by workflow name):

```
built-in (programmatic — registered by sibling packages like rpiv-pi)
  ← user drop-ins      (~/.config/rpiv-workflow/workflows/*.ts, alpha-sorted)
  ← user canonical     (~/.config/rpiv-workflow/workflows.config.ts)
  ← project drop-ins   (<cwd>/.rpiv-workflow/workflows/*.ts, alpha-sorted)
  ← project canonical  (<cwd>/.rpiv-workflow/workflows.config.ts)
```

**Canonical files** accept three default-export shapes:

```ts
// 1. A single Workflow
import { defineWorkflow, artifact, action } from "@juicesharp/rpiv-workflow";
export default defineWorkflow({
  name: "ship",
  start: "implement",
  nodes: { implement: action(), commit: action() },
  edges: { implement: "commit", commit: "stop" },
});

// 2. A Workflow[] with a single entry
export default [ /* one workflow */ ];

// 3. The envelope form — required when shipping multiple workflows
export default {
  workflows: [ /* many */ ],
  default: "ship",   // which one `/wf <input>` runs without a name
};
```

**Drop-in files** accept only `Workflow | Workflow[]`. They cannot set `default` — that lives in the canonical file (one source of truth per layer). This makes installable workflow packs safe: a pack can contribute new workflows without overriding the user's default.

## Programmatic registration

Sibling packages contribute workflows at extension load:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBuiltIns } from "@juicesharp/rpiv-workflow";
import { myWorkflows } from "./my-workflows.js";

export default function (pi: ExtensionAPI): void {
  registerBuiltIns(myWorkflows);
}
```

These workflows are merged into the lowest layer (`built-in`); user/project overlays still override by name.

## Custom extractors

A stage's manifest is produced by an `Extractor` — `before` runs once before the agent session (its return value lands in `ctx.snapshot`), `extract` runs after the session settles. Compose the bundled `gitHeadSnapshot` into your own `before` to read a git baseline from any extractor:

```ts
import type { Extractor, GitHeadSnapshot } from "@juicesharp/rpiv-workflow";
import { gitHeadSnapshot } from "@juicesharp/rpiv-workflow";

const touchedFilesExtractor: Extractor<GitHeadSnapshot | undefined, "touched-files", { files: number }> = {
  before: gitHeadSnapshot,
  async extract(ctx) {
    if (!ctx.snapshot) return { kind: "ok", payload: { kind: "touched-files", data: { files: 0 } } };
    const files = await countChangedFiles(ctx.cwd, ctx.snapshot.baselineSha);
    return { kind: "ok", payload: { kind: "touched-files", data: { files } } };
  },
};
```

`Extractor<Snap, Kind, Data>` is generic over the snapshot type and the payload's `kind` + `data` — so downstream predicates can narrow on `manifest.kind === "touched-files"` and read `manifest.data.files` with full type inference.

## Architecture

See [`.rpiv/guidance/packages/rpiv-workflow/architecture.md`](../../.rpiv/guidance/packages/rpiv-workflow/architecture.md).

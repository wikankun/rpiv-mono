# rpiv-pi

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-pi">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-pi/docs/cover.png" alt="rpiv-pi cover" width="50%">
    </picture>
  </a>
</div>

> **Pi compatibility** - `rpiv-pi` tracks `@earendil-works/pi-coding-agent` and `@tintinweb/pi-subagents` `0.10.x`. If you see peer-dep resolution issues after a Pi upgrade, open an issue.

> **⚠️ Upgrading to `@tintinweb/pi-subagents` `0.10.x`** - frontmatter tool gating changed: extension tools now route through `ext:<extension>/<tool>`. The bundled `web-search-researcher` is migrated - run `/rpiv-update-agents` to refresh it. Customised copies need a manual edit (see CHANGELOG).

> **⚠️ Upgrading from `0.13.x`** - `1.0.0` swaps the subagent provider from `npm:pi-subagents` (nicobailon fork) back to `npm:@tintinweb/pi-subagents` (resumed maintenance). On first launch after upgrade you'll see *"rpiv-pi requires 1 sibling extension(s): @tintinweb/pi-subagents"* - **run `/rpiv-setup` once and restart Pi**. The setup dialog previews both changes (install `@tintinweb/pi-subagents`, remove `npm:pi-subagents` from `~/.pi/agent/settings.json`) and applies them only after you confirm. After restart, run `/rpiv-update-agents` to refresh the 12 bundled specialist frontmatters. Customised `<cwd>/.pi/agents/*.md` files are not touched. The tool name reverts from `subagent` → `Agent` (param `subagent_type`/`description`/`prompt`) - only your own custom skills/agents need editing; the bundled rpiv-pi specialists are migrated in this release.

Skill-based development workflow for [Pi Agent](https://github.com/badlogic/pi-mono) - discover, research, design, plan, implement, and validate. rpiv-pi extends Pi Agent with a pipeline of chained AI skills, named subagents for parallel analysis, and session lifecycle hooks for automatic context injection.

## What you get

- **A pipeline of chained AI skills** - discover → research → design → plan → implement → validate, each producing a reviewable artifact under `.rpiv/artifacts/`.
- **Named subagents for parallel analysis** - `codebase-analyzer`, `codebase-locator`, `codebase-pattern-finder`, `claim-verifier`, and 11 more, dispatched automatically by skills.
- **Session lifecycle hooks** - agent profiles and guidance files install themselves on first launch.

## Prerequisites

- **Node.js** - required by Pi Agent
- **[Pi Agent](https://github.com/badlogic/pi-mono)** - install globally so the `pi` command is available:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

- **Model provider** *(first-time Pi Agent users only - skip if `/login` already works or `~/.pi/agent/models.json` is configured)*. Pick one:

  - **Subscription login** - start Pi Agent and run `/login` to authenticate with Anthropic Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, or Gemini.
  - **BYOK (API key)** - edit `~/.pi/agent/models.json` and add a provider entry with `baseUrl`, `api`, `apiKey`, and `models[]`. Example (z.ai GLM coding plan):

    ```json
    {
      "providers": {
        "zai": {
          "baseUrl": "https://api.z.ai/api/coding/paas/v4",
          "api": "openai-completions",
          "apiKey": "XXXXXXXXX",
          "compat": {
            "supportsDeveloperRole": false,
            "thinkingFormat": "zai"
          },
          "models": [
            {
              "id": "glm-5.1",
              "name": "glm-5.1 [coding plan]",
              "reasoning": true,
              "input": ["text"],
              "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
              "contextWindow": 204800,
              "maxTokens": 131072
            }
          ]
        }
      }
    }
    ```

- **git** *(recommended)* - rpiv-pi works without it, but branch and commit context won't be available to skills.

## Quick Start

1. Install rpiv-pi:

```bash
pi install npm:@juicesharp/rpiv-pi
```

2. Start a Pi Agent session and install sibling plugins:

```
/rpiv-setup
```

3. Restart your Pi Agent session.

4. *(Optional)* Configure web search:

```
/web-tools
```

### First Session

On first Pi Agent session start, rpiv-pi automatically:
- Copies agent profiles to `~/.pi/agent/agents/` (user-global, shared across all projects)
- Detects outdated or removed agents on subsequent starts
- Migrates legacy pipeline-artifact content into `.rpiv/artifacts/` (one-way) when an old `thoughts/shared/` tree is found; otherwise `.rpiv/artifacts/` is created lazily by the first skill that writes an artifact
- Shows a warning if any sibling plugins are missing

## Usage

### Typical Workflow

```
/skill:discover "add a /skill:fast that runs research+design+plan in one shot"
/skill:research .rpiv/artifacts/discover/<latest>.md
/skill:design .rpiv/artifacts/research/<latest>.md
/skill:plan .rpiv/artifacts/designs/<latest>.md
/skill:implement .rpiv/artifacts/plans/<latest>.md Phase <N>
```

Each skill produces an artifact consumed by the next. Run them in order, or jump in at any stage if you already have the input artifact.

### Recipes

Skills compose. Pick the entry point that matches your intent:

- **Capture intent before research** - `/skill:discover "[feature description]"`. Walks you through a one-question-at-a-time interview to settle Goals/Non-Goals, Functional/Non-Functional Requirements, Acceptance Criteria, and a Decisions log into a Feature Requirements Document under `.rpiv/artifacts/discover/`. Use as the canonical entry point of the pipeline before research, or to stress-test a feature idea before any codebase work. The FRD's Decisions are inherited by `design` through `research`'s Developer Context.
- **Form context before a task** - `/skill:research "[topic]"` (or `/skill:research .rpiv/artifacts/discover/<latest>.md` if you ran discover first). Produces a high-signal subspace of the codebase relevant to your topic, ready to feed directly into the next prompt. The `scope-tracer` subagent runs in-band to formulate trace-quality questions before analysis dispatch; when chained from discover, FRD Decisions translate into Developer Context Q/A entries verbatim.
- **Compare approaches before designing** - `/skill:explore "[problem]"` → `/skill:design <solutions artifact>`. Use when multiple valid solutions exist; the solutions artifact is a first-class input to `design` alongside a `research` artifact.
- **One-shot plan from research** - `/skill:research <questions>` → `/skill:blueprint <research artifact>` → `/skill:implement`. Fuses `design` + `plan` into a single pass with the same slice-by-slice rigor, but spawns only `codebase-pattern-finder` upfront (vs `design`'s 4-agent fan-out) by trusting the research artifact's integration/precedent sections. Use for solo work or when no one else needs to review the design before implementation; pick `design` → `plan` when the design is itself a deliverable or when research is thin and you want the fuller verification sweep.
- **Full feature build** - `/skill:discover` → `research` → `design` → `plan` → `implement` → `validate` → (`code-review` ↔ `commit`). The default pipeline; jump in at any stage if you already have the input artifact.
- **Investigate a bug** - `/skill:discover "why does X fail"` → `/skill:research .rpiv/artifacts/discover/<latest>.md`. The discover interview surfaces what you actually want to know before research grounds it; fix from research output without writing a plan when the change is small.
- **Adjust mid-implementation** - `/skill:revise <plan artifact>` → resume `/skill:implement`. Use when new constraints land after the plan is drafted.
- **Review before shipping** - `/skill:code-review` ↔ `/skill:commit`. Order is your call: review `staged`/`working` before committing to catch issues at the smallest blast radius, or commit first and review the resulting branch (empty scope defaults to feature-branch-vs-default-branch, first-parent). Produces a Quality/Security/Dependencies artifact under `.rpiv/artifacts/reviews/` with claim-verifier-grounded findings and `status: approved | needs_changes`.
- **Audit a specific scope** - `/skill:code-review <commit|staged|working|hash|A..B|branch>`. Targeted lenses over a commit, range, staged/working tree, or PR branch; advisor adjudication applies when configured (`/advisor`).
- **Review-driven plan revision** - `/skill:code-review` → `/skill:revise <plan artifact>` → resume `/skill:implement`. When a mid-stream review surfaces structural findings that the existing plan can't absorb as spot fixes.
- **Hand off across sessions** - `/skill:create-handoff` → (new session) `/skill:resume-handoff <doc>`. Preserves context when stopping mid-task.
- **Onboard a fresh repo** - `/skill:annotate-guidance` once, then use the rest of the pipeline normally. Use `annotate-inline` instead if the project follows the `CLAUDE.md` convention.

### Skills

Invoke via `/skill:<name>` from inside a Pi Agent session.

#### Research & Design

| Skill | Input | Output | Description |
|---|---|---|---|
| `discover` | Free-text feature description or existing artifact path | `.rpiv/artifacts/discover/` | Interview-driven Feature Requirements Document producer; one question at a time with a recommended answer at every step. FRD Decisions inherited by `design` via `research`'s Developer Context |
| `research` | Free-text prompt or `discover` artifact path | `.rpiv/artifacts/research/` | Frame scope via the `scope-tracer` subagent, then answer via parallel analysis agents |
| `explore` | - | `.rpiv/artifacts/solutions/` | Compare solution approaches with pros/cons |
| `design` | Research or solutions artifact | `.rpiv/artifacts/designs/` | Design features via vertical-slice decomposition |

#### Implementation

| Skill | Input | Output | Description |
|---|---|---|---|
| `plan` | Design artifact | `.rpiv/artifacts/plans/` | Create phased implementation plans |
| `blueprint` | Research or solutions artifact | `.rpiv/artifacts/plans/` | Fused `design` + `plan`: vertical-slice decomposition with micro-checkpoints, emits implement-ready phased plan in one pass. Lighter on subagent fan-out than `design` - trusts the research artifact's integration/precedent sections instead of re-dispatching. Use when a separate design artifact isn't needed for review or handoff |
| `implement` | Plan artifact | Code changes | Execute plans phase by phase |
| `revise` | Plan artifact | Updated plan | Revise plans based on feedback |
| `validate` | Plan artifact | Validation report | Verify plan execution |

#### Annotation

| Skill | Input | Output | Description |
|---|---|---|---|
| `annotate-guidance` | - | `.rpiv/guidance/*.md` | Generate architecture guidance files |
| `annotate-inline` | - | `CLAUDE.md` files | Generate inline documentation |
| `migrate-to-guidance` | CLAUDE.md files | `.rpiv/guidance/` | Convert inline docs to guidance format |

#### Utilities

| Skill | Description |
|---|---|
| `code-review` | Comprehensive code reviews using specialist row-only agents (`diff-auditor`, `peer-comparator`, `claim-verifier`) at narrativisation-prone dispatch sites |
| `architecture-review` | Top-down, layer-by-layer architecture review with a uniform 10-dimension checklist per layer; emits a phased polish plan under `.rpiv/artifacts/architecture-reviews/` |
| `pr-triage` | Read-only triage of a GitHub PR: disposition (Review / Request changes / Hold / Decline) plus a security tier (0 SAFE / 1 REVIEW / 2 BLOCK); never mutates the working tree |
| `commit` | Structured git commits grouped by logical change |
| `changelog` | Regenerate `[Unreleased]` CHANGELOG.md sections from Conventional-Commit history - Keep-a-Changelog style, monorepo-aware, idempotent |
| `frontend-design` | Inject tailored visual design guidance for web-frontend work; auto-adapts from a 2-question micro-interview to scan-only injection based on the project's style system |
| `create-handoff` | Context-preserving handoff documents for session transitions |
| `resume-handoff` | Resume work from a handoff document |

### Commands

| Command | Description |
|---|---|
| `/rpiv-setup` | Install all sibling plugins in one go |
| `/rpiv-update-agents` | Refresh `~/.pi/agent/agents/` from bundled agent definitions and clean up legacy per-project agent directories. Re-reads `models.json` before syncing, so mid-session per-agent `model`/`thinking` overrides take effect on disk |
| `/advisor` | Configure advisor model and reasoning effort |
| `/btw` | Ask a side question without polluting the main conversation _(requires `@juicesharp/rpiv-btw`, opt-in)_ |
| `/languages` | Pick the UI language for rpiv-* TUI strings (Deutsch / English / Español / Français / Português / Português (Brasil) / Русский / Українська) |
| `/todos` | Show current todo list |
| `/web-tools` | Pick the active search provider and set its API key |
| `/wf` | Run a workflow: `/wf` previews every flow, `/wf <name>` shows one's graph, `/wf <name> "task"` runs it, `/wf @<run-id>` resumes _(ships with `@juicesharp/rpiv-workflow`, installed by `/rpiv-setup`)_ |
| `/rpiv-models` | Pick model + reasoning-effort overrides per default, agent, skill, workflow stage, or preset stage (see **Model configuration** below) |

### Agents

Agents are dispatched automatically by skills via the `Agent` tool - you don't invoke them directly.

| Agent | Purpose |
|---|---|
| `claim-verifier` | Grounds each supplied code-review claim against repository state and tags it Verified / Weakened / Falsified |
| `codebase-analyzer` | Analyzes implementation details for specific components |
| `codebase-locator` | Locates files, directories, and components relevant to a feature or task |
| `codebase-pattern-finder` | Finds similar implementations and usage examples with concrete code snippets |
| `diff-auditor` | Walks a patch against a caller-supplied surface-list and emits `file:line \| verbatim \| surface-id \| note` rows |
| `integration-scanner` | Maps inbound references, outbound dependencies, config registrations, and event subscriptions for a component |
| `peer-comparator` | Compares a new file against a peer sibling and tags each invariant Mirrored / Missing / Diverged / Intentionally-absent |
| `precedent-locator` | Finds similar past changes in git history - commits, blast radius, and follow-up fixes |
| `scope-tracer` | Sweeps anchor terms and reads key files to bound a research investigation - returns a Discovery Summary plus dense numbered questions |
| `slice-verifier` | Adversarially audits each freshly-generated slice of a phased plan or design before it is locked - catches forward-references, cross-slice symbol mismatches, and decision drift |
| `artifact-code-reviewer` | Reviews each slice code fence in a finalized artifact for code quality, codebase fit, and actionability - one severity-tagged row per finding |
| `artifact-coverage-reviewer` | Verifies every Verification Note and Precedent entry in a finalized artifact lands somewhere actionable - success criterion or emitted code |
| `artifacts-analyzer` | Performs deep-dive analysis on a research topic in `.rpiv/artifacts/` |
| `artifacts-locator` | Discovers relevant documents in the `.rpiv/artifacts/` directory |
| `web-search-researcher` | Researches modern web-only information via deep search and fetch |

## Architecture

```
rpiv-pi/
├── extensions/rpiv-core/   - runtime extension: hooks, commands, guidance injection
├── skills/                 - AI workflow skills (research → design → plan → implement)
├── agents/                 - named subagent profiles dispatched by skills
└── .rpiv/artifacts/        - pipeline artifact store
```

Pi Agent discovers extensions via `"extensions": ["./extensions"]` and skills via `"skills": ["./skills"]` in `package.json`.

## Configuration

- **Web search** - run `/web-tools` to pick a provider (Brave, Tavily, Serper, Exa, You.com, Jina, Firecrawl, Perplexity, SearXNG, or Ollama) and set its API key; the per-provider env var (e.g. `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`) also works and takes precedence
- **Advisor** - run `/advisor` to select a reviewer model and reasoning effort
- **Models & reasoning effort** - run `/rpiv-models` to pick a model and reasoning level for the global default, a specific bundled agent, a workflow stage, a skill, or a per-preset stage; the picker writes `~/.config/rpiv-pi/models.json`. See **Model configuration** below for the cascade ladder and worked examples.
- **Side questions** _(opt-in: `pi install npm:@juicesharp/rpiv-btw`)_ - type `/btw <question>` anytime (even mid-stream) to ask the primary model a one-off question; answer appears in a borderless bottom overlay and never enters the main conversation
- **UI language** - run `/languages` to pick the locale for rpiv-* TUI strings, or pass `pi --locale <code>` at startup. Detection priority: flag → `~/.config/rpiv-i18n/locale.json` → `LANG` / `LC_ALL` → English. LLM-facing copy stays English by design
- **Agent concurrency** - open the `/agents` overlay and tune `Settings → Max concurrency` to match your provider's rate limits. `@tintinweb/pi-subagents` owns this setting; rpiv-pi does not seed it.
- **Agent profiles** - synced to `~/.pi/agent/agents/` from bundled defaults; refresh with `/rpiv-update-agents` (overwrites rpiv-managed files, preserves your custom agents).
- **Non-default agent directory** - if you set `PI_CODING_AGENT_DIR` (e.g. `~/.config/pi/agent` for an XDG-style layout), rpiv-pi reads and writes the same `settings.json` Pi does — sibling detection, `/rpiv-setup`, and `/rpiv-update-agents` all follow the env var. Leading `~` is expanded.

### Model configuration (models.json)

`rpiv-pi` reads `~/.config/rpiv-pi/models.json` to apply per-agent, per-stage, per-skill, and per-preset model + reasoning-effort overrides. The file is optional — missing or malformed JSON degrades to no overrides. Run `/rpiv-models` to edit it via cascade pickers, or hand-edit.

**Cascade ladder** (most specific first; each layer composes per-field against `defaults`):

1. `presets[workflow].stages[stage]` — per-workflow per-stage override (e.g. `ship.plan`).
2. `stages[stage]` — flat per-stage override (applies across every workflow that has it).
3. `skills[skill]` — per-skill override; applies to **both** `/wf` workflow stages AND user-typed standalone `/skill:<name>` invocations.
4. `defaults` — global fallback.

The standalone `/skill:` bracket has one exception: it arms ONLY on an explicit `skills[<name>]` entry. `defaults` does NOT trigger arming for user-typed `/skill:` invocations — your current session model stays sovereign.

**Worked example A — per-skill overrides for everyday short turns**:

```json
{
  "defaults": "anthropic/claude-opus-4-7",
  "skills": {
    "commit": "zai/glm-4-7",
    "changelog": "zai/glm-4-7",
    "research": { "model": "openai/gpt-5.5", "thinking": "high" }
  }
}
```

With this file, your default is Opus; `/skill:commit` and `/skill:changelog` use the cheaper GLM-4.7; `/skill:research` uses GPT-5.5 at high reasoning effort. Workflow-dispatched runs of the same skills get the same overrides (via the cascade's skill rung).

**Worked example B — per-workflow stage overrides for full pipelines**:

```json
{
  "defaults": "anthropic/claude-opus-4-7",
  "presets": {
    "ship": {
      "stages": {
        "plan":   "openai/gpt-5.5",
        "design": { "model": "openai/gpt-5.5", "thinking": "high" }
      }
    },
    "polish": {
      "stages": {
        "plan": "zai/glm-4-7"
      }
    }
  }
}
```

With this file, `/wf ship plan` and `/wf ship design` use GPT-5.5; `/wf polish plan` uses GLM-4.7; everything else falls through to Opus. Per-workflow overrides take precedence over the flat `stages` block when both define the same stage.

**Model key form** — canonical is `provider/modelId` (slash-separated). The legacy `provider:modelId` (colon) form still parses for back-compatibility with persisted advisor configs; new saves emit slash form, and legacy values auto-migrate on the next save.

**Reasoning levels** — six values accepted in the `thinking` field: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Note the distinction between **`off`** (explicitly disable reasoning) and **omitting** the field (inherit the session/baseline level). In `/rpiv-models` the effort picker offers `inherit (no override)` and `off (disable reasoning)` as separate choices. Any other value is rejected with a warning.

## Uninstall

1. Remove rpiv-pi from Pi: `pi uninstall npm:@juicesharp/rpiv-pi`
2. Optional - uninstall the subagent runtime if no other plugin needs it: `pi uninstall npm:@tintinweb/pi-subagents`
3. Restart Pi.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Warning about missing siblings on session start | Sibling plugins not installed | Run `/rpiv-setup` |
| `/rpiv-setup` fails on a package | Network or registry issue | Check connection, retry with `pi install npm:<pkg>`, re-run `/rpiv-setup` |
| `/rpiv-setup` says "requires interactive mode" | Running in headless mode | Install manually: `pi install npm:<pkg>` for each sibling |
| `web_search` or `web_fetch` errors | Active provider's API key not configured | Run `/web-tools` or set the matching env var (e.g. `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`) |
| `advisor` tool not available after upgrade | Advisor model selection lost | Run `/advisor` to re-select a model |
| Skills hang or serialize agent calls | Agent concurrency too low | Open `/agents`, raise `Settings → Max concurrency` |

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-pi.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT

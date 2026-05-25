# @juicesharp/rpiv-workflow

## [Unreleased]

### Breaking — on-disk JSONL header
- `WorkflowHeader.preset` renamed to `workflow`. Audit files written by
  prior versions have a header row that no longer matches the current
  shape. Audit files are debug artifacts (per `state.ts`); no migration
  is provided. (L2-08 / T5-vocabulary-drift)

### Added
- Initial release. Extracted from `@juicesharp/rpiv-pi` as a standalone Pi
  extension. The package is **skill-agnostic** — install it on its own
  and write workflows over your own `~/.pi/agent/skills/`, or pair with
  `@juicesharp/rpiv-pi` to use the bundled `mid`, `large`, `small`
  workflows over rpiv-pi's skills.
- `/wf` slash command — preview workflows (no-args), preview one workflow
  (`/wf <name>`), or run one (`/wf <name> <input>`).
- Layered jiti loader with canonical + drop-in convention:
  `~/.config/rpiv-workflow/workflows.config.ts` + `workflows/*.ts`;
  `<cwd>/.rpiv-workflow/workflows.config.ts` + `workflows/*.ts`.
- Programmatic API: `registerBuiltIns(workflows)` for sibling packages
  that want to contribute workflows at load time.

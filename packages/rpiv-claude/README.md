# RPIV for Claude Code

RPIV is a powerful, agent-orchestrated development workflow ported from the Pi Agent ecosystem. It decomposes complex tasks into structured phases: **Discover → Research → Design → Plan → Implement → Validate**.

## Installation

```bash
# From within your project repository
claude plugin install /path/to/rpiv-claude
```

## Core Workflow

RPIV provides a set of "Skills" that you can invoke to guide the agent through a robust engineering process.

1.  **`/skill:discover`**: Interview the agent to extract requirements and intent. Produces a Feature Requirements Document (FRD).
2.  **`/skill:research`**: Analyze the codebase to understand patterns and integration points. Produces a Research Document.
3.  **`/skill:design`**: Draft the architectural changes. Produces a Design Document with file-level code fences.
4.  **`/skill:plan`**: Break the design into actionable, verified phases. Produces an Implementation Plan.
5.  **`/skill:implement`**: Execute the plan phase-by-phase with automated verification.
6.  **`/skill:validate`**: Perform a post-implementation audit to ensure everything works as planned.

## Features

- **Parallel Agents**: Skills like `research` and `code-review` spawn specialized sub-agents (e.g., `codebase-analyzer`, `scope-tracer`) to work in parallel.
- **Context Compaction**: Automated creation of handoff documents (`/skill:create-handoff`) to keep long sessions efficient.
- **Guidance System**: Injects project-specific architectural rules into the agent's context.

## Support Skills

- `/skill:code-review`: Comprehensive review of branches or PRs.
- `/skill:pr-triage`: Security and convention audit for incoming PRs.
- `/skill:changelog`: Idempotent regeneration of `CHANGELOG.md` based on commits.
- `/skill:create-handoff`: Save session state for later resumption.
- `/skill:resume-handoff`: Pick up exactly where a previous session left off.

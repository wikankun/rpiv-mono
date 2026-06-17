# RPIV for oh-my-pi (omp)

RPIV is a powerful, agent-orchestrated development workflow for the `omp` agent framework. It brings the full RPIV pipeline (Discover → Research → Design → Plan → Implement → Validate) to your terminal.

## Installation

```bash
# Install as a plugin
omp plugin install /path/to/rpiv-omp
```

## How it Works

RPIV adds new skills and agents to your `omp` environment. It uses specialized sub-agents for deep codebase analysis and parallelized research.

### Key Skills

| Command | Purpose |
| :--- | :--- |
| `/discover` | Capture requirements via interactive interview. |
| `/research` | Deep-dive into code paths and precedents. |
| `/design` | Specify architectural changes and code fences. |
| `/plan` | Create a phased, checklisted implementation plan. |
| `/implement` | Execute the plan with automated test runs. |
| `/validate` | Audit the final implementation against the plan. |

### Specialized Agents

RPIV includes 15+ specialized agents that work behind the scenes:
- `codebase-analyzer`: Traces implementation details and data flow.
- `scope-tracer`: Maps the boundaries of an investigation.
- `diff-auditor`: Evidence-only patch verification.
- `integration-scanner`: Maps inbound and outbound dependencies.

## Key Fixes & Compatibility

- **OMP Native**: Built specifically for the `omp` plugin loader (fixes `pi/omp` manifest issues).
- **Advisor Support**: Automatically routes high-level judgments to the `slow` model tier.
- **Auto-Discovery**: Compatible with existing `.claude` or `.rpiv` guidance files.

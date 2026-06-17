# Architecture Review

You are tasked with performing an architectural review of proposed changes or existing code. Your goal is to identify divergences from established patterns, violations of architectural boundaries, and opportunities for better alignment with the project's design principles.

## Input

`$ARGUMENTS` — target files or a path to a unified diff/patch.

## Steps

1. **Read Guidance**:
   - Locate and read `architecture.md` or `CLAUDE.md` files relevant to the target files.
   - Use the Read tool for full file contents.

2. **Analyze Alignment**:
   - Compare the proposed changes or existing code against the patterns documented in the guidance.
   - Spawn `codebase-analyzer` and `codebase-pattern-finder` to find canonical examples if guidance is thin.

3. **Identify Divergences**:
   - Note specific file:line locations where code diverges from the established pattern.
   - Look for: naming convention violations, boundary crossing (e.g. UI calling DB directly), missing error handling patterns, incorrect dependency usage.

4. **Emit Review Table**:
   - Use the structured review table format: `| location | severity | finding | recommendation |`.
   - Severities: `blocker` (architectural violation), `concern` (divergence), `suggestion` (alignment improvement).

5. **Synthesize Insight**:
   - Provide a brief summary of the overall architectural fit.

## Guidelines

- Focus on **how** the code integrates, not just its logic.
- Cite the canonical patterns you are comparing against.
- Be objective and adversarial.

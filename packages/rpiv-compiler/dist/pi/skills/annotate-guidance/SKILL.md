---
name: annotate-guidance
description: Generate architecture.md guidance files under .rpiv/guidance/ that document a project's architecture and patterns for AI assistants, written to a shadow tree alongside the source. Use when the user wants to onboard Claude, Cursor, or an AI agent to a codebase via the guidance system, document architecture, or asks to "annotate guidance". Prefer this over annotate-inline when the project uses the .rpiv/guidance/ shadow tree instead of inline CLAUDE.md files.
---

# Annotate Guidance

You are tasked with generating architecture guidance files for a brownfield project. You will map the project structure, auto-detect its architecture, analyze each architectural layer, and batch-write compact architecture.md files under `.rpiv/guidance/` mirroring the project's directory structure.

## Input

`$ARGUMENTS` — optional target directory. Defaults to the current working directory.

## Steps to follow:

1. **Read any directly mentioned files first:**
   - If the user mentions specific files (existing architecture.md, CLAUDE.md, architecture docs, READMEs), read them FULLY first
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
   - **CRITICAL**: Read these files yourself in the main context before invoking any skills
   - This ensures you have full context before decomposing the work

2. **Pass 1 — Map the project (parallel agents):**
   - Spawn the following agents in parallel using the Agent tool:

   **Agent A — Project tree mapping:**
   Agent({ subagent_type: "codebase-locator", description: "analyze codebase-locator", prompt: "$PROMPT" })
   - Prompt: "Map the full project tree structure for {target directory}. List all directories and their contents, respecting .gitignore. Focus on source code directories, configuration files, and build artifacts. Return a complete tree view."

   **Agent B — Architecture and conventions:**
   Agent({ subagent_type: "codebase-locator", description: "analyze codebase-locator", prompt: "$PROMPT" })
   - Prompt: "Identify the architectural layout of {target directory} from path shape and manifest files — NO content analysis. Detect: (1) Architecture pattern inferred from folder shape — clean-arch via Domain/Application/Infrastructure dirs; MVC via Controllers/Models/Views; monorepo via packages/* + workspaces; microservices via services/* with individual manifests; hexagonal via ports/adapters. (2) Main layers/modules — top-level source directories + their names. (3) Frameworks and languages from manifest files (package.json dependencies, *.csproj TargetFramework, pyproject.toml, go.mod, Cargo.toml) and file extensions. (4) Build system from build-config filenames (vite/webpack/tsup/esbuild configs, Makefile, nx.json, turbo.json, dotnet .sln). For each main layer/module, check sub-directory composition. If sub-directories with distinct names/roles exist, flag each as a guidance target candidate with: (a) path, (b) role inferred from folder name (controllers/, services/, entities/, components/, stores/, etc.), (c) file count via ls, (d) how its sub-directory composition differs from sibling layers. Use grep/find/ls only. Do not read file contents. Pass 2 runs codebase-analyzer + codebase-pattern-finder per target folder for deep analysis."

   - While agents run, read .gitignore yourself to understand exclusion rules

3. **Wait for Pass 1 and determine guidance targets:**
   - IMPORTANT: Wait for ALL agents from Pass 1 to complete before proceeding
   - Synthesize the tree structure and architecture findings
   - Auto-detect the architecture pattern (clean architecture, MVC, monorepo, microservices, etc.)
   - Determine guidance targets using a two-pass process:

     **Initial pass — identify top-level targets:**
     - Apply the Guidance Depth Rules (see below) to top-level architectural layers
     - This produces the initial target list (one per distinct layer/project)

     **Decomposition pass — expand composite targets (ADD, never REPLACE):**
     - For EACH initial target, review Agent B's sub-layer candidates
     - If Agent B flagged sub-layers with distinct roles and file counts >10, ADD them as separate guidance targets alongside the parent — the parent stays in the list as an overview, sub-layers are added beneath it
     - NEVER remove the parent when promoting sub-layers — decomposition expands the target list, it does not substitute entries
     - Do NOT apply a blanket "sub-folders same as parent" skip — evaluate each sub-layer Agent B flagged individually against the Depth Rules
     - Common decompositions: Angular/React/Vue apps → components/, services/, shared/; monorepo packages → per-package; large shared libraries → per-concern

   - Present the proposed guidance locations to the user:
     ```
     ## Proposed Guidance Locations

     Architecture detected: {pattern name}

     Files will be written to `.rpiv/guidance/` mirroring the project structure.

     ### Folders that need architectural guidance:
     - `/` (root) — Project overview (compact)
     - `src/core/` — Core domain layer
     - `src/services/` — Service layer
     - {etc.}

     ### Folders to skip:
     - `src/core/entities/` — Entity grouping, same pattern as parent
     - {etc.}

     Does this look right? Should I add or remove any locations?
     ```
   - Use the ask_user_question tool with the following question: "{N} guidance targets across {M} layers. Proceed with analysis?". Options: "Proceed (Recommended)" (Analyze all proposed folders and write architecture.md files); "Add folders" (I want to add more folders to the target list); "Remove folders" (Some proposed folders should be skipped).
   - Adjust the target list based on user feedback

4. **Pass 2 — Analyze each layer (parallel analyzer agents):**
   - For each confirmed target folder, spawn agents in parallel using the Agent tool:

   **For each target folder, spawn TWO agents:**

   **Analyzer agent:**
   Agent({ subagent_type: "codebase-analyzer", description: "analyze codebase-analyzer", prompt: "$PROMPT" })
   - Prompt: "Analyze {folder path} in detail. Determine: 1) What is this layer's responsibility? 2) What are its dependencies (what does it import/use)? 3) Who consumes it (what imports/uses it)? 4) What are the key architectural boundaries and constraints? 5) What is the module structure — list DIRECTORIES with their roles, base types, and naming conventions. Use architectural annotations (e.g., 'one repo per entity', 'one controller per resource') instead of listing individual filenames. The structure should remain valid when non-architectural files are added. 6) What naming conventions are used (prefixes, suffixes, base classes)?"

   **Pattern finder agent:**
   Agent({ subagent_type: "codebase-pattern-finder", description: "analyze codebase-pattern-finder", prompt: "$PROMPT" })
   - Prompt: "Find all distinct code patterns used in {folder path}. For each pattern found: 1) Name the pattern with a descriptive heading (e.g., 'Repository Boundary (CRITICAL: Plain Types, NOT Result<T>)'). 2) Provide an IDIOMATIC code example — a generalized, representative version that shows the pattern's essential shape (constructor, key method signatures, return types, error handling). Do NOT copy-paste a single file verbatim; instead synthesize the typical usage across the layer. 3) Add inline comments highlighting important conventions (e.g., '// DB int → boolean', '// throws on error — service wraps in Result'). 4) If the pattern involves a boundary between layers, show both sides. 5) Identify any repeatable workflows for adding new elements to this layer — backend entities (repositories, services, controllers) AND frontend elements (components, services, pages/routes, directives). For example: creating a new repository requires extending BaseRepository + registering in factory; adding a new Angular component requires extending BaseComponent + adding to routes + creating the template. Return these as step-by-step checklists. Return patterns with file:line references to real examples."

5. **Wait for Pass 2 and write architecture.md files:**
   - IMPORTANT: Wait for ALL agents from Pass 2 to complete before proceeding
   - Synthesize the analysis and patterns for each folder into a compact architecture.md file
   - Use the template in `## Guidance Template` below
   - Use the Write tool to write each file to `.rpiv/guidance/{folder path}/architecture.md` (root folder writes to `.rpiv/guidance/architecture.md`)
   - Ensure the directory structure under `.rpiv/guidance/` is created if it doesn't exist

6. **Summary and developer checkpoint:**
   - After all files are written, present a summary of the generated guidance
   - List the files created and their primary architectural focus
   - Ask if the developer wants to review any specific files or make adjustments

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

## Guidance Depth Rules

Apply these rules to determine if a folder needs its own `architecture.md`:

- **ROOT**: Always gets a root `architecture.md` (Project overview).
- **ARCHITECTURAL BOUNDARY**: If a folder represents a distinct architectural layer (Domain, Application, Infrastructure, UI, API), it needs guidance.
- **MODULE/PACKAGE**: In a monorepo or modular monolith, each main module or package needs its own guidance.
- **COMPOSITE ROLE**: If a folder's children have distinct roles (e.g., a `src/` containing `components/`, `services/`, `store/`), guidance should be applied to the child folders if they are large (>10 files) or complex.
- **SKELETON FOLDERS**: Skip folders that only contain sub-folders but no code files of their own (unless they represent a key layer boundary).
- **LEAF FOLDERS**: Skip folders that represent the "same pattern" as their parent (e.g., `src/core/entities/` doesn't need its own guidance if `src/core/` already describes the entity pattern and `entities/` just contains the files).

## Guidance Template

```markdown
# {Folder Path} — {Role Name}

{2-3 sentence summary of responsibility and architectural role}

## Key Patterns

### {Pattern Name} (from {file:line})
{General description of the pattern's role}

\`\`\`{language}
{Generalized, idiomatic code example}
\`\`\`

- **Convention**: {Specific naming, error handling, or implementation rule}
- **Boundary**: {How it interacts with neighboring layers}

{Repeat for other patterns...}

## Module Structure

- **{subdir}/ ( {Role} )**: {Description of responsibility}
  - **Base Type**: {Base class or interface}
  - **Naming**: {Suffix/prefix convention}

{Repeat for other subdirectories...}

## Workflows

### Adding a new {Element}
- [ ] {Step 1}
- [ ] {Step 2}
...
```

## Important Guidelines

- **Analysis only**: This skill documents existing architecture. It does not propose changes or refactorings.
- **Parallelism is key**: Use parallel agents for mapping (Step 2) and analysis (Step 4) to maximize performance.
- **Synthesize, don't copy**: `codebase-pattern-finder` output should be synthesized into generalized examples, not verbatim copies of single files.
- **Compactness matters**: Keep `architecture.md` files focused on patterns, boundaries, and conventions. Avoid exhaustive lists of files.
- **No frontmatter**: architecture.md files are pure markdown, no YAML frontmatter
- Keep the main agent focused on synthesis, not deep file reading — delegate analysis to sub-agents

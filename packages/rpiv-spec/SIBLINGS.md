# Sibling Plugin Behaviors (Prompt Level)

- **rpiv-args**: Expands `$1`, `$2`, and `$ARGUMENTS` placeholders in skill prompts. Allows skills to be invoked with positional or free-text arguments that are injected into the final assistant message.
- **rpiv-ask-user-question**: Provides the `ask_user_question` tool. Instead of the model guessing or asking open-ended questions, it can present a structured UI (headers, multi-choice options) to the user. Results are returned as the chosen option string or "Other" with free-text.
- **rpiv-todo**: Manages a `.rpiv/artifacts/todo.json` task list. Renders a persistent overlay in the TUI so the user (and model) can see current progress across session restarts and compactions.
- **rpiv-advisor**: Provides an `advisor` tool for "judgment escalation". It forwards the current conversation context to a stronger model (defined in `advisor.json`) to get high-level guidance or a review before the executor agent proceeds with a complex change.
- **rpiv-web-tools**: Implements `web_search` (Google/Bing/etc.) and `web_fetch` (markdown-focused page retrieval). Used by agents to ground research in external documentation or current technical state.
- **rpiv-workflow**: Orchestrates multi-stage pipelines via the `/wf` command. Each stage is a skill with defined inputs/outputs. It manages state persistence and routing between stages (e.g., `research` -> `design` -> `plan`).
- **rpiv-btw**: Implements a "By The Way" side-conversation pattern. Allows the agent to spawn a lightweight sub-thread for a quick question or clarification without "polluting" the main task context's history too much.
- **rpiv-warp**: Wires session events into Warp terminal notifications. Useful for long-running agents to alert the user when a stage completes or input is needed.

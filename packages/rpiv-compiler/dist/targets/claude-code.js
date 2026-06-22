export const claudeCodeMapping = {
    skills: {
        dispatch: (id) => `@${id}`,
        tool: (id) => {
            const toolMap = {
                web_search: "google_web_search",
                web_fetch: "web_fetch",
                todo_write: "write_todos",
                ask_user: "ask_user",
                advisor: "advisor()", // Claude Code doesn't have advisor() yet, leaving as macro-expanded tool call
            };
            return toolMap[id] || id;
        },
    },
    agents: {
        dispatch: (id) => `@${id}`,
        tool: (id) => id,
    },
};

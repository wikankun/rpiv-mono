export const piMapping = {
    skills: {
        dispatch: (id) => `Agent({ subagent_type: "${id}", description: "analyze ${id}", prompt: "$PROMPT" })`,
        tool: (id) => {
            const toolMap = {
                web_search: 'web_search',
                web_fetch: 'web_fetch',
                todo_write: 'todo_write',
                ask_user: 'ask_user_question',
                advisor: 'advisor()'
            };
            return toolMap[id] || id;
        }
    },
    agents: {
        dispatch: (id) => `{{dispatch:${id}}}`, // Agents usually don't dispatch in Pi
        tool: (id) => id
    }
};

import type { TargetMapping } from "./types.js";

export const ompMapping: TargetMapping = {
	skills: {
		dispatch: (id) => `@${id}`, // omp uses the same @agent syntax or Agent() tool
		tool: (id) => {
			const toolMap: Record<string, string> = {
				web_search: "web_search",
				web_fetch: "web_fetch",
				todo_write: "todo_write",
				ask_user: "ask_user",
				advisor: "advisor()", // maps to 'slow' role in models.json
			};
			return toolMap[id] || id;
		},
	},
	agents: {
		dispatch: (id) => `@${id}`,
		tool: (id) => id,
	},
};

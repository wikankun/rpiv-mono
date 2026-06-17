export type Target = "claude-code" | "pi" | "omp" | "opencode" | "gemini" | "codex";

export interface MacroMapping {
	dispatch: (id: string) => string;
	tool: (id: string) => string;
}

export interface TargetMapping {
	skills: MacroMapping;
	agents: MacroMapping;
}

import { describe, expect, it } from "vitest";
import { claudeCodeMapping } from "./claude-code.js";

describe("claudeCodeMapping", () => {
	it("maps dispatches correctly for skills", () => {
		expect(claudeCodeMapping.skills.dispatch("test-agent")).toBe("@test-agent");
	});

	it("maps known tools correctly for skills", () => {
		expect(claudeCodeMapping.skills.tool("web_search")).toBe("google_web_search");
		expect(claudeCodeMapping.skills.tool("todo_write")).toBe("write_todos");
		expect(claudeCodeMapping.skills.tool("advisor")).toBe("advisor()");
	});

	it("returns identity for unknown tools", () => {
		expect(claudeCodeMapping.skills.tool("unknown_tool")).toBe("unknown_tool");
	});

	it("maps dispatches correctly for agents", () => {
		expect(claudeCodeMapping.agents.dispatch("sub-agent")).toBe("@sub-agent");
	});

	it("returns identity for agent tools", () => {
		expect(claudeCodeMapping.agents.tool("web_search")).toBe("web_search");
	});
});

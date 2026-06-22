import { describe, expect, it } from "vitest";
import { ompMapping } from "./omp.js";

describe("ompMapping", () => {
	it("maps dispatches correctly for skills", () => {
		expect(ompMapping.skills.dispatch("test-agent")).toBe("@test-agent");
	});

	it("maps known tools correctly for skills", () => {
		expect(ompMapping.skills.tool("web_search")).toBe("web_search");
		expect(ompMapping.skills.tool("todo_write")).toBe("todo_write");
		expect(ompMapping.skills.tool("advisor")).toBe("advisor()");
	});

	it("returns identity for unknown tools", () => {
		expect(ompMapping.skills.tool("unknown_tool")).toBe("unknown_tool");
	});

	it("maps dispatches correctly for agents", () => {
		expect(ompMapping.agents.dispatch("sub-agent")).toBe("@sub-agent");
	});

	it("returns identity for agent tools", () => {
		expect(ompMapping.agents.tool("web_search")).toBe("web_search");
	});
});

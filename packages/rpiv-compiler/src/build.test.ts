import fs from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import yaml from "yaml";
import { build } from "./build.js";

describe("build", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called");
		}) as any);

		vi.spyOn(fs, "readdirSync");
		vi.spyOn(fs, "readFileSync");
		vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined as any);
		vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
		vi.spyOn(yaml, "parse");
	});

	it("exits with error for unknown target", () => {
		expect(() => build("unknown", "out")).toThrow("process.exit called");
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not implemented or unknown"));
	});

	it("builds for claude-code target successfully", () => {
		vi.mocked(fs.readdirSync).mockImplementation((dir) => {
			if (dir.toString().includes("agents")) return ["test.agent.yaml"] as any;
			if (dir.toString().includes("skills")) return ["test.skill.yaml"] as any;
			return [];
		});

		vi.mocked(yaml.parse).mockImplementation(() => ({
			id: "test-id",
			description: "test description",
			prompt: "prompt.md",
			body: "body.md",
		}));

		vi.mocked(fs.readFileSync).mockReturnValue("content with {{dispatch:sub}} and {{tool:ask_user}}");
		vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);

		build("claude-code", "out");

		expect(fs.writeFileSync).toHaveBeenCalled();

		// Should have created marketplace.json
		const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
		const createdFiles = writeCalls.map((call) => call[0].toString());
		expect(createdFiles.some((f) => f.includes("marketplace.json"))).toBe(true);
		expect(createdFiles.some((f) => f.includes("plugin.json"))).toBe(true);
		expect(createdFiles.some((f) => f.includes("SKILL.md"))).toBe(true);

		// Check that macros were expanded
		const skillWrite = writeCalls.find((call) => call[0].toString().includes("SKILL.md"));
		expect(skillWrite![1].toString()).toContain("@sub");
		expect(skillWrite![1].toString()).toContain("ask_user");
	});

	it("builds for omp target successfully", () => {
		vi.mocked(fs.readdirSync).mockImplementation((dir) => {
			if (dir.toString().includes("agents")) return ["test.agent.yaml"] as any;
			if (dir.toString().includes("skills")) return ["test.skill.yaml"] as any;
			return [];
		});

		vi.mocked(yaml.parse).mockImplementation(() => ({
			id: "test-id",
			description: "test description",
			prompt: "prompt.md",
			body: "body.md",
		}));

		vi.mocked(fs.readFileSync).mockReturnValue("content with {{dispatch:sub}} and {{tool:advisor}}");
		vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);

		build("omp", "out");

		expect(fs.writeFileSync).toHaveBeenCalled();

		const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
		const skillWrite = writeCalls.find((call) => call[0].toString().includes("SKILL.md"));
		expect(skillWrite![1].toString()).toContain("@sub");
		expect(skillWrite![1].toString()).toContain("advisor()");
	});
});

import fs from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import yaml from "yaml";
import { validate } from "./validate.js";
describe("validate", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.spyOn(console, "log").mockImplementation(() => { });
        vi.spyOn(console, "error").mockImplementation(() => { });
        // Mock process.exit to throw instead of actually exiting tests
        vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called");
        }));
        vi.spyOn(fs, "readdirSync");
        vi.spyOn(fs, "readFileSync");
        vi.spyOn(yaml, "parse");
    });
    it("passes when all dispatched agents exist", () => {
        vi.mocked(fs.readdirSync).mockImplementation((dir) => {
            if (dir.toString().includes("agents"))
                return ["test-agent.agent.yaml"];
            if (dir.toString().includes("skills"))
                return ["test-skill.skill.yaml"];
            return [];
        });
        vi.mocked(fs.readFileSync).mockReturnValue("mock content");
        vi.mocked(yaml.parse).mockImplementation((content) => {
            if (content === "mock content") {
                // Called twice: once for agent, once for skill
                // We can just return the same shape or differentiate based on calls
                // Let's rely on call order or mock differently
                return { id: "test-agent", body: "body.md" };
            }
            return {};
        });
        // Mock the body content for the skill
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString().endsWith("body.md")) {
                return "Here is a dispatch {{dispatch:test-agent}} inside the body.";
            }
            return "mock content";
        });
        expect(() => validate()).not.toThrow();
        expect(console.log).toHaveBeenCalledWith("✅ Macro validation passed.");
    });
    it("fails and exits when an unknown agent is dispatched", () => {
        vi.mocked(fs.readdirSync).mockImplementation((dir) => {
            if (dir.toString().includes("agents"))
                return ["test-agent.agent.yaml"];
            if (dir.toString().includes("skills"))
                return ["test-skill.skill.yaml"];
            return [];
        });
        vi.mocked(yaml.parse).mockImplementation(() => {
            return { id: "test-agent", body: "body.md" };
        });
        // Mock the body content for the skill containing an invalid dispatch
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString().endsWith("body.md")) {
                return "Here is a dispatch {{dispatch:unknown-agent}} inside the body.";
            }
            return "mock content";
        });
        expect(() => validate()).toThrow("process.exit called");
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("dispatches unknown agent: unknown-agent"));
    });
});

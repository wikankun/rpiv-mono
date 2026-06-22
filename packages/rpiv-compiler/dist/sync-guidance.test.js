import fs from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncGuidance } from "./sync-guidance.js";
describe("syncGuidance", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        // Avoid console.log clutter in tests
        vi.spyOn(console, "log").mockImplementation(() => { });
        vi.spyOn(console, "warn").mockImplementation(() => { });
        vi.spyOn(fs, "existsSync");
        vi.spyOn(fs, "readdirSync");
        vi.spyOn(fs, "readFileSync");
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    });
    it("returns early if guidance source directory does not exist", () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        syncGuidance(".", "CLAUDE.md");
        expect(fs.readdirSync).not.toHaveBeenCalled();
    });
    it("returns early if no markdown files are in guidance source directory", () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readdirSync).mockReturnValue([]);
        syncGuidance(".", "CLAUDE.md");
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });
    it("injects new guidance block into target file", () => {
        vi.mocked(fs.existsSync).mockImplementation((_p) => true);
        vi.mocked(fs.readdirSync).mockReturnValue(["test.md"]);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString().endsWith("test.md")) {
                return "Test guidance content";
            }
            return "Original file content";
        });
        syncGuidance(".", "CLAUDE.md");
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
        expect(callArgs[1]).toContain("Original file content");
        expect(callArgs[1]).toContain("<!-- BEGIN RPIV GUIDANCE -->");
        expect(callArgs[1]).toContain("### test.md");
        expect(callArgs[1]).toContain("Test guidance content");
        expect(callArgs[1]).toContain("<!-- END RPIV GUIDANCE -->");
    });
    it("replaces existing guidance block if present", () => {
        vi.mocked(fs.existsSync).mockImplementation(() => true);
        vi.mocked(fs.readdirSync).mockReturnValue(["test.md"]);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString().endsWith("test.md")) {
                return "New guidance content";
            }
            return "Header\n<!-- BEGIN RPIV GUIDANCE -->\nOld content\n<!-- END RPIV GUIDANCE -->\nFooter";
        });
        syncGuidance(".", "CLAUDE.md");
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
        const content = callArgs[1];
        expect(content).toContain("Header\n<!-- BEGIN RPIV GUIDANCE -->");
        expect(content).toContain("New guidance content");
        expect(content).not.toContain("Old content");
        expect(content).toContain("Footer");
    });
});

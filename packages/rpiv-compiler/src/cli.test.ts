import { describe, expect, it, vi } from "vitest";

const mockParse = vi.fn();

vi.mock("commander", () => {
	class Command {
		name() {
			return this;
		}
		description() {
			return this;
		}
		version() {
			return this;
		}
		command() {
			return this;
		}
		requiredOption() {
			return this;
		}
		action() {
			return this;
		}
		parse() {
			mockParse();
		}
	}
	return { Command };
});

vi.mock("./build.js", () => ({ build: vi.fn() }));
vi.mock("./sync-guidance.js", () => ({ syncGuidance: vi.fn() }));
vi.mock("./validate.js", () => ({ validate: vi.fn() }));

describe("cli", () => {
	it("initializes commander and parses arguments", async () => {
		// Dynamically import cli so that mocks take effect before execution
		await import("./cli.js");

		expect(mockParse).toHaveBeenCalled();
	});
});

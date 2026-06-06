/**
 * Tests for the skill-contracts-source module: frontmatter → contract builder
 * and the guarded sibling registration.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSkillContractsFromFrontmatter } from "./skill-contracts-source.js";

/** Create a temp dir with skill subdirs; caller must rmSync when done. */
function makeSkillsDir(baseDir: string, skills: Record<string, string /* SKILL.md content */>): string {
	for (const [name, content] of Object.entries(skills)) {
		const skillDir = join(baseDir, name);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), content);
	}
	return baseDir;
}

describe("buildSkillContractsFromFrontmatter", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = "" as string;
		}
	});

	it("returns [] for a skills dir whose SKILL.md files carry no contract: block", () => {
		tmpDir = join(process.env.HOME!, `test-skills-no-contract-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			research: `---\ndescription: Research skill\n---\nBody here`,
			plan: `---\ndescription: Plan skill\n---\nBody here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toEqual([]);
	});

	it("returns [name, {source:'declared', ...}] for a skill with a contract: block", () => {
		tmpDir = join(process.env.HOME!, `test-skills-with-contract-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			research: `---
description: Research skill
contract:
  produces:
    kind: produces
    data:
      type: object
      properties:
        findings:
          type: string
    meta:
      artifactKind: research
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0][0]).toBe("research");
		expect(result[0][1]).toEqual({
			source: "declared",
			produces: {
				kind: "produces",
				data: { type: "object", properties: { findings: { type: "string" } } },
				meta: { artifactKind: "research" },
			},
		});
	});

	it("returns [] for a nonexistent skills dir", () => {
		const result = buildSkillContractsFromFrontmatter(
			`/nonexistent/path/skills-${Math.random().toString(36).slice(2)}`,
		);
		expect(result).toEqual([]);
	});

	it("defaults produces.kind to 'produces' when omitted in frontmatter", () => {
		tmpDir = join(process.env.HOME!, `test-skills-default-kind-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			mySkill: `---
description: My skill
contract:
  produces:
    data:
      type: object
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0][1].produces?.kind).toBe("produces");
	});

	it("carries a consumes block through, per-field, into the contract", () => {
		tmpDir = join(process.env.HOME!, `test-skills-consumes-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			design: `---
description: Design skill
contract:
  consumes:
    data:
      type: object
      properties:
        findings:
          type: string
    reads:
      research: {}
    meta:
      artifactKind: research
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0][0]).toBe("design");
		expect(result[0][1]).toEqual({
			source: "declared",
			consumes: {
				data: { type: "object", properties: { findings: { type: "string" } } },
				reads: { research: {} },
				meta: { artifactKind: "research" },
			},
		});
	});

	it("skips non-object consumes sub-fields without crashing", () => {
		tmpDir = join(process.env.HOME!, `test-skills-bad-consumes-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			design: `---
description: Design skill
contract:
  consumes:
    data: "not-an-object"
    meta:
      artifactKind: research
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		// data (a string) is dropped; the valid meta still carries through.
		expect(result[0][1].consumes).toEqual({ meta: { artifactKind: "research" } });
	});

	it("skips non-object produces.data without crashing", () => {
		tmpDir = join(process.env.HOME!, `test-skills-bad-data-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			mySkill: `---
description: My skill
contract:
  produces:
    kind: produces
    data: "not-an-object"
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		// data should be omitted since it's a string, not an object
		expect(result[0][1].produces?.data).toBeUndefined();
	});
});

describe("registerSkillContractsSource", () => {
	describe("when the rpiv-workflow sibling is absent", () => {
		afterEach(() => {
			vi.doUnmock("@juicesharp/rpiv-workflow/startup");
			vi.resetModules();
		});

		it("no-ops without throwing", async () => {
			vi.resetModules();
			vi.doMock("@juicesharp/rpiv-workflow/startup", () => {
				throw Object.assign(new Error("Cannot find package '@juicesharp/rpiv-workflow'"), {
					code: "ERR_MODULE_NOT_FOUND",
				});
			});

			const fresh = await import("./skill-contracts-source.js");
			await expect(fresh.registerSkillContractsSource()).resolves.toBeUndefined();
		});
	});
});

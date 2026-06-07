/**
 * Tests for the skill-contracts-source module: frontmatter → contract builder
 * and the guarded sibling registration.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harvestStageContracts } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInWorkflows } from "./built-in-workflows.js";
import { BUNDLED_SKILLS_DIR } from "./paths.js";
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

describe("bundled skill contracts (Phase 2 annotation)", () => {
	// The 12 pipeline skills carry a contract: block. This is the count the /wf
	// banner reports as "N declared" — a drift guard if a block is added,
	// dropped, or fails to parse (a malformed block is silently skipped).
	const declared = new Map(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR));

	it("declares a contract for the 12 pipeline skills", () => {
		expect(declared.size).toBe(12);
		for (const name of [
			"discover",
			"research",
			"explore",
			"design",
			"plan",
			"blueprint",
			"architecture-review",
			"code-review",
			"validate",
			"revise",
			"implement",
			"commit",
		]) {
			expect(declared.has(name)).toBe(true);
		}
	});

	it("blueprint declares phases as a required produces.data field (derived from the body headings)", () => {
		const data = declared.get("blueprint")?.produces?.data as
			| { required?: string[]; properties?: { phases?: unknown } }
			| undefined;
		expect(data?.required).toContain("phases");
		expect(data?.properties?.phases).toBeDefined();
	});

	it("architecture-review declares phases as a required produces.data field (derived from the body headings)", () => {
		const data = declared.get("architecture-review")?.produces?.data as
			| { required?: string[]; properties?: { phases?: unknown } }
			| undefined;
		expect(data?.required).toContain("phases");
		expect(data?.properties?.phases).toBeDefined();
	});

	it("every declared kind matches the harvested kind for the five built-in workflows", () => {
		// Harvest derives each dispatched skill's kind from how the built-ins use
		// it (produces() → "produces", acts() → "side-effect"). A declared kind
		// that disagrees would make the rendered graph lie — catch it here.
		const harvested = harvestStageContracts(builtInWorkflows);
		expect(harvested.size).toBeGreaterThan(0);
		for (const [skill, h] of harvested) {
			const d = declared.get(skill);
			expect(d, `skill "${skill}" is dispatched by a built-in but declares no contract`).toBeDefined();
			expect(d?.produces?.kind, `kind drift for "${skill}"`).toBe(h.produces?.kind);
		}
	});

	it("side-effect skills (implement, commit) declare no produces.data", () => {
		// kind: side-effect means the skill describes itself via meta/reads, not
		// an adjudicated data channel (parent §1: side-effects fill meta, not data).
		expect(declared.get("implement")?.produces?.kind).toBe("side-effect");
		expect(declared.get("implement")?.produces?.data).toBeUndefined();
		expect(declared.get("commit")?.produces?.kind).toBe("side-effect");
		expect(declared.get("commit")?.produces?.data).toBeUndefined();
	});

	// §4 coherence — the drift that bit us at RUNTIME (a validate artifact wrote
	// `status: complete`, which the contract enum rejected). Catch it at build
	// time instead: every enum-constrained `status`/`verdict` value a skill
	// TEMPLATE tells the LLM to write must be a member of the contract enum.
	// A template value is either a literal (`status: ready`) or a placeholder set
	// (`status: {in-progress | ready}`) — every candidate must be in the enum.
	it("each template's status/verdict frontmatter stays within the contract enum", () => {
		const enumOf = (skill: string, field: string): string[] | undefined => {
			const props = (declared.get(skill)?.produces?.data as { properties?: Record<string, { enum?: string[] }> })
				?.properties;
			return props?.[field]?.enum;
		};
		const templateValues = (raw: string, field: string): string[] => {
			const m = raw.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
			if (!m) return [];
			const val = m[1]!.trim();
			const brace = val.match(/^\{(.+)\}$/);
			return brace ? brace[1]!.split("|").map((s) => s.trim()) : [val];
		};
		let templatesChecked = 0;
		for (const skill of declared.keys()) {
			let files: string[];
			try {
				files = readdirSync(join(BUNDLED_SKILLS_DIR, skill, "templates")).filter((f) => f.endsWith(".md"));
			} catch {
				continue; // skill has no templates/ dir — body-only, nothing to cross-check here
			}
			for (const file of files) {
				const raw = readFileSync(join(BUNDLED_SKILLS_DIR, skill, "templates", file), "utf-8");
				for (const field of ["status", "verdict"]) {
					const allowed = enumOf(skill, field);
					if (!allowed) continue;
					for (const value of templateValues(raw, field)) {
						templatesChecked++;
						expect(
							allowed,
							`${skill}/templates/${file}: ${field} "${value}" is not in the contract enum [${allowed.join(", ")}]`,
						).toContain(value);
					}
				}
			}
		}
		// Guard the guard — if this drops to 0 the check silently passes forever.
		expect(templatesChecked).toBeGreaterThan(0);
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

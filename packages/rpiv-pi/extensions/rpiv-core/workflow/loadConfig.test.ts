import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { WORKFLOW_DAG } from "./dag.js";
import { loadConfig, projectConfigPath, readConfigFile, USER_CONFIG_PATH } from "./loadConfig.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Create a temp directory for test configs. */
const TEST_TMP = join(process.env.HOME!, "test-workflow-config");
const TEST_RPIV = join(TEST_TMP, ".rpiv");
/** User-level config dir (~/.config/rpiv) — must be cleaned between tests so
 *  a write from one test doesn't leak into the next. */
const USER_CONFIG_DIR = dirname(USER_CONFIG_PATH);

beforeEach(() => {
	rmSync(TEST_TMP, { recursive: true, force: true });
	rmSync(USER_CONFIG_DIR, { recursive: true, force: true });
	mkdirSync(TEST_RPIV, { recursive: true });
});

// ---------------------------------------------------------------------------
// readConfigFile
// ---------------------------------------------------------------------------

describe("readConfigFile", () => {
	it("returns undefined data for missing file", () => {
		const result = readConfigFile(join(TEST_TMP, "nonexistent.json"));
		expect(result.data).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it("returns parsed data for valid JSON", () => {
		const path = join(TEST_TMP, "valid.json");
		writeFileSync(path, JSON.stringify({ presets: { quick: ["research", "commit"] } }));
		const result = readConfigFile(path);
		expect(result.data).toEqual({ presets: { quick: ["research", "commit"] } });
		expect(result.warning).toBeUndefined();
	});

	it("returns warning for malformed JSON", () => {
		const path = join(TEST_TMP, "bad.json");
		writeFileSync(path, "{ invalid json");
		const result = readConfigFile(path);
		expect(result.data).toBeUndefined();
		expect(result.warning).toContain("Malformed JSON");
	});

	it("returns warning for non-object JSON", () => {
		const path = join(TEST_TMP, "array.json");
		writeFileSync(path, JSON.stringify([1, 2, 3]));
		const result = readConfigFile(path);
		expect(result.data).toBeUndefined();
		expect(result.warning).toContain("not a JSON object");
	});

	it("returns warning for null JSON", () => {
		const path = join(TEST_TMP, "null.json");
		writeFileSync(path, "null");
		const result = readConfigFile(path);
		expect(result.data).toBeUndefined();
		expect(result.warning).toContain("not a JSON object");
	});
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	it("returns WORKFLOW_DAG when no config files exist", () => {
		const result = loadConfig(TEST_TMP);
		expect(result.dag).toBe(WORKFLOW_DAG);
		expect(result.defaultPreset).toBe("mid");
		expect(result.source).toBe("built-in");
		expect(result.warnings).toBeUndefined();
		// presetNames mirrors the effective DAG's preset keys (built-in here).
		expect([...result.presetNames]).toEqual(Object.keys(WORKFLOW_DAG.presets));
	});

	it("layers project presets on top of built-in", () => {
		const config = { presets: { quick: ["research", "commit"] }, defaultPreset: "quick" };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.source).toBe("project");
		expect(result.layers).toEqual(["built-in", "project"]);
		expect(result.defaultPreset).toBe("quick");
		expect(result.dag.presets.quick).toEqual(["research", "commit"]);
		// Built-in presets remain reachable alongside the project's additions.
		expect(result.dag.presets.mid).toEqual(WORKFLOW_DAG.presets.mid);
		expect(result.dag.edges).toEqual(WORKFLOW_DAG.edges);
		expect(result.presetSources.get("quick")).toBe("project");
		expect(result.presetSources.get("mid")).toBe("built-in");
	});

	it("layers user presets on top of built-in when no project config", () => {
		const config = { presets: { myflow: ["discover", "commit"] } };
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(USER_CONFIG_PATH, JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.source).toBe("user");
		expect(result.layers).toEqual(["built-in", "user"]);
		expect(result.dag.presets.myflow).toEqual(["discover", "commit"]);
		expect(result.dag.presets.mid).toEqual(WORKFLOW_DAG.presets.mid);
		expect(result.presetSources.get("myflow")).toBe("user");
	});

	it("falls back to WORKFLOW_DAG on invalid preset skill names", () => {
		const config = { presets: { bad: ["nonexistent-skill", "commit"] } };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.dag).toBe(WORKFLOW_DAG);
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some((w) => w.includes("Config validation"))).toBe(true);
	});

	it("returns warning for malformed project config", () => {
		writeFileSync(projectConfigPath(TEST_TMP), "{ bad json");

		const result = loadConfig(TEST_TMP);
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some((w) => w.includes("Malformed JSON"))).toBe(true);
	});

	it("drops invalid defaultPreset against built-in fallback (no presets in config)", () => {
		// When presets are absent we use the built-in DAG. A defaultPreset that
		// doesn't exist there would silently break every subsequent `/rpiv`
		// call with `Unknown preset: my-flow`; resolveDefaultPreset substitutes
		// "mid" (which is in the built-in DAG) and warns.
		const config = { defaultPreset: "my-flow" };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.defaultPreset).toBe("mid");
		expect(result.dag).toBe(WORKFLOW_DAG);
		expect(result.warnings?.some((w) => w.includes('"my-flow" not found'))).toBe(true);
	});

	it("retains built-in 'mid' as default when no defaultPreset is set", () => {
		// With layered merge, built-in presets stay available — the project's
		// single preset doesn't displace 'mid' as the default.
		const config = { presets: { quick: ["research", "commit"] } };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.defaultPreset).toBe("mid");
	});

	it("falls back to 'mid' when defaultPreset references a missing preset", () => {
		const config = { presets: { quick: ["research", "commit"] }, defaultPreset: "nonexistent" };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		// "mid" is still in the merged presets via the built-in layer.
		expect(result.defaultPreset).toBe("mid");
		expect(result.warnings?.some((w) => w.includes('"nonexistent" not found'))).toBe(true);
	});

	it("rejects non-array preset values with a clear warning (no character-by-character noise)", () => {
		// Without runtime shape validation, validateDag would iterate the string
		// "bad" character-by-character and emit `Invalid preset "x" node: "b"` etc.
		const config = { presets: { x: "bad" }, defaultPreset: "x" };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.dag).toBe(WORKFLOW_DAG);
		expect(result.warnings?.some((w) => w.includes('preset "x" (project) must be an array of strings'))).toBe(true);
		// And critically: no per-character warnings.
		expect(result.warnings?.some((w) => /node: "[a-z]"$/.test(w))).toBeFalsy();
	});

	it("rejects preset arrays containing non-string entries", () => {
		const config = { presets: { x: ["research", 42, "commit"] } };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.dag).toBe(WORKFLOW_DAG);
		expect(result.warnings?.some((w) => w.includes('preset "x" (project) must be an array of strings'))).toBe(true);
	});

	it("resets source to built-in when project config fails validation", () => {
		const config = { presets: { bad: ["nonexistent-skill"] } };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		// Without this fix, source would still say "project" while the DAG is built-in.
		expect(result.source).toBe("built-in");
		expect(result.dag).toBe(WORKFLOW_DAG);
	});
});

// ---------------------------------------------------------------------------
// Layered merge — both overlays present
// ---------------------------------------------------------------------------

describe("loadConfig — layered merge", () => {
	it("merges distinct presets from user and project", () => {
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(USER_CONFIG_PATH, JSON.stringify({ presets: { userflow: ["research", "commit"] } }));
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify({ presets: { projflow: ["discover", "commit"] } }));

		const result = loadConfig(TEST_TMP);
		expect(result.source).toBe("project");
		expect(result.layers).toEqual(["built-in", "user", "project"]);
		expect(result.dag.presets.userflow).toEqual(["research", "commit"]);
		expect(result.dag.presets.projflow).toEqual(["discover", "commit"]);
		expect(result.dag.presets.mid).toEqual(WORKFLOW_DAG.presets.mid);
		expect(result.presetSources.get("userflow")).toBe("user");
		expect(result.presetSources.get("projflow")).toBe("project");
	});

	it("project wins on preset-name collision", () => {
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(USER_CONFIG_PATH, JSON.stringify({ presets: { same: ["discover", "commit"] } }));
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify({ presets: { same: ["research", "commit"] } }));

		const result = loadConfig(TEST_TMP);
		expect(result.dag.presets.same).toEqual(["research", "commit"]);
		expect(result.presetSources.get("same")).toBe("project");
	});

	it("project defaultPreset wins over user defaultPreset", () => {
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(
			USER_CONFIG_PATH,
			JSON.stringify({ presets: { userflow: ["research", "commit"] }, defaultPreset: "userflow" }),
		);
		writeFileSync(
			projectConfigPath(TEST_TMP),
			JSON.stringify({ presets: { projflow: ["discover", "commit"] }, defaultPreset: "projflow" }),
		);

		const result = loadConfig(TEST_TMP);
		expect(result.defaultPreset).toBe("projflow");
	});

	it("user defaultPreset wins when project omits it", () => {
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(
			USER_CONFIG_PATH,
			JSON.stringify({ presets: { userflow: ["research", "commit"] }, defaultPreset: "userflow" }),
		);
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify({ presets: { projflow: ["discover", "commit"] } }));

		const result = loadConfig(TEST_TMP);
		expect(result.defaultPreset).toBe("userflow");
	});

	it("malformed user JSON does not poison project layer", () => {
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(USER_CONFIG_PATH, "{ broken json");
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify({ presets: { projflow: ["research", "commit"] } }));

		const result = loadConfig(TEST_TMP);
		expect(result.source).toBe("project");
		expect(result.dag.presets.projflow).toEqual(["research", "commit"]);
		expect(result.warnings?.some((w) => /Malformed JSON/.test(w))).toBe(true);
	});

	it("layer attribution survives a built-in preset being overridden by project", () => {
		// Project redefines 'mid' — the built-in 'mid' is shadowed; presetSources
		// must reflect the new owner so list output stays honest.
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify({ presets: { mid: ["discover", "commit"] } }));

		const result = loadConfig(TEST_TMP);
		expect(result.dag.presets.mid).toEqual(["discover", "commit"]);
		expect(result.presetSources.get("mid")).toBe("project");
		// 'small' wasn't touched — still built-in.
		expect(result.presetSources.get("small")).toBe("built-in");
	});
});

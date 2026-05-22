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

	it("returns config presets from project-level config", () => {
		const config = { presets: { quick: ["research", "commit"] }, defaultPreset: "quick" };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.source).toBe("project");
		expect(result.defaultPreset).toBe("quick");
		expect(result.dag.presets).toEqual({ quick: ["research", "commit"] });
		expect(result.dag.edges).toEqual(WORKFLOW_DAG.edges);
		// presetNames mirrors the project DAG's preset keys.
		expect([...result.presetNames]).toEqual(["quick"]);
	});

	it("returns config presets from user-level config when no project config", () => {
		const config = { presets: { myflow: ["discover", "commit"] } };
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(USER_CONFIG_PATH, JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.source).toBe("user");
		expect(result.dag.presets).toEqual({ myflow: ["discover", "commit"] });
	});

	it("project config overrides user config", () => {
		// User config
		mkdirSync(join(USER_CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(USER_CONFIG_PATH, JSON.stringify({ presets: { user: ["commit"] } }));

		// Project config
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify({ presets: { project: ["research", "commit"] } }));

		const result = loadConfig(TEST_TMP);
		expect(result.source).toBe("project");
		expect(result.dag.presets).toEqual({ project: ["research", "commit"] });
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

	it("falls back to first preset key when defaultPreset is omitted and 'mid' is missing", () => {
		const config = { presets: { quick: ["research", "commit"] } };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		// "mid" is not in the user presets, so resolveDefaultPreset falls back
		// to the first key ("quick") and emits a warning explaining why.
		expect(result.defaultPreset).toBe("quick");
		expect(result.warnings?.some((w) => w.includes('"mid" not in presets'))).toBe(true);
	});

	it("uses the first preset key when defaultPreset is omitted and 'mid' is missing (multiple presets)", () => {
		const config = { presets: { alpha: ["research", "commit"], beta: ["discover", "commit"] } };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.defaultPreset).toBe("alpha");
	});

	it("falls back to first preset key when defaultPreset references a missing preset", () => {
		const config = { presets: { quick: ["research", "commit"] }, defaultPreset: "nonexistent" };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.defaultPreset).toBe("quick");
		expect(result.warnings?.some((w) => w.includes('"nonexistent" not found'))).toBe(true);
	});

	it("rejects non-array preset values with a clear warning (no character-by-character noise)", () => {
		// Without runtime shape validation, validateDag would iterate the string
		// "bad" character-by-character and emit `Invalid preset "x" node: "b"` etc.
		const config = { presets: { x: "bad" }, defaultPreset: "x" };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.dag).toBe(WORKFLOW_DAG);
		expect(result.warnings?.some((w) => w.includes('preset "x" must be an array of strings'))).toBe(true);
		// And critically: no per-character warnings.
		expect(result.warnings?.some((w) => /node: "[a-z]"$/.test(w))).toBeFalsy();
	});

	it("rejects preset arrays containing non-string entries", () => {
		const config = { presets: { x: ["research", 42, "commit"] } };
		writeFileSync(projectConfigPath(TEST_TMP), JSON.stringify(config));

		const result = loadConfig(TEST_TMP);
		expect(result.dag).toBe(WORKFLOW_DAG);
		expect(result.warnings?.some((w) => w.includes('preset "x" must be an array of strings'))).toBe(true);
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

/**
 * Programmatic skill-contract registry.
 *
 * Mirrors `built-ins.ts` exactly: the framework is skill-agnostic and never
 * reads skill files or parses YAML. Sibling packages (the primary consumer is
 * rpiv-pi) inject already-parsed contracts at extension load via
 * `registerSkillContracts(...)` or, lazily, `registerSkillContractsProvider(...)`
 * — the same provider+flush idiom built-in workflows use. `loadWorkflows` awaits
 * `flushSkillContractProviders()` before reading the registry, so the real `/wf`
 * flow (where `loadWorkflows` runs inside `command-run.ts` with no ctx access)
 * is auto-populated without threading a parameter.
 *
 * The registry is keyed by RESOLVED post-alias skill name (`stage.skill ??
 * recordKey`), identical to `ensureSkillRegistered` — so a stage's contract
 * lookup follows aliasing for free.
 *
 * Anchored on `Symbol.for` global slots: Pi may load this module more than once
 * (once for the rpiv-workflow extension, once via rpiv-pi's cross-package
 * `import { registerSkillContracts }`), and module-local state would silo
 * between copies.
 */

import type { Workflow } from "./api.js";
import { extractJsonSchema, isSchemaCompatible, type SchemaCompatResult } from "./json-schema.js";
import { isDispatchingStage } from "./load/alias.js";
import type { ConsumesSpec, ProducesSpec, SkillContract, SkillContractMap } from "./skill-contract.js";

const REGISTRY_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contracts");
const PROVIDERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-providers");
const FLUSH_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-flush");
const FAILURES_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-failures");
const COLLISIONS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-collisions");
const OWNERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-owners");

/** A lazy contributor of skill contracts — run once by `flushSkillContractProviders`. */
type SkillContractsProvider = () => void | Promise<void>;

type Global = Record<symbol, unknown>;

/**
 * Structural (key-order-independent) deep equality for two contracts. Used by the
 * cross-owner collision check so two SEMANTICALLY-identical contracts built by
 * different code paths (or with different YAML key order) don't read as divergent
 * — `JSON.stringify` is insertion-order dependent and would raise a spurious
 * collision warning. Contracts are plain JSON data (no functions/symbols/Dates),
 * so a recursive value compare is sufficient and total.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aArr = Array.isArray(a);
	const bArr = Array.isArray(b);
	if (aArr !== bArr) return false;
	if (aArr && bArr) {
		if (a.length !== b.length) return false;
		return a.every((x, i) => deepEqual(x, b[i]));
	}
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((k) => Object.hasOwn(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

function getRegistry(): Map<string, SkillContract> {
	const g = globalThis as unknown as Global;
	let registry = g[REGISTRY_KEY] as Map<string, SkillContract> | undefined;
	if (!registry) {
		registry = new Map();
		g[REGISTRY_KEY] = registry;
	}
	return registry;
}

function getProviders(): SkillContractsProvider[] {
	const g = globalThis as unknown as Global;
	let providers = g[PROVIDERS_KEY] as SkillContractsProvider[] | undefined;
	if (!providers) {
		providers = [];
		g[PROVIDERS_KEY] = providers;
	}
	return providers;
}

/** name → owner label of whoever last registered it (for prune-on-reload + collision detection). */
function getOwners(): Map<string, string> {
	const g = globalThis as unknown as Global;
	let owners = g[OWNERS_KEY] as Map<string, string> | undefined;
	if (!owners) {
		owners = new Map();
		g[OWNERS_KEY] = owners;
	}
	return owners;
}

function getCollisions(): string[] {
	const g = globalThis as unknown as Global;
	let collisions = g[COLLISIONS_KEY] as string[] | undefined;
	if (!collisions) {
		collisions = [];
		g[COLLISIONS_KEY] = collisions;
	}
	return collisions;
}

function getFailures(): unknown[] {
	const g = globalThis as unknown as Global;
	let failures = g[FAILURES_KEY] as unknown[] | undefined;
	if (!failures) {
		failures = [];
		g[FAILURES_KEY] = failures;
	}
	return failures;
}

/**
 * Register one or more skill contracts, keyed by RESOLVED skill name — a flat
 * namespace SHARED by all consumers (the key must equal `stage.skill` for lookup,
 * so it can't be per-consumer-prefixed). Idempotent on name (re-register replaces).
 *
 * `owner` (optional consumer label, e.g. `"rpiv-pi"`) makes two real-world cases
 * safe:
 *   - #12 prune-on-reload — an owner's call is treated as its FULL current
 *     snapshot: any name this owner previously registered but didn't include now
 *     (a skill deleted between `/reload`s) is dropped, so stale contracts don't
 *     linger. Other owners' entries are untouched.
 *   - #4 collision surfacing — a DIFFERENT owner overwriting a name with a
 *     DIVERGENT contract is recorded (drained into a `LoadIssue` by
 *     `loadWorkflows`), turning a silent last-writer-wins into a visible warning.
 * Omit `owner` for the simple additive behaviour (no prune, no ownership claim).
 */
export function registerSkillContracts(contracts: Iterable<readonly [string, SkillContract]>, owner?: string): void {
	const registry = getRegistry();
	const owners = getOwners();
	const incoming = [...contracts];
	const incomingNames = new Set(incoming.map(([name]) => name));
	if (owner !== undefined) {
		for (const [name, prevOwner] of [...owners]) {
			if (prevOwner === owner && !incomingNames.has(name)) {
				registry.delete(name); // #12: this owner dropped the skill — drop its contract
				owners.delete(name);
			}
		}
	}
	for (const [name, contract] of incoming) {
		const existing = registry.get(name);
		const prevOwner = owners.get(name);
		if (existing && prevOwner !== owner && !deepEqual(existing, contract)) {
			getCollisions().push(
				`skill "${name}": contract from ${owner ?? "an anonymous registrant"} overrides a divergent one from ${prevOwner ?? "an anonymous registrant"} (last writer wins)`,
			);
		}
		registry.set(name, contract);
		if (owner !== undefined) owners.set(name, owner);
		else owners.delete(name); // anonymous registration relinquishes any prior ownership claim
	}
}

/**
 * Register a LAZY contract provider. The thunk runs once on the first
 * `flushSkillContractProviders()` (which `loadWorkflows` awaits), letting a
 * sibling defer reading skill frontmatter off startup and onto first `/wf`.
 * Register before the first read.
 */
export function registerSkillContractsProvider(provider: SkillContractsProvider): void {
	getProviders().push(provider);
}

/**
 * Run all pending providers once, then memoize. Concurrency-safe (callers await
 * the same promise). DELIBERATE divergence from `flushBuiltInProviders`: each
 * provider is wrapped so a throw is RECORDED (into the failures slot, drained by
 * `drainSkillContractProviderErrors`), not propagated. Contract providers read
 * the filesystem / parse frontmatter (failure-prone), and `loadWorkflows` must
 * honor its never-throws contract — a malformed source degrades to a
 * partial/empty registry instead of crashing `/wf`, but the error is NOT
 * swallowed silently: `loadWorkflows` surfaces it as a `LoadIssue` so a buggy
 * provider is debuggable. Built-in providers are trusted in-process code and so
 * don't need the guard.
 */
export function flushSkillContractProviders(): Promise<void> {
	const g = globalThis as unknown as Global;
	const existing = g[FLUSH_KEY] as Promise<void> | undefined;
	if (existing) return existing;
	const pending = getProviders().splice(0);
	const flush = Promise.all(
		pending.map((p) =>
			Promise.resolve()
				.then(p)
				.catch((err) => {
					getFailures().push(err);
				}),
		),
	).then(() => undefined);
	g[FLUSH_KEY] = flush;
	return flush;
}

/**
 * Drain (return + clear) the errors recorded by failed contract providers since
 * the last drain. `loadWorkflows` calls this right after the flush and maps each
 * into a `LoadIssue`, so a provider bug surfaces in `loaded.issues` instead of
 * vanishing. Internal — not on the public barrel.
 */
export function drainSkillContractProviderErrors(): unknown[] {
	return getFailures().splice(0);
}

/**
 * Drain (return + clear) the cross-owner collision messages recorded since the
 * last drain (#4). `loadWorkflows` maps each into a `warning` `LoadIssue`.
 * Internal — not on the public barrel.
 */
export function drainSkillContractCollisions(): string[] {
	return getCollisions().splice(0);
}

/** Read-only view of the registry — consumed by `load/index.ts` + `buildRunContext`. */
export function getSkillContracts(): SkillContractMap {
	return getRegistry();
}

/**
 * Test reset (wired into repo-wide setup). Clears the registry, pending lazy
 * providers, recorded failures + collisions, ownership map, and the flush latch
 * so the next case starts clean.
 */
export function __resetSkillContracts(): void {
	getRegistry().clear();
	getProviders().length = 0;
	getFailures().length = 0;
	getCollisions().length = 0;
	getOwners().clear();
	(globalThis as unknown as Global)[FLUSH_KEY] = undefined;
}

// --- Slice 4: harvest ----------------------------------------------------------

/**
 * Derive a best-effort `harvested` contract per dispatched skill from how
 * workflow stages USE it — the cross-check / gap-fill source. Lower authority
 * than a declared frontmatter contract: the loader merges declared OVER
 * harvested. The harvestable surface is the `data` channel (via `extractJsonSchema`
 * on the stage's input/output schemas) plus the framework-native `kind`/`reads`;
 * the opaque `meta` bag (e.g. artifactKind) is declared-only — a collector is an
 * opaque function the framework can't introspect. When multiple stages
 * dispatch one skill with divergent schemas, last-writer wins for v1
 * (polymorphic union / drift detection deferred). Reuses `isDispatchingStage`
 * — the shared predicate the alias remap + no-op warning already agree on.
 *
 * LIMITATION (#2): the `data` channel only harvests from schemas that expose
 * their JSON Schema as data — i.e. `typeboxSchema(...)` (and `jsonSchemaToStandard`
 * raw wraps). A stage authored with Zod / Valibot / ArkType has an OPAQUE
 * `~standard` (no `jsonSchema` Converter), so `extractJsonSchema` returns
 * `undefined` and that stage contributes no harvested `data` — only `kind`/`reads`.
 * Such a consumer gets the full benefit by DECLARING contracts (any source) instead
 * of relying on harvest. This is inherent to Standard-Schema adoption, not a bug;
 * it's surfaced (not silent) so authors know why a Zod stage shows no `data`.
 */
export function harvestStageContracts(workflows: readonly Workflow[]): Map<string, SkillContract> {
	const harvested = new Map<string, SkillContract>();
	for (const w of workflows) {
		for (const [stageName, stage] of Object.entries(w.stages)) {
			if (!isDispatchingStage(stage)) continue; // only /skill: stages dispatch a contract-bearing skill
			const skill = stage.skill ?? stageName;
			const producesData = extractJsonSchema(stage.outputSchema);
			const consumesData = extractJsonSchema(stage.inputSchema);
			const reads = stage.reads?.length ? Object.fromEntries(stage.reads.map((r) => [r, {}])) : undefined;
			const produces: ProducesSpec | undefined =
				stage.kind === "produces" || producesData
					? { kind: stage.kind, ...(producesData ? { data: producesData } : {}) } // real StageKind ("produces" | "side-effect")
					: undefined;
			const consumes: ConsumesSpec | undefined =
				consumesData || reads
					? { ...(consumesData ? { data: consumesData } : {}), ...(reads ? { reads } : {}) }
					: undefined;
			if (!produces && !consumes) continue;
			harvested.set(skill, {
				source: "harvested",
				...(produces ? { produces } : {}),
				...(consumes ? { consumes } : {}),
			});
		}
	}
	return harvested;
}

// --- Slice 8: agent-facing composition queries ---------------------------------

/**
 * Can a producer skill's `produces.data` feed a consumer skill's `consumes.data`?
 * Conservative (via `isSchemaCompatible`): returns `{ ok: true }` when either
 * schema is absent/opaque (not provably incompatible).
 *
 * IMPORTANT (#3): the default `contracts` is the GLOBAL registry
 * (`getSkillContracts()`), which holds only `declared` + `injected` contracts —
 * NOT the `harvested` ones, which exist solely on `LoadedWorkflows.skillContracts`
 * (built per load, never written back to the global). So the zero-arg call sees a
 * weaker map than the loader's own edge-compat pass and will degrade to
 * `{ ok: true }` for any harvest-only skill. For the effective (declared ⊕
 * harvested) view an agent should pass `loaded.skillContracts` explicitly.
 */
export function canCompose(
	producerSkill: string,
	consumerSkill: string,
	contracts: SkillContractMap = getSkillContracts(),
): SchemaCompatResult {
	const producer = contracts.get(producerSkill)?.produces?.data;
	const consumer = contracts.get(consumerSkill)?.consumes?.data;
	if (!producer || !consumer) return { ok: true };
	return isSchemaCompatible(producer, consumer);
}

/**
 * Every known skill whose `consumes` is not provably incompatible with `skill`'s
 * `produces` — the generator's search-space narrowing. Sorted for determinism.
 * Same default-map caveat as `canCompose` (#3): pass `loaded.skillContracts` for
 * the effective (declared ⊕ harvested) view, else only declared/injected skills
 * are considered. Conservative by design — absent/opaque schemas count as
 * compatible, so this excludes only PROVABLE data-channel mismatches.
 */
export function legalNextSkills(skill: string, contracts: SkillContractMap = getSkillContracts()): string[] {
	const next: string[] = [];
	for (const candidate of contracts.keys()) {
		if (canCompose(skill, candidate, contracts).ok) next.push(candidate);
	}
	return next.sort();
}

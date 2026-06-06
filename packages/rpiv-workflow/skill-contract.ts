/**
 * Skill contract data model.
 *
 * A contract declares what a skill consumes and produces, as data — the
 * keystone that lets an agent reason about composition without scanning prose.
 * The contract is the SKILL's property (declared once in its frontmatter),
 * injected into this framework via `registerSkillContracts` / a provider
 * (see `skill-contracts.ts`). This package never reads skill files or parses
 * YAML — the primary consumer (rpiv-pi) supplies already-parsed contracts.
 *
 * Three field tiers, by who understands them (Decision 7):
 *   - data channel (`consumes.data` / `produces.data`, JSON Schema) — the ONLY
 *     channel this framework adjudicates; JSON Schema is consumer-neutral.
 *   - framework-native structure (`produces.kind`, `consumes.reads`) — derived
 *     from `StageDef`, typed because the framework owns these concepts.
 *   - opaque consumer metadata (`meta`) — domain tags the framework stores and
 *     surfaces but NEVER interprets (e.g. an `artifactKind` / handle-kind under
 *     whatever model a consumer uses). A consumer whose skills emit raw JSON,
 *     API-sourced artifacts, or many-artifacts-per-skill puts that here without
 *     the framework needing to know the shape.
 * Every channel is optional — a pure chat side-effect declares none.
 */

import type { JsonSchemaObject } from "./json-schema.js";

/**
 * Where a contract came from, in descending authority. `declared` = the skill's
 * own frontmatter (truth); `harvested` = derived from how workflow stages use
 * the skill (a cross-check / lint); `inferred` = future JSONL/LLM sources
 * (deferred). Absence (no contract at all) is modelled by the skill simply not
 * being present in the registry — there is no `missing` source.
 */
export type ContractSource = "declared" | "harvested" | "inferred";

/**
 * A named-channel reference a skill reads (`reads:` / `state.named`). v1 records
 * the reference exists but does NOT schema-check it — named-channel compat is
 * deferred. Any per-read domain tags (kind, artifactKind, …) live in `meta`,
 * opaque to the framework.
 */
export interface ConsumesReadSpec {
	meta?: Record<string, unknown>;
}

/**
 * What a skill consumes: an optional typed input `data` schema (the only
 * framework-adjudicated channel), optional framework-native named-channel
 * references (`reads`), and an opaque `meta` bag for consumer domain tags
 * (e.g. a required `artifactKind` under the consumer's own model).
 */
export interface ConsumesSpec {
	data?: JsonSchemaObject;
	reads?: Record<string, ConsumesReadSpec>;
	meta?: Record<string, unknown>;
}

/**
 * What a skill produces: the framework-native stage `kind` (mirrors
 * `StageKind` — `"produces" | "side-effect"`), an optional typed output `data`
 * schema (the only framework-adjudicated channel), and an opaque `meta` bag for
 * consumer domain tags (e.g. the emitted `artifactKind` under the consumer's
 * own model).
 */
export interface ProducesSpec {
	kind: string;
	data?: JsonSchemaObject;
	meta?: Record<string, unknown>;
}

/**
 * A skill's contract. `consumes` / `produces` are each optional (a skill may be
 * a pure chat side-effect). `source` records provenance — its only role today is
 * the `/wf` coverage banner's declared-vs-harvested tally.
 */
export interface SkillContract {
	consumes?: ConsumesSpec;
	produces?: ProducesSpec;
	source: ContractSource;
}

/** Registry shape: resolved post-alias skill name → contract. */
export type SkillContractMap = ReadonlyMap<string, SkillContract>;

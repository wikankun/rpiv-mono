/**
 * Raw-JSON-Schema ↔ Standard Schema bridge + introspection helpers.
 *
 * Phase 0 of the skill-contract stack: makes schemas inspectable AS DATA, not
 * just executable validators. Two directions:
 *
 *   - `jsonSchemaToStandard(schema)` wraps a plain JSON-Schema-shaped object
 *     (a skill's frontmatter `consumes.data` / `produces.data`) into a Standard
 *     Schema v1 backed by TypeBox `Value.Check` — droppable into the same
 *     `~standard.validate` seam `validate-output.ts` consumes, AND carrying the
 *     spec `jsonSchema` Converter so the captured schema round-trips back out.
 *   - `hasJsonSchema(schema)` / `extractJsonSchema(schema, target?)` feature-detect
 *     and pull the JSON Schema off ANY `~standard` value (TypeBox- or raw-wrapped).
 *     Phase 2's edge-compat checker uses them; opaque schemas (Zod/Valibot without
 *     the Converter) degrade to `undefined` and the caller skips + warns.
 *
 * No new dependency: `typebox@1.1.39` is keyword-driven, so `Value.Check`
 * validates a raw JSON Schema object with zero normalization.
 */

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { Value } from "typebox/value";

/** A JSON-Schema-shaped object — the canonical contract data format. */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * Runtime guard that a value is a plain (non-null, non-array) object — the
 * minimum shape a JSON Schema must have. The framework treats INJECTED contracts
 * as untrusted: any caller that feeds a `consumes.data` / `produces.data` into
 * the keyword engine guards with this first, so a malformed contract (a string /
 * array / null where a schema was expected) DEGRADES instead of throwing into a
 * load or a run.
 */
export function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The intersection a `~standard` value carries when it exposes its JSON Schema
 * as data: the validate surface (`StandardSchemaV1`) PLUS the introspection
 * Converter (`StandardJSONSchemaV1`). `typeboxSchema` and `jsonSchemaToStandard`
 * both return this; third-party schemas (Zod/Valibot) satisfy only the former.
 */
export type JsonSchemaCapable<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
	StandardJSONSchemaV1<Input, Output>;

/** Targets whose dialect our structural subset serialises to identically. */
const SUPPORTED_TARGETS = new Set<string>(["draft-2020-12", "draft-07"]);

/**
 * Build the spec-conformant `jsonSchema` Converter for a captured schema. The
 * captured value is already a clean JSON Schema (TypeBox v1 schemas have zero
 * symbol keys; frontmatter schemas are plain objects), so `input`/`output` both
 * return it — validation-only schemas have no input≠output transform. Supports
 * `draft-2020-12` + `draft-07` (the spec's strongly-recommended pair), identical
 * over our structural subset; other targets throw per the spec.
 */
export function jsonSchemaConverter(schema: JsonSchemaObject): StandardJSONSchemaV1.Converter {
	const convert = (options: StandardJSONSchemaV1.Options): JsonSchemaObject => {
		if (!SUPPORTED_TARGETS.has(options.target)) {
			throw new Error(
				`jsonSchema: unsupported target "${options.target}" (supported: ${[...SUPPORTED_TARGETS].join(", ")})`,
			);
		}
		return schema;
	};
	return { input: convert, output: convert };
}

/**
 * Wrap a raw JSON-Schema-shaped object into a Standard Schema v1 that BOTH
 * validates (via `Value.Check`) and exposes the schema as data (the Converter).
 * The `Value.Errors → Issue[]` mapping matches `typebox-adapter.ts` so both
 * wrappers report failures identically.
 */
export function jsonSchemaToStandard(schema: JsonSchemaObject): JsonSchemaCapable {
	return {
		"~standard": {
			version: 1,
			vendor: "rpiv-json-schema",
			validate: (value: unknown) => {
				if (Value.Check(schema, value)) return { value };
				const issues = [...Value.Errors(schema, value)].map((err) => ({
					message: err.message || `${err.keyword} validation failed at ${err.instancePath || "root"}`,
					path: err.instancePath ? err.instancePath.split("/").filter(Boolean) : undefined,
				}));
				return { issues };
			},
			jsonSchema: jsonSchemaConverter(schema),
		},
	};
}

/**
 * True when a `~standard` value exposes its JSON Schema as data (carries the
 * `jsonSchema` Converter). TypeBox- and raw-wrapped schemas pass; Zod/Valibot/
 * ArkType schemas — which implement only `~standard.validate` — do not.
 */
export function hasJsonSchema(schema: StandardSchemaV1 | undefined): schema is JsonSchemaCapable {
	if (!schema) return false;
	const std = (schema as Partial<JsonSchemaCapable>)["~standard"] as Partial<StandardJSONSchemaV1.Props> | undefined;
	return typeof std?.jsonSchema?.output === "function";
}

/**
 * Pull the JSON Schema back off a `~standard` value as data, or `undefined`
 * when the schema is opaque (no Converter) or the Converter throws for the
 * requested target. Phase 2's edge-compat checker calls this and skips + warns
 * on `undefined`. Defaults to `draft-2020-12` — the TypeBox-native dialect.
 */
export function extractJsonSchema(
	schema: StandardSchemaV1 | undefined,
	target: StandardJSONSchemaV1.Target = "draft-2020-12",
): JsonSchemaObject | undefined {
	if (!hasJsonSchema(schema)) return undefined;
	try {
		return schema["~standard"].jsonSchema.output({ target });
	} catch {
		return undefined;
	}
}

// --- Slice 6: conservative structural comparator (shared by checkEdgeSchemaCompat + canCompose) ---

export interface SchemaCompatResult {
	ok: boolean;
	reason?: string;
}

/** The set of JSON-Schema `type`s a schema allows (string or string[]), or undefined if untyped. */
function typeSet(schema: JsonSchemaObject): Set<string> | undefined {
	const t = schema.type;
	if (typeof t === "string") return new Set([t]);
	if (Array.isArray(t) && t.every((x) => typeof x === "string")) return new Set(t as string[]);
	return undefined;
}

/** Two sets share no member. */
function disjoint(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
	for (const x of a) if (b.has(x)) return false;
	return true;
}

/** `integer` is a subtype of `number` — widen so the two never read as disjoint. */
function widenNumeric(s: Set<string>): Set<string> {
	return s.has("integer") ? new Set([...s, "number"]) : s;
}

/**
 * Rule 1 — a producer that CLOSES its object (`additionalProperties: false`) and
 * omits a field the consumer `requires` provably never emits it. `undefined` when
 * the producer is open or emits every required field.
 */
function closedProducerOmitsRequired(
	producer: JsonSchemaObject,
	producerProps: Record<string, JsonSchemaObject>,
	required: readonly string[],
): SchemaCompatResult | undefined {
	if (producer.additionalProperties !== false) return undefined;
	for (const key of required) {
		if (!(key in producerProps)) {
			return { ok: false, reason: `consumer requires "${key}" but producer (closed object) never emits it` };
		}
	}
	return undefined;
}

/** Rule 2 — producer and consumer pin disjoint `type` sets for the shared field. */
function fieldTypeConflict(key: string, p: JsonSchemaObject, c: JsonSchemaObject): SchemaCompatResult | undefined {
	const pt = typeSet(p);
	const ct = typeSet(c);
	if (pt && ct && disjoint(widenNumeric(pt), widenNumeric(ct))) {
		return {
			ok: false,
			reason: `field "${key}": producer emits ${[...pt].join("|")} but consumer expects ${[...ct].join("|")}`,
		};
	}
	return undefined;
}

/** Rule 3 — producer and consumer both restrict to `enum`, and the two enums are disjoint. */
function fieldEnumConflict(key: string, p: JsonSchemaObject, c: JsonSchemaObject): SchemaCompatResult | undefined {
	if (!Array.isArray(p.enum) || !Array.isArray(c.enum)) return undefined;
	const pe = new Set(p.enum.map((v) => JSON.stringify(v)));
	const ce = new Set(c.enum.map((v) => JSON.stringify(v)));
	if (disjoint(pe, ce)) return { ok: false, reason: `field "${key}": producer enum is disjoint from consumer enum` };
	return undefined;
}

/** Rule 4 — producer and consumer both pin a `const`, and the two constants differ. */
function fieldConstConflict(key: string, p: JsonSchemaObject, c: JsonSchemaObject): SchemaCompatResult | undefined {
	if ("const" in p && "const" in c && JSON.stringify(p.const) !== JSON.stringify(c.const)) {
		return {
			ok: false,
			reason: `field "${key}": producer const ${JSON.stringify(p.const)} ≠ consumer const ${JSON.stringify(c.const)}`,
		};
	}
	return undefined;
}

/**
 * Conservative structural compatibility of a producer's output schema against a
 * consumer's input schema. Deliberately NOT a full JSON-Schema subtype engine —
 * it only flags DEFINITE mismatches (no false positives). For each field present
 * in BOTH `properties` it reports a conflict when:
 *   1. their allowed `type` sets are disjoint — covers `type` arrays like
 *      `["string","null"]`, and treats `integer` as a `number` so `integer`↔
 *      `number` is never falsely flagged;
 *   2. both restrict to an `enum` and the two enums are disjoint (by JSON value)
 *      — the producer can only emit values the consumer never accepts;
 *   3. both pin a `const` and the two constants differ (by JSON value).
 * Plus: a CLOSED producer object (`additionalProperties: false`) that omits a
 * field the consumer `requires` — provably never emitted. Everything else (open
 * producers, untyped fields, nested objects, `$ref`, oneOf/anyOf) returns
 * `{ ok: true }` — not provably incompatible. Non-object roots aren't compared.
 *
 * NOTE: the closed-object rule rarely fires for TypeBox/harvested schemas
 * (`Type.Object` doesn't emit `additionalProperties: false`); it's reachable
 * mainly for hand-authored frontmatter that explicitly closes the object. The
 * per-field type/enum/const rules are what catch most real producer↔consumer drift.
 */
export function isSchemaCompatible(producer: JsonSchemaObject, consumer: JsonSchemaObject): SchemaCompatResult {
	if (producer.type !== "object" || consumer.type !== "object") return { ok: true };
	const producerProps = (producer.properties as Record<string, JsonSchemaObject> | undefined) ?? {};
	const consumerProps = (consumer.properties as Record<string, JsonSchemaObject> | undefined) ?? {};
	const required = Array.isArray(consumer.required) ? (consumer.required as string[]) : [];

	const omission = closedProducerOmitsRequired(producer, producerProps, required);
	if (omission) return omission;

	for (const key of Object.keys(consumerProps)) {
		const p = producerProps[key];
		const c = consumerProps[key];
		if (!p || !c) continue;
		const conflict = fieldTypeConflict(key, p, c) ?? fieldEnumConflict(key, p, c) ?? fieldConstConflict(key, p, c);
		if (conflict) return conflict;
	}
	return { ok: true };
}

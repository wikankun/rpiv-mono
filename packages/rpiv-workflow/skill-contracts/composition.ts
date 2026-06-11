/**
 * Composition queries — can one skill's output feed another's input?
 *
 * Conservative structural compatibility checks using `isSchemaCompatible` for
 * the data channel and per-channel `CompositionComparator` for named-channel
 * reads. Returns `{ ok: true }` when either schema is absent/opaque
 * (not provably incompatible).
 */

import { formatError } from "../internal-utils.js";
import { isSchemaCompatible } from "../schema-compat.js";
import type {
	CompositionComparator,
	ConsumesSpec,
	ProducesSpec,
	SchemaCompatResult,
	SkillContractMap,
} from "../skill-contract.js";
import { getCompositionComparators } from "./registries.js";

/** Outcome of adjudicating one named channel — see `adjudicateChannel`. */
export type ChannelAdjudication =
	| { kind: "ok" }
	| { kind: "mismatch"; reason?: string }
	/** No comparator registered, or the consumer declares no `meta` requirement for the channel. */
	| { kind: "skipped" }
	/** The consumer-supplied comparator threw — an author defect, reported, never propagated. */
	| { kind: "comparator-threw"; error: string };

/**
 * THE single adjudication rule for one named channel — shared by `canCompose`
 * (the advisory composition query) and `checkReadsChannelCompat` (the load
 * gate) so the two can never disagree about a producer/consumer pair.
 *
 * Gating: a channel is adjudicated iff a comparator is registered for it AND
 * the consumer's `consumes.reads[channel]` declares a `meta` requirement —
 * without a declared requirement there is no kind to compare, and invoking
 * the comparator anyway is a false-reject risk for multi-channel consumers.
 * Degrade posture: gating misses return `"skipped"`; a comparator throw
 * returns `"comparator-threw"` (callers decide whether to surface it) —
 * adjudication itself never throws.
 */
export function adjudicateChannel(
	produces: ProducesSpec,
	consumes: ConsumesSpec,
	channel: string,
	comparators: ReadonlyMap<string, CompositionComparator> = getCompositionComparators(),
): ChannelAdjudication {
	const comparator = comparators.get(channel);
	if (!comparator || !consumes.reads?.[channel]?.meta) return { kind: "skipped" };
	try {
		const compat = comparator(produces, consumes, channel);
		return compat.ok ? { kind: "ok" } : { kind: "mismatch", reason: compat.reason };
	} catch (e) {
		return { kind: "comparator-threw", error: formatError(e) };
	}
}

/**
 * Can a producer skill's `produces.data` feed a consumer skill's `consumes.data`?
 * Conservative (via `isSchemaCompatible`): returns `{ ok: true }` when either
 * schema is absent/opaque (not provably incompatible).
 *
 * `contracts` is REQUIRED (T12): the old zero-arg default silently consulted
 * the GLOBAL registry, which holds only `declared` + `injected` contracts —
 * NOT the `harvested` ones, which exist solely on
 * `LoadedWorkflows.skillContracts` (built per load, never written back to the
 * global) — so the convenient call was the wrong one for any harvest-only
 * skill. Pass `loaded.skillContracts` for the effective (declared ⊕
 * harvested) view, or `getSkillContracts()` when the declared/injected slice
 * is genuinely what you mean.
 */
export function canCompose(
	producerSkill: string,
	consumerSkill: string,
	contracts: SkillContractMap,
): SchemaCompatResult {
	const producerContract = contracts.get(producerSkill);
	const consumerContract = contracts.get(consumerSkill);
	// Data channel: a provable data mismatch is decisive.
	const producerData = producerContract?.produces?.data;
	const consumerData = consumerContract?.consumes?.data;
	if (producerData && consumerData) {
		const dataCompat = isSchemaCompatible(producerData, consumerData);
		if (!dataCompat.ok) return dataCompat;
	}
	// Named-channel (reads) compat — THE shared `adjudicateChannel` rule (same
	// gating + degrade posture as the validator's load gate). Only a clean
	// mismatch is decisive; skipped channels and comparator throws degrade to
	// `{ ok: true }` — this advisory query never propagates a comparator defect.
	const produces = producerContract?.produces;
	const consumes = consumerContract?.consumes;
	if (produces && consumes?.reads) {
		for (const channel of Object.keys(consumes.reads)) {
			const verdict = adjudicateChannel(produces, consumes, channel);
			if (verdict.kind === "mismatch") {
				return { ok: false, reason: verdict.reason ?? `named-channel "${channel}" meta incompatibility` };
			}
		}
	}
	return { ok: true };
}

/**
 * Every known skill whose `consumes` is not provably incompatible with `skill`'s
 * `produces` — the generator's search-space narrowing. Sorted for determinism.
 * `contracts` is REQUIRED — same rationale as `canCompose`: pass
 * `loaded.skillContracts` for the effective (declared ⊕ harvested) view.
 * Conservative by design — absent/opaque schemas count as compatible, so this
 * excludes only PROVABLE data-channel mismatches.
 */
export function legalNextSkills(skill: string, contracts: SkillContractMap): string[] {
	const next: string[] = [];
	for (const candidate of contracts.keys()) {
		if (canCompose(skill, candidate, contracts).ok) next.push(candidate);
	}
	return next.sort();
}

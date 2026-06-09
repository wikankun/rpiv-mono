/**
 * Skill-contract registry public surface. Internally split into four focused
 * modules (see `registry.ts`'s header for the module map); this barrel
 * re-exports only the symbols the rest of the package consumes.
 */

export { canCompose, legalNextSkills } from "./composition.js";

export { buildEffectiveContracts, harvestStageContracts } from "./harvest.js";
export {
	getCompositionComparators,
	getOutcomeDerivers,
	type OutcomeDeriverFn,
	registerCompositionComparator,
	registerOutcomeDeriver,
} from "./registries.js";
export {
	drainSkillContractCollisions,
	drainSkillContractProviderErrors,
	flushSkillContractProviders,
	getSkillContracts,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "./registry.js";

import { __resetRegistries } from "./registries.js";
import { __resetRegistry } from "./registry.js";

/**
 * Test reset (wired into repo-wide setup). Clears the registry, pending lazy
 * providers, recorded failures + collisions, ownership map, comparator + deriver
 * registries, and the flush latch so the next case starts clean.
 */
export function __resetSkillContracts(): void {
	__resetRegistry();
	__resetRegistries();
}

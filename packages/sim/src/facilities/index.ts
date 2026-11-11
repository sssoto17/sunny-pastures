// Facilities: buying them, and the jobs they run (MUST-03, MUST-05.6; ADR-0005, section 3; ADR-0003,
// section 12).
import type { Content } from "../content/index.js";
import { purchase } from "../progress/index.js";
import type { ProgressRules } from "../progress/index.js";
import { refuse } from "../state/index.js";
import type { ApplyResult, FarmState } from "../state/index.js";

/** A bought facility (ADR-0003, section 5: owned facilities with their tier and queue). */
export interface OwnedFacility {
	/** From 1 (`GLOSSARY.md`, "Tier"); #85 upgrades it. */
	readonly tier: number;
	/** The queue, in the order the jobs started; a job's slot is its position (MUST-03.3, 03.5). */
	readonly jobs: readonly Job[];
}

/** One run of a recipe in a facility's queue (`GLOSSARY.md`, "Job"). */
export type Job =
	/**
	 * Finishes as an automated step at `readyAt`, in ms, stored when the job starts so a later
	 * rules version doesn't move it (ADR-0006, section 7; MUST-06.7).
	 */
	| { readonly status: "running"; readonly recipe: string; readonly readyAt: number }
	/** Its goods wait in the facility until collected (MUST-03.4). */
	| { readonly status: "done"; readonly recipe: string };

/** The actions on facilities (MUST-03). `facility` is an index in content order. */
export interface FacilityAction {
	readonly type: "buyFacility";
	readonly facility: number;
}

/** The facility rules for one content, prepared once in createSim. */
export interface FacilityRules {
	/** In content order. */
	readonly facilities: readonly FacilityRule[];
	readonly progress: ProgressRules;
}

/** Copies what the rules read: each facility's unlock Level, and its job times in ms (D7). */
export function prepareFacilityRules(content: Content, progress: ProgressRules): FacilityRules {
	const facilities = content.facilities.map((facility): FacilityRule => ({
		id: facility.id,
		price: facility.price,
		level: progress.facilityLevels.get(facility.id) ?? null,
		slots: facility.slots,
	}));
	return { facilities, progress };
}

/** A new farm's facilities: none bought, one entry per content facility (MUST-05.6). */
export function newFacilities(rules: FacilityRules): readonly (OwnedFacility | null)[] {
	return rules.facilities.map(() => null);
}

/**
 * Buys a facility at tier 1 with an empty queue, once the farm's Level unlocks it, through the
 * purchase rule (spec decision 1, MUST-05.6). Refused if the farm already has it, so an action
 * sent twice buys it once.
 */
export function buyFacility(farm: FarmState, index: number, rules: FacilityRules): ApplyResult {
	const facility = findRule(index, rules);
	if (facility === null) return refuse(`There is no facility ${formatFacilityNumber(index)}.`);

	const owned = farm.facilities[index] ?? null;
	if (owned !== null) return refuse(`The ${facility.id} is already bought.`);

	const offer = { what: `The ${facility.id}`, level: facility.level, price: facility.price };
	const bought = purchase(farm, offer, rules.progress);
	if (!bought.ok) return bought;

	return { ok: true, state: replaceFacility(bought.state, index, { tier: 1, jobs: [] }) };
}

interface FacilityRule {
	readonly id: string;
	readonly price: number;
	/** The Level that unlocks it, or null if none does. */
	readonly level: number | null;
	readonly slots: number;
}

function findRule(index: number, rules: FacilityRules): FacilityRule | null {
	return Number.isSafeInteger(index) && index >= 0 ? (rules.facilities[index] ?? null) : null;
}

/** Players count facilities from 1. */
function formatFacilityNumber(index: number): string {
	return String(index + 1);
}

/**
 * Sets the facility at `index`. The farm has one entry per content facility: a version that adds
 * facilities adds their entries in its `upgrade` (ADR-0006, section 6).
 */
function replaceFacility(farm: FarmState, index: number, facility: OwnedFacility): FarmState {
	return {
		...farm,
		facilities: farm.facilities.map((current, i) => (i === index ? facility : current)),
	};
}

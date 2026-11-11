// Facilities: buying them, and the jobs they run (MUST-03, MUST-05.6; ADR-0005, section 3; ADR-0003,
// section 12).
import { assertTime } from "../advance/index.js";
import type { AutomatedStep, StepSource } from "../advance/index.js";
import type { Content, GoodCount } from "../content/index.js";
import { gainXp, purchase } from "../progress/index.js";
import type { ProgressRules } from "../progress/index.js";
import { refuse } from "../state/index.js";
import type { ApplyResult, FarmState } from "../state/index.js";
import { put, take } from "../storage/index.js";
import type { StorageRules } from "../storage/index.js";

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
export type FacilityAction =
	| { readonly type: "buyFacility"; readonly facility: number }
	| { readonly type: "startJob"; readonly facility: number; readonly recipe: string }
	/** Collects the oldest job, in the first slot, once it is done. */
	| { readonly type: "collect"; readonly facility: number };

/** The facility rules for one content, prepared once in createSim. */
export interface FacilityRules {
	/** In content order. */
	readonly facilities: readonly FacilityRule[];
	readonly progress: ProgressRules;
	readonly storage: StorageRules;
}

/** Copies what the rules read: each facility's unlock Level, and its job times in ms (D7). */
export function prepareFacilityRules(
	content: Content,
	progress: ProgressRules,
	storage: StorageRules,
): FacilityRules {
	const facilities = content.facilities.map((facility): FacilityRule => ({
		id: facility.id,
		price: facility.price,
		level: progress.facilityLevels.get(facility.id) ?? null,
		slots: facility.slots,
		recipes: new Map(
			Object.entries(facility.recipes).map(([id, recipe]): [string, RecipeRule] => [
				id,
				{
					id,
					tier: recipe.tier,
					inputs: recipe.inputs.map(({ good, amount }) => ({ good, amount })),
					output: { good: recipe.output.good, amount: recipe.output.amount },
					ms: recipe.seconds * 1000,
					xp: recipe.xp,
				},
			]),
		),
	}));
	return { facilities, progress, storage };
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

/**
 * Starts a job: needs the recipe at the facility's tier, a free queue slot and every input in
 * storage, which leaves storage now (MUST-03.2). It finishes at the later of now and the previous
 * job's finish, plus the recipe's time, stored now (MUST-03.3; ADR-0006, section 7).
 */
export function startJob(
	farm: FarmState,
	index: number,
	recipeId: string,
	rules: FacilityRules,
): ApplyResult {
	const found = findOwned(farm, index, rules);
	if (typeof found === "string") return refuse(found);

	const { facility, owned } = found;

	const recipe = facility.recipes.get(recipeId);
	if (recipe === undefined) return refuse(`The ${facility.id} has no recipe ${recipeId}.`);
	if (recipe.tier > owned.tier) {
		return refuse(
			`The ${facility.id} makes ${recipe.id} from tier ${String(recipe.tier)}, and it is at tier ${String(owned.tier)}.`,
		);
	}
	if (owned.jobs.length >= facility.slots) {
		return refuse(
			`The ${facility.id}'s queue is full: ${String(owned.jobs.length)} of ${String(facility.slots)} slots.`,
		);
	}

	const taken = take(farm, recipe.inputs, `Making ${recipe.id}`, rules.storage);
	if (!taken.ok) return taken;

	const last = owned.jobs[owned.jobs.length - 1];
	const from = last?.status === "running" ? Math.max(farm.time, last.readyAt) : farm.time;
	const readyAt = from + recipe.ms;
	assertTime(readyAt);
	const job: Job = { status: "running", recipe: recipe.id, readyAt };
	const queued = { ...owned, jobs: [...owned.jobs, job] };
	return { ok: true, state: replaceFacility(taken.state, index, queued) };
}

/**
 * Collects the oldest job once it is done: its goods go to the barn, refused if they don't fit,
 * and it gives XP, with the level-up coins of any Level it reaches (MUST-03.4, 05.2, 05.4). The
 * jobs behind it move up a slot.
 */
export function collect(farm: FarmState, index: number, rules: FacilityRules): ApplyResult {
	const found = findOwned(farm, index, rules);
	if (typeof found === "string") return refuse(found);

	const { facility, owned } = found;
	const [job, ...rest] = owned.jobs;
	if (job?.status !== "done") return refuse(`The ${facility.id} has no finished job to collect.`);

	// A done job's recipe is in content: a version that drops a recipe settles its jobs in its
	// `upgrade` (ADR-0006, section 6), so a missing one is a programmer error.
	const recipe = facility.recipes.get(job.recipe);
	if (recipe === undefined) {
		throw new RangeError(
			`The ${facility.id} has a done job of ${job.recipe}, which isn't in content.`,
		);
	}

	const stored = put(farm, recipe.output, "collecting the job", rules.storage);
	if (!stored.ok) return stored;

	const collected = replaceFacility(stored.state, index, { ...owned, jobs: rest });
	return { ok: true, state: gainXp(collected, recipe.xp, rules.progress) };
}

/** A running job becomes done at its `readyAt`, keyed by facility index and queue slot (MUST-03.3). */
export const jobFinishing: StepSource<FarmState> = {
	steps: (farm) =>
		farm.facilities.flatMap((owned, index): AutomatedStep[] =>
			(owned?.jobs ?? []).flatMap((job, slot): AutomatedStep[] =>
				job.status === "running" ? [{ at: job.readyAt, kind: "finishJob", index, slot }] : [],
			),
		),
	run: (farm, step) => {
		const owned = farm.facilities[step.index] ?? null;
		const job = owned?.jobs[step.slot];
		if (owned === null || job?.status !== "running") return farm;

		const done: Job = { status: "done", recipe: job.recipe };
		const jobs = owned.jobs.map((current, slot) => (slot === step.slot ? done : current));
		return replaceFacility(farm, step.index, { ...owned, jobs });
	},
};

interface FacilityRule {
	readonly id: string;
	readonly price: number;
	/** The Level that unlocks it, or null if none does. */
	readonly level: number | null;
	readonly slots: number;
	readonly recipes: ReadonlyMap<string, RecipeRule>;
}

interface RecipeRule {
	readonly id: string;
	readonly tier: number;
	readonly inputs: readonly GoodCount[];
	readonly output: GoodCount;
	readonly ms: number;
	readonly xp: number;
}

function findRule(index: number, rules: FacilityRules): FacilityRule | null {
	return Number.isSafeInteger(index) && index >= 0 ? (rules.facilities[index] ?? null) : null;
}

/** The facility at `index` and the farm's copy of it, or why there is none, as a sentence. */
function findOwned(
	farm: FarmState,
	index: number,
	rules: FacilityRules,
): { facility: FacilityRule; owned: OwnedFacility } | string {
	const facility = findRule(index, rules);
	if (facility === null) return `There is no facility ${formatFacilityNumber(index)}.`;

	const owned = farm.facilities[index] ?? null;
	if (owned === null) return `The ${facility.id} isn't bought.`;

	return { facility, owned };
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

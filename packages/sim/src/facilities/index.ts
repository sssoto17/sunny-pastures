// Facilities: buying them, and the jobs they run (MUST-03, MUST-05.6; ADR-0005, section 3; ADR-0003,
// section 12).
import { assertTime } from "../advance/index.js";
import type { AutomatedStep, StepSource } from "../advance/index.js";
import type { AddOn, Content, GoodCount } from "../content/index.js";
import { gainXp, purchase } from "../progress/index.js";
import type { ProgressRules } from "../progress/index.js";
import { refuse } from "../state/index.js";
import type { ApplyResult, FarmState } from "../state/index.js";
import { put, take } from "../storage/index.js";
import type { StorageRules } from "../storage/index.js";

/** A bought facility (ADR-0003, section 5: owned facilities with their tier, add-ons and queue). */
export interface OwnedFacility {
	/** From 1 (`GLOSSARY.md`, "Tier"); #85 upgrades it. */
	readonly tier: number;
	/** The queue, in the order the jobs started; a job's slot is its position (MUST-03.3, 03.5). */
	readonly jobs: readonly Job[];
	/**
	 * The recipe of the job started last, by hand or by the Loop, which the Loop starts again
	 * (MUST-06.5); null until a job starts. Stored, since the queue forgets it once collected.
	 */
	readonly lastRecipe: string | null;
	/** Whether the farm has bought each add-on for this facility; none when bought (MUST-06.8). */
	readonly addOns: Readonly<Record<AddOn, boolean>>;
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
	| { readonly type: "collect"; readonly facility: number }
	| { readonly type: "buyAddOn"; readonly facility: number; readonly addOn: AddOn };

/** The facility rules for one content, prepared once in createSim. */
export interface FacilityRules {
	/** In content order. */
	readonly facilities: readonly FacilityRule[];
	readonly progress: ProgressRules;
	readonly storage: StorageRules;
	/** Each add-on's price and unlock Level, by add-on. */
	readonly addOns: ReadonlyMap<string, AddOnRule>;
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
	// A lookup by name, so the order of content's keys decides nothing (MUST-10.6).
	const addOns = new Map(
		Object.entries(content.addOns).map(([id, { price }]): [string, AddOnRule] => [
			id,
			{ name: addOnNames[id as AddOn], price, level: progress.addOnLevels.get(id) ?? null },
		]),
	);
	return { facilities, progress, storage, addOns };
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

	if (readEntry(farm, index, facility) !== null) {
		return refuse(`The ${facility.id} is already bought.`);
	}

	const offer = { what: `The ${facility.id}`, level: facility.level, price: facility.price };
	const bought = purchase(farm, offer, rules.progress);
	if (!bought.ok) return bought;

	const facilityBought: OwnedFacility = {
		tier: 1,
		jobs: [],
		lastRecipe: null,
		addOns: { loop: false, collector: false },
	};
	return { ok: true, state: replaceFacility(bought.state, index, facilityBought) };
}

/**
 * Starts a job: needs the recipe at the facility's tier, a free queue slot and every input in
 * storage, which leaves storage now (MUST-03.2). It finishes at the later of now and the previous
 * job's finish, plus the recipe's time, stored now (MUST-03.3; ADR-0006, section 7). The recipe
 * becomes the facility's last, which its Loop starts again (MUST-06.5).
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

	// MUST-03.3's "later of its start and the previous job's finish": apply advances the farm first,
	// so a job still running ends after the farm's time and a done one ended at or before it.
	const last = owned.jobs[owned.jobs.length - 1];
	const from = last?.status === "running" ? last.readyAt : farm.time;
	const readyAt = from + recipe.ms;
	assertTime(readyAt);
	const job: Job = { status: "running", recipe: recipe.id, readyAt };
	const queued = { ...owned, jobs: [...owned.jobs, job], lastRecipe: recipe.id };
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
	if (owned.jobs[0]?.status !== "done") {
		return refuse(`The ${facility.id} has no finished job to collect.`);
	}

	return collectOldest(farm, index, owned, facility, rules);
}

/**
 * Buys an add-on for a bought facility, once the farm's Level unlocks it, through the purchase rule
 * (spec decision 1, MUST-05.6). Refused if the facility has it, so an action sent twice buys it
 * once. It works from the next automated step on: work already running keeps its finish time
 * (MUST-06.7).
 */
export function buyAddOn(
	farm: FarmState,
	index: number,
	addOn: AddOn,
	rules: FacilityRules,
): ApplyResult {
	const found = findOwned(farm, index, rules);
	if (typeof found === "string") return refuse(found);

	const { facility, owned } = found;
	const rule = rules.addOns.get(addOn);
	if (rule === undefined) return refuse(`There is no add-on ${addOn}.`);
	if (owned.addOns[addOn]) return refuse(`The ${facility.id} already has a ${rule.name}.`);

	const offer = { what: `The ${facility.id}'s ${rule.name}`, level: rule.level, price: rule.price };
	const bought = purchase(farm, offer, rules.progress);
	if (!bought.ok) return bought;

	const equipped = { ...owned, addOns: { ...owned.addOns, [addOn]: true } };
	return { ok: true, state: replaceFacility(bought.state, index, equipped) };
}

/**
 * A running job becomes done at its `readyAt`, keyed by facility index and queue slot (MUST-03.3).
 * In a facility with a Collector, the Collector's step finishes it instead (`createCollecting`).
 */
export const jobFinishing: StepSource<FarmState> = {
	steps: (farm) => findFinishes(farm, "finishJob", (owned) => !owned.addOns.collector),
	run: finishJob,
};

/**
 * The Collector (MUST-06.6): a job finishing in its facility is a `moveGoods` step, which finishes
 * the job and then moves the facility's done jobs into the barn, oldest first, while they fit. It
 * decides once, as the job finishes: goods that don't fit wait in the facility as a done job until
 * collected by hand or moved at the facility's next finish (ADR-0003, section 13).
 */
export function createCollecting(rules: FacilityRules): StepSource<FarmState> {
	return {
		steps: (farm) => findFinishes(farm, "moveGoods", (owned) => owned.addOns.collector),
		run: (farm, step) => {
			let current = finishJob(farm, step);
			for (;;) {
				const owned = current.facilities[step.index] ?? null;
				const facility = rules.facilities[step.index];
				if (owned?.jobs[0]?.status !== "done" || facility === undefined) return current;

				const moved = collectOldest(current, step.index, owned, facility, rules);
				if (!moved.ok) return current;

				current = moved.state;
			}
		},
	};
}

/**
 * The Loop (MUST-06.5): while its facility has a free slot and the inputs are in storage, it
 * starts the facility's last recipe again, through `startJob`, so the job stores its finish when it
 * starts (ADR-0006, section 7). A `restartRecipe` step falls at the farm's time, keyed by the slot
 * it fills, one job a step. It stops when the inputs or the slots run out; goods the Collector
 * can't fit keep their slots, so it stops when the output wouldn't fit (MUST-07.2).
 */
export function createLooping(rules: FacilityRules): StepSource<FarmState> {
	return {
		steps: (farm) =>
			farm.facilities.flatMap((owned, index): AutomatedStep[] =>
				restart(farm, index, rules) === null
					? []
					: [{ at: farm.time, kind: "restartRecipe", index, slot: owned?.jobs.length ?? 0 }],
			),
		run: (farm, step) => restart(farm, step.index, rules) ?? farm,
	};
}

/** The farm with the facility's Loop restarted, or null if it has no Loop or can't restart. */
function restart(farm: FarmState, index: number, rules: FacilityRules): FarmState | null {
	const owned = farm.facilities[index] ?? null;
	if (owned?.addOns.loop !== true || owned.lastRecipe === null) return null;

	const started = startJob(farm, index, owned.lastRecipe, rules);
	return started.ok ? started.state : null;
}

/**
 * Collects the job in slot 0, which must be done: its goods go to the barn, refused if they don't
 * fit, and it gives XP through gainXp (MUST-03.4, 05.2). The jobs behind it move up a slot.
 * Collecting by hand and the Collector share it.
 */
function collectOldest(
	farm: FarmState,
	index: number,
	owned: OwnedFacility,
	facility: FacilityRule,
	rules: FacilityRules,
): ApplyResult {
	const [job, ...rest] = owned.jobs;
	// A done job's recipe is in content: a version that drops a recipe settles its jobs in its
	// `upgrade` (ADR-0006, section 6), so a missing one is a programmer error.
	const recipe = facility.recipes.get(job?.recipe ?? "");
	if (recipe === undefined) {
		throw new RangeError(
			`The ${facility.id} has a done job of ${job?.recipe ?? "nothing"}, which isn't in content.`,
		);
	}

	const stored = put(farm, recipe.output, "collecting the job", rules.storage);
	if (!stored.ok) return stored;

	const collected = replaceFacility(stored.state, index, { ...owned, jobs: rest });
	return { ok: true, state: gainXp(collected, recipe.xp, rules.progress) };
}

/** A step of `kind` at each running job's `readyAt`, in the facilities `chosen` picks. */
function findFinishes(
	farm: FarmState,
	kind: "finishJob" | "moveGoods",
	chosen: (owned: OwnedFacility) => boolean,
): AutomatedStep[] {
	return farm.facilities.flatMap((owned, index): AutomatedStep[] =>
		owned !== null && chosen(owned)
			? owned.jobs.flatMap((job, slot): AutomatedStep[] =>
					job.status === "running" ? [{ at: job.readyAt, kind, index, slot }] : [],
				)
			: [],
	);
}

/** Marks the running job in the step's slot done. */
function finishJob(farm: FarmState, step: AutomatedStep): FarmState {
	const owned = farm.facilities[step.index] ?? null;
	const job = owned?.jobs[step.slot];
	if (owned === null || job?.status !== "running") return farm;

	const done: Job = { status: "done", recipe: job.recipe };
	const jobs = owned.jobs.map((current, slot) => (slot === step.slot ? done : current));
	return replaceFacility(farm, step.index, { ...owned, jobs });
}

interface FacilityRule {
	readonly id: string;
	readonly price: number;
	/** The Level that unlocks it, or null if none does. */
	readonly level: number | null;
	readonly slots: number;
	readonly recipes: ReadonlyMap<string, RecipeRule>;
}

interface AddOnRule {
	/** As players read it (`GLOSSARY.md`). */
	readonly name: string;
	readonly price: number;
	/** The Level that unlocks it, or null if none does. */
	readonly level: number | null;
}

/** A fixed table, so a name never comes from content (`code-style.md`). */
const addOnNames = { loop: "Loop", collector: "Collector" } as const satisfies Record<
	AddOn,
	string
>;

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

	const owned = readEntry(farm, index, facility);
	if (owned === null) return `The ${facility.id} isn't bought.`;

	return { facility, owned };
}

/**
 * The farm's entry for a content facility: null until bought. Every farm has one entry per content
 * facility (ADR-0003, section 12), so a missing entry is a broken farm, a programmer error, and
 * throws a RangeError rather than refuse (D15).
 */
function readEntry(farm: FarmState, index: number, facility: FacilityRule): OwnedFacility | null {
	const entry = farm.facilities[index];
	if (entry === undefined) {
		throw new RangeError(
			`The farm has no entry for the ${facility.id}: its facilities don't match the content.`,
		);
	}

	return entry;
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

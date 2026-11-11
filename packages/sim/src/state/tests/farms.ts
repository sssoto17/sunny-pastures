// Farm generators for the property tests (ADR-0003, section 9, D10): a farm id and a run of
// actions at times, played from a new farm. Every farm the tests see is one the rules reached.
import fc from "fast-check";

import type { Action, FarmState, Sim } from "../../index.js";

/** One generated action: what, and how long after the farm's time (negative: before it). */
export interface TimedAction {
	readonly action: Action;
	readonly delay: number;
}

/** An action the rules accepted, with its server time: one entry of a farm's action log. */
export interface LoggedAction {
	readonly action: Action;
	readonly at: number;
}

/** An accepted action with the farm before and after it. */
export interface Transition extends LoggedAction {
	readonly before: FarmState;
	readonly after: FarmState;
}

/**
 * A played run: every farm it went through, the log of accepted actions, its transitions and the
 * reasons of the actions refused.
 */
export interface Run {
	readonly farms: readonly FarmState[];
	readonly log: readonly LoggedAction[];
	readonly transitions: readonly Transition[];
	readonly refusals: readonly string[];
	readonly final: FarmState;
}

/** The slice's plots: 6 at the start, and up to 14 with the ones bought (#83). */
const startPlots = 6;
const allPlots = Array.from({ length: 14 }, (_plot, i) => i);

/** Mostly a plot the farm can have, sometimes one out of range. */
const plotIndex = fc.oneof(
	{ weight: 9, arbitrary: fc.integer({ min: 0, max: 13 }) },
	{ weight: 1, arbitrary: fc.constantFrom(-1, 14, 15) },
);

/** The slice's facilities, the feed mill and the bakery (#84), and indexes out of range. */
const facilityIndex = fc.oneof(
	{ weight: 4, arbitrary: fc.constantFrom(0, 1) },
	{ weight: 1, arbitrary: fc.constantFrom(-1, 2) },
);

/** Mostly the slice's recipes, sometimes one the facility lacks or not in content. */
const recipe = fc.oneof(
	{ weight: 9, arbitrary: fc.constantFrom("chickenFeed", "bread") },
	{ weight: 1, arbitrary: fc.constant("cake") },
);

/**
 * Plant, harvest, buy, start jobs, collect and buy add-ons, on plots and facilities in and out of
 * range, mostly wheat, sometimes a crop not in content. A generated buy rarely names the next plot, so it mostly
 * reaches the refusals.
 */
const action: fc.Arbitrary<Action> = fc.oneof(
	fc.record({
		type: fc.constant("plant" as const),
		plot: plotIndex,
		crop: fc.oneof(
			{ weight: 9, arbitrary: fc.constant("wheat") },
			{ weight: 1, arbitrary: fc.constant("rye") },
		),
	}),
	fc.record({ type: fc.constant("harvest" as const), plot: plotIndex }),
	fc.record({ type: fc.constant("buyPlot" as const), plot: plotIndex }),
	fc.record({ type: fc.constant("buyFacility" as const), facility: facilityIndex }),
	fc.record({ type: fc.constant("startJob" as const), facility: facilityIndex, recipe }),
	fc.record({ type: fc.constant("collect" as const), facility: facilityIndex }),
	fc.record({
		type: fc.constant("buyAddOn" as const),
		facility: facilityIndex,
		addOn: fc.constantFrom("loop", "collector"),
	}),
);

/**
 * Delays: mostly within a grow time, so plots ripen at and around action times; sometimes long,
 * beyond 2^31 ms (D7); sometimes before the farm's time, which the rules refuse (MUST-14.7).
 */
export const delay = fc.oneof(
	{ weight: 6, arbitrary: fc.integer({ min: 0, max: 200_000 }) },
	{ weight: 1, arbitrary: fc.constantFrom(0, 120_000, 2 ** 31, 2 ** 31 + 1) },
	{ weight: 1, arbitrary: fc.integer({ min: 0, max: 2 ** 34 }) },
	{ weight: 1, arbitrary: fc.integer({ min: -100_000, max: -1 }) },
);

/**
 * Tending the field: plant every plot, wait, harvest every plot. Repeated, it fills the silo,
 * spends the coins and gains Levels, so the storage, coin and Level cases are reached (MUST-01.1,
 * 01.3, 05.4, 14.4). Plots the farm hasn't bought are refused and skipped.
 */
const tend = delay.map(tendFor);

function tendFor(wait: number): TimedAction[] {
	return [
		...allPlots.map((plot) => ({
			action: { type: "plant", plot, crop: "wheat" } as const,
			delay: 0,
		})),
		{ action: { type: "harvest", plot: 0 }, delay: Math.abs(wait) },
		...allPlots.slice(1).map((plot) => ({ action: { type: "harvest", plot } as const, delay: 0 })),
	];
}

const buyFacilities = [0, 1].map((facility): TimedAction => ({
	action: { type: "buyFacility", facility },
	delay: 0,
}));

/** Every add-on on both facilities (#88). */
const buyAddOns = [0, 1].flatMap((facility) =>
	(["collector", "loop"] as const).map((addOn): TimedAction => ({
		action: { type: "buyAddOn", facility, addOn },
		delay: 0,
	})),
);

/**
 * Buying plots, each next one in turn, then the facilities and their add-ons, so the farm buys as
 * many as its Level and coins allow, and the rest reach the Level, coin and maximum refusals
 * (MUST-05.6, 06.1).
 */
const expand: TimedAction[] = [
	...allPlots
		.slice(startPlots)
		.map((plot): TimedAction => ({ action: { type: "buyPlot", plot }, delay: 0 })),
	...buyFacilities,
	...buyAddOns,
];

/** Wheat's grow time in the slice (#82): tending with this wait harvests every plot planted. */
const growMs = 120_000;

/**
 * Automating the facilities, so automated steps tie (MUST-14.8): tend the field for wheat and
 * Levels, buy both facilities and their add-ons (mostly all four), start bread, then chicken feed
 * `offset` later, wait, and collect by hand. The offset is a whole number of feed jobs (60 s), so
 * while the feed mill's Loop runs, a feed job finishes at the same ms as the bread (300 s, then
 * every 300 s), with the barn as full as the feed moved so far: the Collectors compete for the
 * last barn space and the Loops for the last wheat at that ms. Jobs already queued shift the
 * times. The harness counts that generated farms reach these ties.
 */
const automate = fc
	.record({
		addOns: fc.oneof(
			{ weight: 3, arbitrary: fc.constant(buyAddOns) },
			{ weight: 2, arbitrary: fc.subarray(buyAddOns, { minLength: 1 }) },
		),
		offset: fc.constantFrom(0, 60_000, 120_000, 180_000, 240_000),
		wait: delay,
	})
	.map(({ addOns, offset, wait }): TimedAction[] => [
		...tendFor(growMs),
		...buyFacilities,
		...addOns,
		{ action: { type: "startJob", facility: 1, recipe: "bread" }, delay: 0 },
		{ action: { type: "startJob", facility: 0, recipe: "chickenFeed" }, delay: offset },
		{ action: { type: "collect", facility: 0 }, delay: Math.abs(wait) },
		{ action: { type: "collect", facility: 1 }, delay: 0 },
	]);

/**
 * Running the facilities: buy both (refused while locked or once bought), fill both queues and one
 * more (refused: full), wait, then collect each job. Jobs queue behind each other and finish while the farm waits, so the queue and input cases
 * are reached (MUST-03.2, 03.3, 03.5). With a small barn and XP enough to cross a Level, as the
 * harness's test content has, collects fill the barn, are refused once it is full and reach
 * Levels (MUST-03.4, 05.4, 14.4); the harness checks that they do. Facilities the farm hasn't
 * bought are refused and skipped.
 */
const produce = delay.map((wait): TimedAction[] => {
	const starts = (["chickenFeed", "bread"] as const).flatMap((made, facility) =>
		[0, 1, 2].map((): TimedAction => ({
			action: { type: "startJob", facility, recipe: made },
			delay: 0,
		})),
	);
	const collects = [0, 1, 0, 1].map((facility, i): TimedAction => ({
		action: { type: "collect", facility },
		delay: i === 0 ? Math.abs(wait) : 0,
	}));
	return [...buyFacilities, ...starts, ...collects];
});

/**
 * A first job: harvest one plot, buy the feed mill, run one job and collect it. On a new farm of
 * the harness's test content, whose harvests and jobs each give 31 XP, the collect takes the farm
 * from 31 XP to 62 and crosses Level 4's 60 (MUST-05.4): with every gain a multiple of 31, a
 * collect crosses a Level only from 31 or 93 XP, which longer chunks step over.
 */
const firstJob: TimedAction[] = [
	{ action: { type: "plant", plot: 0, crop: "wheat" }, delay: 0 },
	{ action: { type: "harvest", plot: 0 }, delay: growMs },
	{ action: { type: "buyFacility", facility: 0 }, delay: 0 },
	{ action: { type: "startJob", facility: 0, recipe: "chickenFeed" }, delay: 0 },
	{ action: { type: "collect", facility: 0 }, delay: 60_000 },
];

const chunk = fc.oneof(
	{ weight: 2, arbitrary: fc.array(fc.record({ action, delay }), { maxLength: 12 }) },
	{ weight: 2, arbitrary: tend },
	{ weight: 1, arbitrary: fc.constant(expand) },
	{ weight: 2, arbitrary: produce },
	{ weight: 2, arbitrary: automate },
	{ weight: 1, arbitrary: fc.constant(firstJob) },
);

export const timedActions = fc.array(chunk, { maxLength: 16 }).map((chunks) => chunks.flat());

export const farmId = fc.string({ unit: "binary", maxLength: 24 });

/** Plays `timedActions` from a new farm, keeping only the accepted actions in the log. */
export function play(sim: Sim, id: string, played: readonly TimedAction[]): Run {
	let farm = sim.newFarm(id);
	const farms = [farm];
	const transitions: Transition[] = [];
	const refusals: string[] = [];
	for (const { action: next, delay: wait } of played) {
		const at = farm.time + wait;
		const result = sim.apply(farm, next, at);
		if (!result.ok) {
			refusals.push(result.reason);
			continue;
		}

		transitions.push({ action: next, at, before: farm, after: result.state });
		farm = result.state;
		farms.push(farm);
	}
	const log = transitions.map(({ action: next, at }) => ({ action: next, at }));
	return { farms, log, transitions, refusals, final: farm };
}

/** Replays a log from `farm`; throws on a refusal, as ADR-0001's replay does. */
export function replay(sim: Sim, farm: FarmState, log: readonly LoggedAction[]): FarmState {
	return log.reduce((current, { action: next, at }) => {
		const result = sim.apply(current, next, at);
		if (!result.ok) throw new Error(`a logged action was refused: ${result.reason}`);

		return result.state;
	}, farm);
}

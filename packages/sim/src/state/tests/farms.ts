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

/** Mostly the slice's one pen (#86), sometimes one content doesn't have. */
const penIndex = fc.oneof(
	{ weight: 9, arbitrary: fc.constant(0) },
	{ weight: 1, arbitrary: fc.constantFrom(-1, 1) },
);

/** Mostly a slot the slice's board can have (3 to 7, #87), sometimes one out of range. */
const slotIndex = fc.oneof(
	{ weight: 9, arbitrary: fc.integer({ min: 0, max: 6 }) },
	{ weight: 1, arbitrary: fc.constantFrom(-1, 7, 9) },
);

/** Mostly the slice's recipes, sometimes one the facility lacks or not in content. */
const recipe = fc.oneof(
	{ weight: 9, arbitrary: fc.constantFrom("chickenFeed", "bread", "cookies") },
	{ weight: 1, arbitrary: fc.constant("cake") },
);

/** Mostly the slice's tiers above 1 (#85), sometimes one the facility has or content lacks. */
const tier = fc.oneof(
	{ weight: 4, arbitrary: fc.constantFrom(2, 3) },
	{ weight: 1, arbitrary: fc.constantFrom(1, 4) },
);

/**
 * Plant, harvest, buy, start jobs, buy tiers, collect and buy add-ons, on plots and facilities in
 * and out of range, mostly wheat, sometimes a crop not in content; buy, feed and collect from pens
 * in and out of range; deliver and discard orders in slots in and out of range. A generated buy
 * rarely names the next plot, so it mostly reaches the refusals.
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
	fc.record({ type: fc.constant("buyTier" as const), facility: facilityIndex, tier }),
	fc.record({ type: fc.constant("buyPen" as const), pen: penIndex }),
	fc.record({ type: fc.constant("feed" as const), pen: penIndex }),
	fc.record({ type: fc.constant("collectProducts" as const), pen: penIndex }),
	fc.record({ type: fc.constant("deliver" as const), slot: slotIndex }),
	fc.record({ type: fc.constant("discard" as const), slot: slotIndex }),
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

/** An action `times` times, all at the farm's time. */
const repeat = (action: Action, times: number): TimedAction[] =>
	Array.from({ length: times }, () => ({ action, delay: 0 }));

/** Two chicken feed jobs at the feed mill, collected after `wait` (#84). */
const makeFeed = (wait: number): TimedAction[] => [
	...repeat({ type: "startJob", facility: 0, recipe: "chickenFeed" }, 2),
	{ action: { type: "collect", facility: 0 }, delay: Math.abs(wait) },
	{ action: { type: "collect", facility: 0 }, delay: 0 },
];

/**
 * Keeping chickens: buy the feed mill and the pen, make feed, feed once per chicken and once more
 * for the trough, then make feed again before collecting the eggs, so the barn is often too full
 * for them, and collect again after feeding. Chickens lay, eat the next portion at the time they
 * lay, fill the barn and, with test content's egg XP, cross Levels (MUST-02, 05.4, 14.4). Refused
 * and skipped while the mill or pen is locked or unaffordable, the silo lacks wheat, the trough is
 * full or the barn has no feed or no room.
 */
const keepChickens = fc
	.tuple(delay, delay, delay)
	.map(([first, second, third]): TimedAction[] => [
		{ action: { type: "buyFacility", facility: 0 }, delay: 0 },
		{ action: { type: "buyPen", pen: 0 }, delay: 0 },
		...makeFeed(first),
		...repeat({ type: "feed", pen: 0 }, 4),
		...makeFeed(second),
		{ action: { type: "collectProducts", pen: 0 }, delay: 0 },
		...repeat({ type: "feed", pen: 0 }, 4),
		{ action: { type: "collectProducts", pen: 0 }, delay: Math.abs(third) },
	]);

/**
 * Upgrading the facilities (#85): buy both, start a job in each, buy tier 2 while it runs, start
 * another, buy tier 3, then start jobs past tier 1's slots until the queue is full and refused;
 * collect each job after a wait. So tiers are bought with jobs queued and running (MUST-03.3, 06.7)
 * and queues fill to a higher tier's slots (MUST-03.5, 06.2). Refused and skipped while a tier is
 * locked or unaffordable, or the silo lacks wheat.
 */
const buyTiers = delay.map((wait): TimedAction[] =>
	(["chickenFeed", "bread"] as const).flatMap((made, facility): TimedAction[] => {
		const start: TimedAction = { action: { type: "startJob", facility, recipe: made }, delay: 0 };
		return [
			{ action: { type: "buyFacility", facility }, delay: 0 },
			start,
			{ action: { type: "buyTier", facility, tier: 2 }, delay: 0 },
			start,
			{ action: { type: "buyTier", facility, tier: 3 }, delay: 0 },
			...repeat({ type: "startJob", facility, recipe: made }, 3),
			{ action: { type: "collect", facility }, delay: Math.abs(wait) },
			...repeat({ type: "collect", facility }, 2),
		];
	}),
);

/**
 * Baking cookies (#85, #72 D4), from the field up: tend the start's plots until they ripen, make
 * chicken feed, feed the chickens and collect their eggs once laid, then buy the bakery, try
 * cookies at its tier 1 (refused), buy its tier 2, start two cookies jobs and collect them after a
 * wait (MUST-03.1, 03.2). The waits that
 * ripen and lay are fixed, or random runs would rarely hold wheat and eggs at once. Refused and
 * skipped while the barn holds too few eggs or the bakery or its tier 2 is locked.
 */
const bake = delay.map((wait): TimedAction[] => {
	const plots = allPlots.slice(0, startPlots);
	return [
		...plots.map((plot): TimedAction => ({
			action: { type: "plant", plot, crop: "wheat" },
			delay: 0,
		})),
		...plots.map((plot, i): TimedAction => ({
			action: { type: "harvest", plot },
			delay: i === 0 ? 120_000 : 0,
		})),
		{ action: { type: "buyFacility", facility: 0 }, delay: 0 },
		{ action: { type: "buyPen", pen: 0 }, delay: 0 },
		...makeFeed(60_000),
		...repeat({ type: "feed", pen: 0 }, 4),
		{ action: { type: "collectProducts", pen: 0 }, delay: 180_000 },
		{ action: { type: "buyFacility", facility: 1 }, delay: 0 },
		{ action: { type: "startJob", facility: 1, recipe: "cookies" }, delay: 0 },
		{ action: { type: "buyTier", facility: 1, tier: 2 }, delay: 0 },
		...repeat({ type: "startJob", facility: 1, recipe: "cookies" }, 2),
		{ action: { type: "collect", facility: 1 }, delay: Math.abs(wait) },
		{ action: { type: "collect", facility: 1 }, delay: 0 },
	];
});

/** Delivering the order in every slot the board can have, at the farm's time. */
const deliverAll = Array.from({ length: 7 }, (_slot, slot): TimedAction => ({
	action: { type: "deliver", slot },
	delay: 0,
}));

/**
 * Trading (#87): plant the start's plots, deliver every order the farm can fill and discard one,
 * then harvest after `wait` and deliver again. Only the start's plots, so the chunk stays short:
 * the properties play every generated run at 1,000 runs in CI. Wheat orders are filled, the others mostly refused for a
 * short good; deliveries pay XP that crosses Levels and opens slots (MUST-04.1, 04.4). Planting
 * and delivering at one time make a refill fall with a ripening when the delivered delay is the
 * grow time, as the slice's is at Level 1 and 2, so the tie key is reached (MUST-10.6).
 */
const trade = fc.tuple(delay, slotIndex).map(([wait, slot]): TimedAction[] => {
	const plots = allPlots.slice(0, startPlots);
	return [
		...plots.map((plot) => ({ action: { type: "plant", plot, crop: "wheat" } as const, delay: 0 })),
		...deliverAll,
		{ action: { type: "discard", slot }, delay: 0 },
		{ action: { type: "harvest", plot: 0 }, delay: Math.abs(wait) },
		...plots.slice(1).map((plot) => ({ action: { type: "harvest", plot } as const, delay: 0 })),
		...deliverAll,
	];
});

const chunk = fc.oneof(
	{ weight: 2, arbitrary: fc.array(fc.record({ action, delay }), { maxLength: 12 }) },
	{ weight: 2, arbitrary: tend },
	{ weight: 1, arbitrary: fc.constant(expand) },
	{ weight: 2, arbitrary: produce },
	{ weight: 2, arbitrary: keepChickens },
	{ weight: 2, arbitrary: automate },
	{ weight: 2, arbitrary: buyTiers },
	{ weight: 2, arbitrary: bake },
	{ weight: 1, arbitrary: trade },
);

/**
 * Automating a new farm so its add-ons tie for storage (MUST-14.8, #213): the one farm whose silo
 * and barn a chunk knows is a new one, with both empty. Wheat leaves a silo only through jobs, whose
 * goods the barn soon stops, and wheat orders of random size, so no chunk can drain a played silo
 * to a known amount. Tending the start's 6 plots gives 2 wheat a plot, 3 with the bonus; each Loop
 * fills its facility's 2 slots at once, so bread takes 6, then chicken feed `offset` later takes 4,
 * and its first job finishes at 240 s or with the bread at 300 s:
 * - 180 s: the Collector has moved one feed job, so a barn of 4 has room for the bread but not
 *   both, and the bread's goods keep its slot: the Collectors tie for the last barn space.
 * - 240 s: a farm whose tending gave 13 or 14 wheat (about half) has 3 or 4 left, the feed mill
 *   restarts first and the bakery is short: the Loops tie for the last wheat.
 */
const automateNewFarm = fc
	.constantFrom(180_000, 240_000)
	.map((offset): TimedAction[] => [
		...tendFor(growMs),
		...buyFacilities,
		...buyAddOns,
		{ action: { type: "startJob", facility: 1, recipe: "bread" }, delay: 0 },
		{ action: { type: "startJob", facility: 0, recipe: "chickenFeed" }, delay: offset },
	]);

/** Chunks played from a new farm, sometimes starting with the add-ons' ties, which need it new. */
export const timedActions = fc
	.tuple(fc.oneof(fc.constant([]), automateNewFarm), fc.array(chunk, { maxLength: 16 }))
	.map(([first, chunks]) => [...first, ...chunks.flat()]);

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

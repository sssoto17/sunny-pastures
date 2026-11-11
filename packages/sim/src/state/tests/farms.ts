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

/** A played run: every farm it went through, the log of accepted actions and its transitions. */
export interface Run {
	readonly farms: readonly FarmState[];
	readonly log: readonly LoggedAction[];
	readonly transitions: readonly Transition[];
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

/**
 * Plant, harvest and buy on plots in and out of range, mostly wheat, sometimes a crop not in
 * content. A generated buy rarely names the next plot, so it mostly reaches the refusals.
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
const tend = delay.map((wait): TimedAction[] => [
	...allPlots.map((plot) => ({
		action: { type: "plant", plot, crop: "wheat" } as const,
		delay: 0,
	})),
	{ action: { type: "harvest", plot: 0 }, delay: Math.abs(wait) },
	...allPlots.slice(1).map((plot) => ({ action: { type: "harvest", plot } as const, delay: 0 })),
]);

/**
 * Buying plots: each next plot in turn, so the farm buys as many as its Level and coins allow,
 * and the rest reach the Level, coin and maximum refusals (MUST-06.1).
 */
const expand: TimedAction[] = allPlots
	.slice(startPlots)
	.map((plot) => ({ action: { type: "buyPlot", plot }, delay: 0 }));

const chunk = fc.oneof(
	{ weight: 2, arbitrary: fc.array(fc.record({ action, delay }), { maxLength: 12 }) },
	{ weight: 2, arbitrary: tend },
	{ weight: 1, arbitrary: fc.constant(expand) },
);

export const timedActions = fc.array(chunk, { maxLength: 16 }).map((chunks) => chunks.flat());

export const farmId = fc.string({ unit: "binary", maxLength: 24 });

/** Plays `timedActions` from a new farm, keeping only the accepted actions in the log. */
export function play(sim: Sim, id: string, played: readonly TimedAction[]): Run {
	let farm = sim.newFarm(id);
	const farms = [farm];
	const transitions: Transition[] = [];
	for (const { action: next, delay: wait } of played) {
		const at = farm.time + wait;
		const result = sim.apply(farm, next, at);
		if (!result.ok) continue;

		transitions.push({ action: next, at, before: farm, after: result.state });
		farm = result.state;
		farms.push(farm);
	}
	const log = transitions.map(({ action: next, at }) => ({ action: next, at }));
	return { farms, log, transitions, final: farm };
}

/** Replays a log from `farm`; throws on a refusal, as ADR-0001's replay does. */
export function replay(sim: Sim, farm: FarmState, log: readonly LoggedAction[]): FarmState {
	return log.reduce((current, { action: next, at }) => {
		const result = sim.apply(current, next, at);
		if (!result.ok) throw new Error(`a logged action was refused: ${result.reason}`);

		return result.state;
	}, farm);
}

// MUST-14.8 (ADR-0003, section 9): generated farms line automated steps up on the same ms, where
// the Collectors compete for the last barn space and the Loops for the last wheat (#88). Splitting
// advance at that ms, or building the same farm in another internal order, gives the same hash.
import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { createSim, sliceContent, stateHash } from "../../index.js";
import type { Content, FarmState, Sim } from "../../index.js";
import { delay, farmId, play, timedActions } from "../../state/tests/farms.js";
import { richContent } from "./richContent.js";

const params = inject("fastCheck");

const slice: Content = sliceContent;

/**
 * The test content with the slice's job times (60 s feed, 300 s bread), so the generator's
 * automation chunk lines finishes up on the same ms, and 31 XP a harvest, so its one tending
 * reaches the add-ons' Levels; #85's 61 s feed and 9 XP are for its rounding and Level cases.
 */
const tieContent: Content = {
	...richContent,
	crops: { wheat: { ...sliceContent.crops.wheat, xp: 31 } },
	facilities: richContent.facilities.map((facility, i) => ({
		...facility,
		recipes: Object.fromEntries(
			Object.entries(facility.recipes).map(([id, recipe]) => [
				id,
				{ ...recipe, seconds: slice.facilities[i]?.recipes[id]?.seconds ?? NaN },
			]),
		),
	})),
};

/**
 * Its 4-good barn makes the Collectors compete for the last space; with room for 20, the barn
 * holds the Loops back less and they compete for the last wheat.
 */
const contents = [
	["a barn of 4", tieContent],
	["a barn of 20", { ...tieContent, barn: { capacity: 20 } }],
] as const;

/** Each facility's one recipe in content, by facility: the wheat it takes and the goods it makes. */
const [feedMade = { wheat: NaN, goods: NaN }, breadMade = { wheat: NaN, goods: NaN }] = (
	["chickenFeed", "bread"] as const
).map((id, i) => {
	const recipe = richContent.facilities[i]?.recipes[id];
	const wheat = recipe?.inputs.find(({ good }) => good === "wheat")?.amount ?? NaN;
	return { wheat, goods: recipe?.output.amount ?? NaN };
});

/** A ms at which jobs in both facilities finish, from the farm it was found on. */
interface Tie {
	readonly at: number;
	readonly from: FarmState;
}

/** The sim for one content, and what the tie checks read from it. */
interface World {
	readonly sim: Sim;
	readonly barnCapacity: number;
}

const makeWorld = (content: Content): World => ({
	sim: createSim(content),
	barnCapacity: content.barn.capacity,
});

/**
 * The ms at or before `to` at which jobs in both facilities finish, walking `farm`'s job finishes
 * in time order with advance, which MUST-14.1 makes the same as one advance.
 */
function findTies({ sim }: World, farm: FarmState, to: number): Tie[] {
	const ties: Tie[] = [];
	for (let current = farm; ;) {
		const ends = current.facilities.map((owned) =>
			(owned?.jobs ?? []).flatMap((job) => (job.status === "running" ? [job.readyAt] : [])),
		);
		const next = Math.min(...ends.flat());
		if (!(next <= to)) return ties;

		if (ends.every((times) => times.includes(next))) ties.push({ at: next, from: farm });
		current = sim.advance(current, next);
	}
}

/** Every tie in a played run: between its actions, and after its last one, up to `wait` later. */
function findRunTies(
	world: World,
	id: string,
	played: Parameters<typeof play>[2],
	wait: number,
): Tie[] {
	const { transitions, final } = play(world.sim, id, played);
	return [
		...transitions.flatMap(({ before, at }) => findTies(world, before, at)),
		...findTies(world, final, final.time + Math.abs(wait)),
	];
}

const wheatIn = (farm: FarmState): number => farm.silo["wheat"] ?? 0;
const barnRoom = ({ barnCapacity }: World, farm: FarmState): number =>
	barnCapacity - Object.values(farm.barn).reduce((total, held) => total + held, 0);

/**
 * What a tie competes for, from the farm a ms before it and at it. The Collectors compete for the
 * last barn space when both have one and the room holds one facility's goods but not both. The
 * Loops compete for the last wheat only where the order decides: both have one, the silo holds
 * the bakery's wheat but not both recipes', the feed mill (ranked first by index) restarts, and the
 * bakery is left with a free slot, stopped by the wheat alone: a Loop's limits are its queue and
 * its inputs, never the barn (the admin, 11 Nov). A Collector
 * stops a Loop when the facility whose goods didn't fit has a Loop: its goods keep the slot
 * (ADR-0003, sections 2 and 14).
 */
function classify(world: World, { at, from }: Tie): string[] {
	const { sim } = world;
	const before = sim.advance(from, at - 1);
	const after = sim.advance(from, at);
	const owned = before.facilities;
	const both = (addOn: "loop" | "collector"): boolean =>
		owned.every((facility) => facility?.addOns[addOn] === true);
	const room = barnRoom(world, before);
	const isForBarn =
		both("collector") && room >= breadMade.goods && room < feedMade.goods + breadMade.goods;
	const bakeryJobs = after.facilities[1]?.jobs.length ?? 2;
	const isForWheat =
		both("loop") &&
		wheatIn(before) >= breadMade.wheat &&
		wheatIn(before) < feedMade.wheat + breadMade.wheat &&
		wheatIn(after) === wheatIn(before) - feedMade.wheat &&
		bakeryJobs < 2;
	const isLoopStopped =
		isForBarn &&
		after.facilities.some(
			(facility) => facility?.addOns.loop === true && facility.jobs[0]?.status === "done",
		);
	return [
		"tie",
		...(isForBarn ? ["Collectors tie for the last barn space"] : []),
		...(isForWheat ? ["Loops tie for the last wheat"] : []),
		...(isLoopStopped ? ["a Collector's waiting goods stop a Loop at the tie"] : []),
	];
}

/** The same farm with every object's keys in reverse order, an order the rules mustn't read. */
function reverseKeys(farm: FarmState): FarmState {
	return JSON.parse(JSON.stringify(farm), (_key, value: unknown) =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).reverse())
			: value,
	) as FarmState;
}

describe.each(contents)(
	"MUST-14.8: automated steps at the same ms, competing for storage, with %s",
	(_name, content) => {
		const world = makeWorld(content);
		const { sim } = world;

		/** Checks every tie in the generated runs, with the run's last wait. */
		const forEachTie = (check: (tie: Tie, wait: number) => void): void => {
			fc.assert(
				fc.property(farmId, timedActions, delay, (id, played, wait) => {
					for (const tie of findRunTies(world, id, played, wait)) check(tie, wait);
				}),
				params,
			);
		};

		it("give the same hash when advance is split at the tie, or a ms before it, or the farm's keys are in another order", () => {
			forEachTie(({ at, from }, wait) => {
				const to = at + Math.abs(wait);
				const whole = stateHash(sim.advance(from, to));

				expect(stateHash(sim.advance(sim.advance(from, at), to))).toBe(whole);
				expect(stateHash(sim.advance(sim.advance(from, at - 1), to))).toBe(whole);
				expect(stateHash(sim.advance(reverseKeys(from), to))).toBe(whole);
			});
		});

		it("give the last barn space to the lower facility index: the feed mill's goods move whenever there is room for them (MUST-10.6)", () => {
			forEachTie(({ at, from }) => {
				const before = sim.advance(from, at - 1);
				const isEachCollecting = before.facilities.every((owned) => owned?.addOns.collector);
				if (!isEachCollecting || barnRoom(world, before) < feedMade.goods) return;

				// The feed mill's oldest job, waiting or finishing now, has room, so it moves at the tie
				// whatever the bakery's goods would take.
				const after = sim.advance(from, at);
				const feed = (farm: FarmState): number => farm.barn["chickenFeed"] ?? 0;
				expect(feed(after)).toBeGreaterThanOrEqual(feed(before) + feedMade.goods);
			});
		});
	},
);

describe("the generated ties", () => {
	it("are reached by the generated farms over both contents, so MUST-14.8 isn't vacuous", () => {
		const counts = new Map<string, number>();
		const worlds = contents.map(([, content]) => makeWorld(content));
		for (const [id, played, wait] of fc.sample(fc.tuple(farmId, timedActions, delay), params)) {
			for (const world of worlds) {
				const ties = findRunTies(world, id, played, wait);
				for (const key of new Set(ties.flatMap((tie) => classify(world, tie)))) {
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
		}

		for (const key of [
			"tie",
			"Collectors tie for the last barn space",
			"Loops tie for the last wheat",
			"a Collector's waiting goods stop a Loop at the tie",
		]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThan(0);
		}
	});
});

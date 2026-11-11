// MUST-14.8 (ADR-0003, section 9): generated farms line automated steps up on the same ms, where
// the Collectors compete for the last barn space and the Loops for the last wheat (#88). Splitting
// advance at that ms, or building the same farm in another internal order, gives the same hash.
import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { createSim, stateHash } from "../../index.js";
import type { Content, FarmState, Sim } from "../../index.js";
import { delay, farmId, play, timedActions } from "../../state/tests/farms.js";
import { richContent } from "./richContent.js";

const params = inject("fastCheck");

/**
 * The test content, whose 4-good barn makes the Collectors compete for the last space, and one
 * with room for 20, where the barn holds the Loops back less and they compete for the last wheat.
 */
const contents = [
	["a barn of 4", richContent],
	["a barn of 20", { ...richContent, barn: { capacity: 20 } }],
] as const;

/** The slice's recipes (#84), by facility: the wheat each takes and the goods it makes. */
const made = [
	{ wheat: 2, goods: 2 },
	{ wheat: 3, goods: 1 },
] as const;

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
 * the bakery's 3 but not both recipes' 5, the feed mill (ranked first by index) restarts, and the
 * bakery is left with a free slot and room for its bread, stopped by the wheat alone. A Collector
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
		both("collector") && room >= made[1].goods && room < made[0].goods + made[1].goods;
	const bakeryJobs = after.facilities[1]?.jobs.length ?? 2;
	const isForWheat =
		both("loop") &&
		wheatIn(before) >= made[1].wheat &&
		wheatIn(before) < made[0].wheat + made[1].wheat &&
		wheatIn(after) === wheatIn(before) - made[0].wheat &&
		bakeryJobs < 2 &&
		barnRoom(world, after) >= (bakeryJobs + 1) * made[1].goods;
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

		it("give the same hash when advance is split at the tie, or a ms before it, or the farm's keys are in another order", () => {
			fc.assert(
				fc.property(farmId, timedActions, delay, (id, played, wait) => {
					for (const { at, from } of findRunTies(world, id, played, wait)) {
						const to = at + Math.abs(wait);
						const whole = stateHash(sim.advance(from, to));

						expect(stateHash(sim.advance(sim.advance(from, at), to))).toBe(whole);
						expect(stateHash(sim.advance(sim.advance(from, at - 1), to))).toBe(whole);
						expect(stateHash(sim.advance(reverseKeys(from), to))).toBe(whole);
					}
				}),
				params,
			);
		});

		it("give the last barn space to the lower facility index: the feed mill's goods move if they fit (MUST-10.6)", () => {
			fc.assert(
				fc.property(farmId, timedActions, delay, (id, played, wait) => {
					for (const { at, from } of findRunTies(world, id, played, wait)) {
						const before = sim.advance(from, at - 1);
						const isEachCollecting = before.facilities.every((owned) => owned?.addOns.collector);
						if (!isEachCollecting || barnRoom(world, before) < made[0].goods) continue;

						// The feed mill's oldest job, waiting or finishing now, fits, so it moves at the tie
						// whatever the bakery's goods would take.
						const after = sim.advance(from, at);
						const feed = (farm: FarmState): number => farm.barn["chickenFeed"] ?? 0;
						expect(feed(after)).toBeGreaterThanOrEqual(feed(before) + made[0].goods);
					}
				}),
				params,
			);
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

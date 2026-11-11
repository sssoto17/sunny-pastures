// MUST-14.8 (ADR-0003, section 9): generated farms line automated steps up on the same ms, where
// the Collectors compete for the last barn space and the Loops for the last wheat (#88). Splitting
// advance at that ms, or building the same farm in another internal order, gives the same hash.
import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { createSim, stateHash } from "../../index.js";
import type { FarmState } from "../../index.js";
import { delay, farmId, play, timedActions } from "../../state/tests/farms.js";
import { richContent } from "./richContent.js";

const params = inject("fastCheck");
const sim = createSim(richContent);

/** The slice's recipes (#84), by facility: the wheat each takes and the goods it makes. */
const made = [
	{ wheat: 2, goods: 2 },
	{ wheat: 3, goods: 1 },
] as const;
const barnCapacity = 4;

/** A ms at which jobs in both facilities finish, from the farm it was found on. */
interface Tie {
	readonly at: number;
	readonly from: FarmState;
}

/**
 * The ms at or before `to` at which jobs in both facilities finish, walking `farm`'s job finishes
 * in time order with advance, which MUST-14.1 makes the same as one advance.
 */
function findTies(farm: FarmState, to: number): Tie[] {
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
function findRunTies(id: string, played: Parameters<typeof play>[2], wait: number): Tie[] {
	const { transitions, final } = play(sim, id, played);
	return [
		...transitions.flatMap(({ before, at }) => findTies(before, at)),
		...findTies(final, final.time + Math.abs(wait)),
	];
}

const wheatIn = (farm: FarmState): number => farm.silo["wheat"] ?? 0;
const barnRoom = (farm: FarmState): number =>
	barnCapacity - Object.values(farm.barn).reduce((total, held) => total + held, 0);

/**
 * What a tie competes for, from the farm a ms before it and at it. The Collectors compete for the
 * last barn space when both have one and the room holds one facility's goods but not both. The
 * Loops compete for the last wheat when both have one, the silo holds one recipe's wheat but not
 * both, and one Loop is left with a free slot it can't fill. A Collector stops a Loop when the
 * facility whose goods didn't fit has a Loop: its goods keep the slot (ADR-0003, sections 2 and 13).
 */
function classify({ at, from }: Tie): string[] {
	const before = sim.advance(from, at - 1);
	const after = sim.advance(from, at);
	const owned = before.facilities;
	const both = (addOn: "loop" | "collector"): boolean =>
		owned.every((facility) => facility?.addOns[addOn] === true);
	const room = barnRoom(before);
	const isForBarn =
		both("collector") && room >= made[1].goods && room < made[0].goods + made[1].goods;
	const isForWheat =
		both("loop") &&
		wheatIn(before) >= made[0].wheat &&
		wheatIn(before) < made[0].wheat + made[1].wheat &&
		after.facilities.some(
			(facility, i) => (facility?.jobs.length ?? 2) < 2 && wheatIn(after) < (made[i]?.wheat ?? 0),
		);
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

describe("MUST-14.8: automated steps at the same ms, competing for storage", () => {
	it("give the same hash when advance is split at the tie, or a ms before it, or the farm's keys are in another order", () => {
		fc.assert(
			fc.property(farmId, timedActions, delay, (id, played, wait) => {
				for (const { at, from } of findRunTies(id, played, wait)) {
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

	it("are reached by the generated farms, so the property isn't vacuous", () => {
		const counts = new Map<string, number>();
		for (const [id, played, wait] of fc.sample(fc.tuple(farmId, timedActions, delay), params)) {
			for (const key of new Set(findRunTies(id, played, wait).flatMap(classify))) {
				counts.set(key, (counts.get(key) ?? 0) + 1);
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

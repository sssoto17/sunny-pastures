import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { FarmState } from "../../index.js";
import { applyAll } from "./applyAll.js";
import { farmAt, xpOfLevel } from "./farmAt.js";
import { ownedFacility } from "./ownedFacility.js";
import { bakery, breadMs, feedMill, feedMs, startBread, startFeed } from "./sliceJobs.js";

const sim = createSim(sliceContent);
const collector = { addOns: { loop: false, collector: true } } as const;

/** A Level 4 farm with `wheat` and `barn`, and a Collector in both facilities. */
const collecting = (wheat: number, barn: Record<string, number> = {}): FarmState => ({
	...farmAt(4, 0),
	silo: { wheat },
	barn,
	facilities: [ownedFacility([], collector), ownedFacility([], collector)],
});

const done = { status: "done", recipe: "chickenFeed" } as const;

/** A full barn, and two feed jobs waiting for room in the feed mill. */
const fullBarn: FarmState = {
	...collecting(0, { bread: 50 }),
	facilities: [ownedFacility([done, done], collector), ownedFacility([], collector)],
};

describe("the Collector", () => {
	it("moves a job's goods into the barn as it finishes, not a ms before, with its XP (MUST-06.6)", () => {
		const farm = applyAll(collecting(4), [
			[startFeed, 0],
			[startFeed, 0],
		]);

		expect(sim.advance(farm, feedMs - 1).barn).toEqual({});
		const moved = sim.advance(farm, feedMs);
		expect(moved.barn).toEqual({ chickenFeed: 2 });
		expect(moved.xp).toBe(xpOfLevel(4) + 1);
		expect(moved.facilities[feedMill]?.jobs).toEqual([
			{ status: "running", recipe: "chickenFeed", readyAt: 2 * feedMs },
		]);
		expect(sim.advance(farm, 2 * feedMs).barn).toEqual({ chickenFeed: 4 });
	});

	it("leaves goods that don't fit waiting in the facility, as a done job (MUST-06.6, 07.2)", () => {
		const farm = applyAll(collecting(2, { bread: 49 }), [[startFeed, 0]]);
		const advanced = sim.advance(farm, feedMs);

		expect(advanced.barn).toEqual({ bread: 49 });
		expect(advanced.xp).toBe(xpOfLevel(4));
		expect(advanced.facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
		]);
	});

	it("moves waiting goods first, oldest first, when the facility's next job finishes", () => {
		const waiting = {
			...collecting(2, { bread: 47 }),
			facilities: [
				ownedFacility([{ status: "done", recipe: "chickenFeed" }], collector),
				ownedFacility([], collector),
			],
		};
		const farm = applyAll(waiting, [[startFeed, 0]]);
		const advanced = sim.advance(farm, feedMs);

		// Room for 3: the waiting job's 2 feed move, and the new job's 2 wait behind them.
		expect(advanced.barn).toEqual({ bread: 47, chickenFeed: 2 });
		expect(advanced.facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
		]);
	});

	it("moves every waiting job that fits in one step once the barn has room, with their XP", () => {
		const held = sim.advance(fullBarn, feedMs);
		expect(held.facilities[feedMill]?.jobs).toEqual([done, done]);

		// Room for 4 (an order delivered, say): both jobs' 2 feed move at that time, in one step.
		const moved = sim.advance({ ...held, barn: { bread: 46 } }, feedMs);
		expect(moved.barn).toEqual({ bread: 46, chickenFeed: 4 });
		expect(moved.xp).toBe(xpOfLevel(4) + 2);
		expect(moved.facilities[feedMill]?.jobs).toEqual([]);
	});

	it("throws on a Collector in a facility that isn't in content, a programmer error (D15)", () => {
		const running = { status: "running", recipe: "chickenFeed", readyAt: feedMs } as const;
		const broken = {
			...collecting(0),
			facilities: [ownedFacility(), ownedFacility(), ownedFacility([running], collector)],
		};

		expect(() => sim.advance(broken, feedMs)).toThrow(
			new RangeError("The farm has a Collector on facility 3, which isn't in content."),
		);
	});

	it("gives the last barn space to the lower facility index when two finish at the same ms (MUST-10.6)", () => {
		// The feed mill's job starts 240 s after the bread, so both finish at 300 s.
		const farm = applyAll(collecting(5, { bread: 48 }), [
			[startBread, 0],
			[startFeed, breadMs - feedMs],
		]);
		const advanced = sim.advance(farm, breadMs);

		expect(advanced.barn).toEqual({ bread: 48, chickenFeed: 2 });
		expect(advanced.facilities[feedMill]?.jobs).toEqual([]);
		expect(advanced.facilities[bakery]?.jobs).toEqual([{ status: "done", recipe: "bread" }]);
	});

	it("moves goods already waiting when it's bought, at that time, if the barn has room (MUST-06.6)", () => {
		const done = {
			...collecting(0),
			facilities: [
				ownedFacility([{ status: "done", recipe: "chickenFeed" }]),
				ownedFacility([], collector),
			],
		};
		const farm = applyAll({ ...done, xp: xpOfLevel(5), coins: 60 }, [
			[{ type: "buyAddOn", facility: feedMill, addOn: "collector" }, 5_000],
		]);

		// apply ran the move due at its time, so advancing to that time changes nothing (MUST-14.2).
		expect(farm.facilities[feedMill]?.jobs).toEqual([]);
		expect(farm.barn).toEqual({ chickenFeed: 2 });
		expect(sim.advance(farm, 5_000)).toBe(farm);
	});

	it("moves goods that waited for room once the barn has room again, in their order (MUST-06.6, 07.2)", () => {
		const held = sim.advance(fullBarn, 1_000_000);
		expect(held.facilities[feedMill]?.jobs).toEqual([done, done]);

		// Room for 3 (an order delivered, say): the oldest job's 2 feed move, the next waits.
		const room = sim.advance({ ...held, barn: { bread: 47 } }, 1_000_000);
		expect(room.barn).toEqual({ bread: 47, chickenFeed: 2 });
		expect(room.facilities[feedMill]?.jobs).toEqual([done]);
	});

	it("leaves a facility without one to finish its jobs for collecting by hand (MUST-03.4)", () => {
		const farm = applyAll({ ...collecting(2), facilities: [ownedFacility(), null] }, [
			[startFeed, 0],
		]);

		expect(sim.advance(farm, feedMs).facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
		]);
		expect(sim.advance(farm, feedMs).barn).toEqual({});
	});
});

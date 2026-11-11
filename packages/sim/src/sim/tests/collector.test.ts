import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { FarmState } from "../../index.js";
import { farmAt, xpOfLevel } from "./farmAt.js";
import { ownedFacility } from "./ownedFacility.js";
import { applyAll, bakery, breadMs, feedMill, feedMs, startBread, startFeed } from "./sliceJobs.js";

const sim = createSim(sliceContent);
const collector = { addOns: { loop: false, collector: true } } as const;

/** A Level 4 farm with `wheat` and `barn`, and a Collector in both facilities. */
const collecting = (wheat: number, barn: Record<string, number> = {}): FarmState => ({
	...farmAt(4, 0),
	silo: { wheat },
	barn,
	facilities: [ownedFacility([], collector), ownedFacility([], collector)],
});

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

	it("moves both the waiting goods and the new job's, when the barn has room for them", () => {
		const waiting = {
			...collecting(2),
			facilities: [
				ownedFacility([{ status: "done", recipe: "chickenFeed" }], collector),
				ownedFacility([], collector),
			],
		};
		const advanced = sim.advance(applyAll(waiting, [[startFeed, 0]]), feedMs);

		// Room for 4 in an empty barn of 50: both jobs' 2 feed move in one step, with their XP.
		expect(advanced.barn).toEqual({ chickenFeed: 4 });
		expect(advanced.xp).toBe(xpOfLevel(4) + 2);
		expect(advanced.facilities[feedMill]?.jobs).toEqual([]);
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

	it("doesn't move goods that were done before it was bought: it works from the next finish (MUST-06.7)", () => {
		const done = {
			...collecting(0),
			facilities: [
				ownedFacility([{ status: "done", recipe: "chickenFeed" }]),
				ownedFacility([], collector),
			],
		};
		const farm = applyAll({ ...done, xp: xpOfLevel(5), coins: 60 }, [
			[{ type: "buyAddOn", facility: feedMill, addOn: "collector" }, 0],
		]);

		expect(sim.advance(farm, 1_000_000).facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
		]);
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

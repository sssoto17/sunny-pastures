import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { AddOn, Content, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { farmAt, xpOfLevel } from "./farmAt.js";
import { ownedFacility } from "./ownedFacility.js";

const sim = createSim(sliceContent);
const feedMill = 0;
const bakery = 1;

/** A farm at `level` with `coins` and both facilities bought. */
const workshop = (level: number, coins: number): FarmState => ({
	...farmAt(level, coins),
	facilities: [ownedFacility(), ownedFacility()],
});

const buy = (facility: number, addOn: AddOn) => ({ type: "buyAddOn", facility, addOn }) as const;

describe("buying an add-on", () => {
	it("adds the Collector to one facility for 60 coins at Level 4 (MUST-05.6, 06.6)", () => {
		const farm = expectAccepted(sim.apply(workshop(4, 100), buy(bakery, "collector"), 0));

		expect(farm.facilities).toEqual([
			ownedFacility(),
			ownedFacility([], { addOns: { loop: false, collector: true } }),
		]);
		expect(farm.coins).toBe(40);
		expect(farm.xp).toBe(xpOfLevel(4));
	});

	it("adds the Loop to one facility for 80 coins at Level 5, beside its Collector (MUST-06.5)", () => {
		const farm = expectAccepted(
			sim.apply(
				expectAccepted(sim.apply(workshop(5, 140), buy(feedMill, "collector"), 0)),
				buy(feedMill, "loop"),
				0,
			),
		);

		expect(farm.facilities[feedMill]).toEqual(
			ownedFacility([], { addOns: { loop: true, collector: true } }),
		);
		expect(farm.facilities[bakery]).toEqual(ownedFacility());
		expect(farm.coins).toBe(0);
	});

	it.each([
		[
			"for an add-on not in content",
			workshop(5, 1_000),
			buy(feedMill, "sprinkler" as AddOn),
			"There is no add-on sprinkler.",
		],
		[
			"before its Level",
			workshop(4, 1_000),
			buy(feedMill, "loop"),
			"The feedMill's Loop isn't unlocked: it unlocks at Level 5, and you're at Level 4.",
		],
		[
			"with too few coins",
			workshop(4, 59),
			buy(bakery, "collector"),
			"The bakery's Collector costs 60 coins, and the farm has 59.",
		],
		[
			"for a facility not bought",
			{ ...workshop(5, 1_000), facilities: [null, ownedFacility()] },
			buy(feedMill, "collector"),
			"The feedMill isn't bought.",
		],
		[
			"for a facility not in content",
			workshop(5, 1_000),
			buy(2, "collector"),
			"There is no facility 3.",
		],
	])("is refused %s", (_name, farm, action, reason) => {
		const refused = sim.apply(farm, action, 0);

		expect(refused).toEqual({ ok: false, reason });
	});

	it("is refused for an add-on the facility has, so an action sent twice buys it once", () => {
		const farm = expectAccepted(sim.apply(workshop(5, 1_000), buy(bakery, "loop"), 0));

		expect(sim.apply(farm, buy(bakery, "loop"), 0)).toEqual({
			ok: false,
			reason: "The bakery already has a Loop.",
		});
	});

	it("is refused for an add-on no Level unlocks", () => {
		const content: Content = {
			...sliceContent,
			levels: sliceContent.levels.map((level) => ({ ...level, addOns: [] })),
		};
		const locked = createSim(content);
		const farm = { ...workshop(5, 1_000), xp: 1_000 };

		expect(locked.apply(farm, buy(feedMill, "collector"), 0)).toEqual({
			ok: false,
			reason: "The feedMill's Collector isn't unlocked at any Level.",
		});
	});
});

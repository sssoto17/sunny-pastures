import { describe, expect, it } from "vitest";

import { listRewards } from "../rewards";

describe("listRewards", () => {
	it("reads Level 2 of the slice's Level table into its coins and unlocks", () => {
		expect(listRewards(2, 2)).toEqual([
			{
				level: 2,
				coins: 20,
				unlocks: [
					"Feed mill, unlocked to buy",
					"Chicken pen, unlocked to buy",
					"2 more plots to buy",
					"1 more order slot on the order board",
					"Orders may now ask for chicken feed and eggs",
				],
			},
		]);
	});

	it("names tiers and add-ons, as Level 5 unlocks them", () => {
		expect(listRewards(5, 5)).toEqual([
			{
				level: 5,
				coins: 50,
				unlocks: [
					"Feed mill tier 3, unlocked to buy",
					"Bakery tier 3, unlocked to buy",
					"The Loop add-on, unlocked to buy",
					"2 more plots to buy",
					"1 more order slot on the order board",
				],
			},
		]);
	});

	it("names crops, as Level 1 unlocks wheat", () => {
		expect(listRewards(1, 1)[0]?.unlocks).toEqual([
			"Wheat, unlocked to plant",
			"3 more order slots on the order board",
			"Orders may now ask for wheat",
		]);
	});

	it("lists each Level from the first to the last, in order", () => {
		expect(listRewards(2, 4).map((reward) => reward.level)).toEqual([2, 3, 4]);
	});

	it("lists nothing past the top Level", () => {
		expect(listRewards(6, 9)).toEqual([]);
	});
});

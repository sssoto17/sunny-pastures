import { describe, expect, it } from "vitest";

import { sliceContent } from "../../content/index.js";
import { createSim } from "../../sim/index.js";
import type { FarmState } from "../../state/index.js";
import { prepareStorageRules, put, take } from "../index.js";

const rules = prepareStorageRules(sliceContent);
const newFarm = createSim(sliceContent).newFarm("farm-1");
const farmWith = (silo: FarmState["silo"], barn: FarmState["barn"]): FarmState => ({
	...newFarm,
	silo,
	barn,
});

describe("put", () => {
	it("adds a crop to the silo and any other good to the barn (MUST-06.4)", () => {
		const farm = farmWith({ wheat: 1 }, {});
		const withWheat = put(farm, { good: "wheat", amount: 2 }, "the harvest", rules);
		const withBread = put(farm, { good: "bread", amount: 1 }, "the job", rules);

		expect(withWheat).toEqual({ ok: true, state: farmWith({ wheat: 3 }, {}) });
		expect(withBread).toEqual({ ok: true, state: farmWith({ wheat: 1 }, { bread: 1 }) });
	});

	it("fills a store to exactly its capacity", () => {
		const farm = farmWith({ wheat: 40 }, { bread: 45 });

		expect(put(farm, { good: "wheat", amount: 10 }, "the harvest", rules).ok).toBe(true);
		expect(put(farm, { good: "chickenFeed", amount: 5 }, "the job", rules).ok).toBe(true);
	});

	it.each([
		[
			"the silo",
			farmWith({ wheat: 49 }, {}),
			{ good: "wheat", amount: 2 },
			"the harvest",
			"The silo has room for 1 more crop, and the harvest needs room for 2 wheat.",
		],
		[
			"the barn",
			farmWith({ wheat: 49 }, { chickenFeed: 47 }),
			{ good: "bread", amount: 4 },
			"collecting the job",
			"The barn has room for 3 more goods, and collecting the job needs room for 4 bread.",
		],
	])("is refused if %s can't hold it all (MUST-03.4)", (_name, farm, goods, what, reason) => {
		expect(put(farm, goods, what, rules)).toEqual({ ok: false, reason });
	});
});

describe("take", () => {
	it("removes every input from its store, and drops a good's key at 0", () => {
		const farm = farmWith({ wheat: 5 }, { chickenFeed: 2, bread: 1 });
		const inputs = [
			{ good: "wheat", amount: 3 },
			{ good: "chickenFeed", amount: 2 },
		];

		expect(take(farm, inputs, "Making cake", rules)).toEqual({
			ok: true,
			state: farmWith({ wheat: 2 }, { bread: 1 }),
		});
	});

	it("is refused, naming the first input in list order that is short", () => {
		const farm = farmWith({ wheat: 1 }, {});
		const inputs = [
			{ good: "chickenFeed", amount: 1 },
			{ good: "wheat", amount: 2 },
		];

		expect(take(farm, inputs, "Making cake", rules)).toEqual({
			ok: false,
			reason: "Making cake needs 1 chickenFeed, and the barn has 0.",
		});
	});

	it("counts an input listed twice against the store once in all", () => {
		const farm = farmWith({ wheat: 3 }, {});
		const inputs = [
			{ good: "wheat", amount: 2 },
			{ good: "wheat", amount: 2 },
		];

		expect(take(farm, inputs, "Making bread", rules)).toEqual({
			ok: false,
			reason: "Making bread needs 2 wheat, and the silo has 1.",
		});
	});
});

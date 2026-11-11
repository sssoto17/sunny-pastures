import { describe, expect, it } from "vitest";

import { advanceFarm, compareSteps } from "../index.js";
import type { AutomatedStep, StepSource } from "../index.js";

const makeStep = (at: number, index: number, slot = 0): AutomatedStep => ({
	at,
	kind: "ripen",
	index,
	slot,
});

describe("compareSteps", () => {
	it("orders by time, then index, then slot (MUST-10.6)", () => {
		const steps = [makeStep(20, 0), makeStep(10, 3, 1), makeStep(10, 3, 0), makeStep(10, 1, 5)];

		expect([...steps].sort(compareSteps)).toEqual([
			makeStep(10, 1, 5),
			makeStep(10, 3, 0),
			makeStep(10, 3, 1),
			makeStep(20, 0),
		]);
	});

	it("orders by kind before index: a crop ripening, then a job finishing (MUST-10.6)", () => {
		const finish: AutomatedStep = { at: 10, kind: "finishJob", index: 0, slot: 0 };
		const ripen = makeStep(10, 5);

		expect([finish, ripen].sort(compareSteps)).toEqual([ripen, finish]);
		expect([makeStep(11, 0), finish].sort(compareSteps)).toEqual([finish, makeStep(11, 0)]);
	});

	it("ranks the kinds ripen, then finishJob, then produce, then refillSlot, before the index and slot (MUST-10.6)", () => {
		// Each later kind has a lower index and slot, so only the kind can put it later.
		const step = (
			at: number,
			kind: AutomatedStep["kind"],
			index: number,
			slot = 0,
		): AutomatedStep => ({ at, kind, index, slot });
		const steps = [
			step(10, "refillSlot", 0),
			step(10, "produce", 1, 1),
			step(10, "finishJob", 3, 2),
			step(10, "ripen", 9, 3),
			step(5, "refillSlot", 9),
			step(20, "ripen", 0),
		];

		expect([...steps].sort(compareSteps)).toEqual([
			step(5, "refillSlot", 9),
			step(10, "ripen", 9, 3),
			step(10, "finishJob", 3, 2),
			step(10, "produce", 1, 1),
			step(10, "refillSlot", 0),
			step(20, "ripen", 0),
		]);
	});

	it("is 0 only for the same step", () => {
		expect(compareSteps(makeStep(10, 1), makeStep(10, 1))).toBe(0);
		expect(compareSteps(makeStep(10, 1), makeStep(10, 2))).toBeLessThan(0);
		expect(compareSteps(makeStep(10, 2), makeStep(10, 1))).toBeGreaterThan(0);
	});
});

/** A farm that is a time and a log of the steps run, each scheduling the next 10 ms later until 30. */
interface Toy {
	readonly time: number;
	readonly log: readonly string[];
	readonly due: readonly AutomatedStep[];
}

const toySource: StepSource<Toy> = {
	steps: (farm) => farm.due,
	run: (farm, ran) => ({
		time: farm.time,
		log: [...farm.log, `${String(ran.at)}:${String(ran.index)}@${String(farm.time)}`],
		due: [
			...farm.due.filter((due) => compareSteps(due, ran) !== 0),
			...(ran.at < 30 ? [makeStep(ran.at + 10, ran.index)] : []),
		],
	}),
};

const makeToy = (due: AutomatedStep[]): Toy => ({ time: 0, log: [], due });

describe("advanceFarm", () => {
	it("runs every step at or before `to` in key order, at its own time, then sets the time", () => {
		const farm = advanceFarm(makeToy([makeStep(10, 1), makeStep(5, 0)]), 20, [toySource]);

		expect(farm.log).toEqual(["5:0@5", "10:1@10", "15:0@15", "20:1@20"]);
		expect(farm.time).toBe(20);
	});

	it("returns the farm unchanged for a time before its own (D7)", () => {
		const farm = { ...makeToy([makeStep(5, 0)]), time: 8 };

		expect(advanceFarm(farm, 7, [toySource])).toBe(farm);
	});

	it("throws a RangeError on a time that isn't a safe integer (D7)", () => {
		expect(() => advanceFarm(makeToy([]), 1.5, [toySource])).toThrow(RangeError);
	});

	it("throws a RangeError on a source whose run doesn't remove the step it ran", () => {
		const stuck: StepSource<Toy> = { steps: (farm) => farm.due, run: (farm) => farm };

		expect(() => advanceFarm(makeToy([makeStep(5, 0)]), 20, [stuck])).toThrow(
			"doesn't come after the one run before it",
		);
	});

	it("throws a RangeError on a source that schedules a step before the one it ran", () => {
		const backwards: StepSource<Toy> = {
			steps: (farm) => farm.due,
			run: (farm, ran) => ({ ...farm, due: ran.index === 1 ? [makeStep(ran.at, 0)] : [] }),
		};

		expect(() => advanceFarm(makeToy([makeStep(5, 1)]), 20, [backwards])).toThrow(RangeError);
	});

	it("throws a RangeError on a step before the farm's time, rather than run it late (D7)", () => {
		const overdue = { ...makeToy([makeStep(5, 0)]), time: 8 };

		expect(() => advanceFarm(overdue, 20, [toySource])).toThrow("is overdue");
	});
});

// The property harness (ADR-0003, section 9, D10): MUST-01.2, MUST-14.1-14.7, idempotent advance and the
// JSON round trip, over the real slice content and over test content that reaches every Level, so
// generated farms run jobs (#84), with fast-check's fixed seed from the root config.
import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { createSim, sliceContent, stateHash } from "../../index.js";
import type { Content, FarmState } from "../../index.js";
import { assertSafeIntegers } from "../../state/index.js";
import { delay, farmId, play, replay, timedActions } from "../../state/tests/farms.js";

const params = inject("fastCheck");
const { wheat } = sliceContent.crops;

// The slice's approved Level table and plot prices (admin, 11 Nov, #83), written out rather than
// read from content, so the expected values don't recompute what the rules do.
const levelXp = [0, 10, 30, 60, 100];
/** The level-up coins paid in all by the time a farm reaches each Level. */
const paidBy = [0, 20, 50, 90, 140];
const mostPlots = [6, 8, 10, 12, 14];
const plotPrices = [20, 30, 45, 67, 100, 150, 225, 337];
/** The feed mill's and the bakery's prices, and the Levels that unlock them (#84). */
const facilityPrices = [30, 50];
const facilityLevels = [2, 3];
const facilitySlots = 2;
/** The add-ons' prices and the Levels that unlock them (#88). */
const addOnPrices = { loop: 80, collector: 60 } as const;
const addOnLevels = { loop: 5, collector: 4 } as const;
/** The slice's recipes (#84): the wheat each takes, the goods it makes, its time and XP. */
const sliceRecipes = new Map(
	Object.entries({
		chickenFeed: { wheat: 2, good: "chickenFeed", amount: 2, ms: 60_000, xp: 1 },
		bread: { wheat: 3, good: "bread", amount: 1, ms: 300_000, xp: 2 },
	} as const satisfies Record<string, TestRecipe>),
);

interface TestRecipe {
	readonly wheat: number;
	readonly good: string;
	readonly amount: number;
	readonly ms: number;
	readonly xp: number;
}

/** The Level a farm with `xp` is at (MUST-05.3). */
const levelAt = (xp: number): number => levelXp.filter((threshold) => threshold <= xp).length;

/** The level-up coins paid in all by the time a farm has `xp` (MUST-05.4). */
const paidAt = (xp: number): number => paidBy[levelAt(xp) - 1] ?? NaN;

/** The test content's job XP: enough that a collect crosses a Level (MUST-05.4). */
const richJobXp = 31;
const richRecipes = new Map(
	[...sliceRecipes].map(([id, recipe]) => [id, { ...recipe, xp: richJobXp }] as const),
);

/**
 * Test content with the slice's Level table and plot prices, but room and coins to reach every
 * Level and plot: wheat isn't sold yet (#87), so the slice's silo keeps a farm near Level 2.
 * 31 XP a harvest crosses Levels 2 and 3 in one gain. A small barn fills after a few collects, so
 * collects reach its bound and its refusal, and 31 XP a collect lets a collect cross a Level.
 */
const richContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	barn: { capacity: 4 },
	crops: { wheat: { ...wheat, xp: 31 } },
	facilities: sliceContent.facilities.map((facility) => ({
		...facility,
		recipes: Object.fromEntries(
			Object.entries(facility.recipes).map(([id, recipe]) => [id, { ...recipe, xp: richJobXp }]),
		),
	})),
};

/** A purchase changes neither XP nor goods: the coins it costs are checked beside it (MUST-14.5). */
function expectOnlyPaid(before: FarmState, after: FarmState): void {
	expect(after.xp).toBe(before.xp);
	expect(after.silo).toEqual(before.silo);
	expect(after.barn).toEqual(before.barn);
}

/** A time at or after the farm's, from the generated delays (never before: see 14.7). */
const addDelay = (farm: FarmState, wait: number): number => farm.time + Math.abs(wait);

const contents = [
	["the slice", sliceContent, sliceRecipes],
	["a farm that reaches every Level", richContent, richRecipes],
] as const;

describe.each(contents)("the sim's properties, over %s", (_name, content) => {
	const sim = createSim(content);

	it("MUST-01.2: a crop is ready exactly its grow time after planting, not a ms before", () => {
		const growMs = wheat.growSeconds * 1000;
		fc.assert(
			fc.property(farmId, timedActions, delay, fc.nat(5), (id, played, wait, plot) => {
				const { final } = play(sim, id, played);
				const at = addDelay(final, wait);
				const result = sim.apply(final, { type: "plant", plot, crop: "wheat" }, at);
				fc.pre(result.ok);

				const harvest = { type: "harvest", plot } as const;
				expect(sim.apply(result.state, harvest, at + growMs - 1)).toEqual({
					ok: false,
					reason: `Plot ${String(plot + 1)} isn't ready to harvest.`,
				});
				const ripe = sim.apply(result.state, harvest, at + growMs);
				expect(ripe.ok || ripe.reason.startsWith("The silo has room")).toBe(true);
			}),
			params,
		);
	});

	it("MUST-14.1: advancing in two steps equals advancing in one", () => {
		fc.assert(
			fc.property(farmId, timedActions, delay, delay, (id, played, first, second) => {
				const { final } = play(sim, id, played);
				const t1 = addDelay(final, first);
				const t2 = t1 + Math.abs(second);

				expect(stateHash(sim.advance(sim.advance(final, t1), t2))).toBe(
					stateHash(sim.advance(final, t2)),
				);
			}),
			params,
		);
	});

	it("MUST-14.2: replaying from a serialized mid-run snapshot equals the uninterrupted run", () => {
		fc.assert(
			fc.property(farmId, timedActions, fc.nat(), fc.nat(), (id, played, cut, wait) => {
				const { farms, log, final } = play(sim, id, played);
				const at = cut % (log.length + 1);
				// farms has one more entry than log, so farms[at] always exists.
				const taken = farms[at] ?? final;
				// Advanced up to the next logged action, as a server snapshot after offline progress is.
				const until = log[at]?.at ?? taken.time + wait;
				const advanced = sim.advance(taken, taken.time + (wait % (until - taken.time + 1)));
				const snapshot = JSON.parse(JSON.stringify(advanced)) as FarmState;
				const replayed = replay(createSim(content), snapshot, log.slice(at));

				// A cut after the last action leaves the snapshot ahead of `final`: compare at one time.
				expect(stateHash(replayed)).toBe(stateHash(sim.advance(final, replayed.time)));
			}),
			params,
		);
	});

	it("MUST-14.3: two fresh sims give the same farm for the same id, actions and times", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				const { log, final } = play(sim, id, played);
				const other = createSim(content);

				expect(stateHash(replay(other, other.newFarm(id), log))).toBe(stateHash(final));
			}),
			params,
		);
	});

	it("MUST-14.6: a refused action leaves the farm unchanged", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				let farm = sim.newFarm(id);
				for (const { action, delay: wait } of played) {
					const before = JSON.stringify(farm);
					const result = sim.apply(farm, action, farm.time + wait);
					if (result.ok) {
						farm = result.state;
					} else {
						expect(result.reason).toMatch(/\.$/);
						expect(JSON.stringify(farm)).toBe(before);
					}
				}
			}),
			params,
		);
	});

	it("MUST-14.7: time never runs backwards, and an action before the farm's time is refused", () => {
		fc.assert(
			fc.property(
				farmId,
				timedActions,
				fc.integer({ min: 1, max: 2 ** 34 }),
				(id, played, back) => {
					const { log, transitions, final } = play(sim, id, played);
					for (const { at, before, after } of transitions) {
						expect(at).toBeGreaterThanOrEqual(before.time);
						expect(after.time).toBe(at);
					}
					for (const { action } of log) {
						expect(sim.apply(final, action, final.time - back).ok).toBe(false);
					}
				},
			),
			params,
		);
	});

	it("advance is idempotent, and a time before the farm's leaves it as it is (D7)", () => {
		fc.assert(
			fc.property(farmId, timedActions, delay, (id, played, wait) => {
				const { final } = play(sim, id, played);
				const to = addDelay(final, wait);
				const advanced = sim.advance(final, to);

				expect(sim.advance(advanced, to)).toBe(advanced);
				expect(sim.advance(advanced, to - 1)).toBe(advanced);
			}),
			params,
		);
	});

	it("every farm survives a JSON round trip (D10)", () => {
		fc.assert(
			fc.property(farmId, timedActions, delay, (id, played, wait) => {
				const { farms, final } = play(sim, id, played);
				for (const farm of [...farms, sim.advance(final, addDelay(final, wait))]) {
					expect(JSON.parse(JSON.stringify(farm))).toEqual(farm);
				}
			}),
			params,
		);
	});
});

describe("the generated farms", () => {
	it("start and collect jobs, fill the barn, cross Levels by collecting and buy add-ons, so the job properties aren't vacuous (#84, #88)", () => {
		const rich = createSim(richContent);
		const counts = new Map<string, number>();
		const count = (key: string): void => {
			counts.set(key, (counts.get(key) ?? 0) + 1);
		};
		for (const [id, played] of fc.sample(fc.tuple(farmId, timedActions), params)) {
			const { transitions, refusals } = play(rich, id, played);
			for (const { action, before, after } of transitions) {
				if (action.type === "startJob" || action.type === "collect") {
					count(`${action.type} ${String(action.facility)}`);
				}
				if (action.type === "buyAddOn") count(`buyAddOn ${action.addOn}`);
				if (action.type === "collect" && levelAt(after.xp) > levelAt(before.xp)) {
					count("collect reaches a Level");
				}
			}
			for (const reason of refusals) if (reason.startsWith("The barn has room")) count("barn full");
		}

		for (const key of [
			"startJob 0",
			"startJob 1",
			"collect 0",
			"collect 1",
			"collect reaches a Level",
			"barn full",
			"buyAddOn loop",
			"buyAddOn collector",
		]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThan(0);
		}
	});
});

describe.each(contents)("the Level and plot properties, over %s", (_name, content, recipes) => {
	const levelSim = createSim(content);
	const crop = content.crops.wheat;

	it("MUST-05.1, 14.4: coins, goods, plots and queues stay within their bounds, as safe integers", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				for (const farm of play(levelSim, id, played).farms) {
					assertSafeIntegers(farm);
					expect(farm.coins).toBeGreaterThanOrEqual(0);
					expect(farm.plots.length).toBeLessThanOrEqual(mostPlots[levelAt(farm.xp) - 1] ?? 0);
					for (const [goods, capacity] of [
						[farm.silo, content.silo.capacity],
						[farm.barn, content.barn.capacity],
					] as const) {
						const counts = Object.values(goods);
						expect(counts.every((count) => count > 0)).toBe(true);
						expect(counts.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(capacity);
					}
					for (const owned of farm.facilities) {
						const jobs = owned?.jobs ?? [];
						expect(jobs.length).toBeLessThanOrEqual(facilitySlots);
						// Done jobs come first, and each running job finishes after the farm's time and
						// no sooner than the one before it (MUST-03.3).
						const ends = jobs.flatMap((job) => (job.status === "running" ? [job.readyAt] : []));
						expect(
							jobs.slice(0, jobs.length - ends.length).every((job) => job.status === "done"),
						).toBe(true);
						expect(ends.every((end, i) => end > farm.time && end >= (ends[i - 1] ?? end))).toBe(
							true,
						);
					}
				}
			}),
			params,
		);
	});

	it("MUST-14.5: goods and coins change only by planting, harvesting, buying, jobs and add-ons", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				for (const { action, at, before, after } of play(levelSim, id, played).transitions) {
					const gained = (after.silo["wheat"] ?? 0) - (before.silo["wheat"] ?? 0);
					if (action.type !== "collect") expect(after.barn).toEqual(before.barn);
					if (action.type === "startJob") {
						// The inputs leave the silo, and the job ends the recipe's time after the later
						// of now and the job before it (MUST-03.2, 03.3).
						const made = recipes.get(action.recipe);
						const jobs = before.facilities[action.facility]?.jobs ?? [];
						const last = jobs[jobs.length - 1];
						const from = last?.status === "running" ? Math.max(at, last.readyAt) : at;
						const queue = after.facilities[action.facility]?.jobs ?? [];
						expect(gained).toBe(-(made?.wheat ?? NaN));
						expect(queue).toHaveLength(jobs.length + 1);
						expect(queue[queue.length - 1]).toEqual({
							status: "running",
							recipe: action.recipe,
							readyAt: from + (made?.ms ?? NaN),
						});
						expect(after.facilities[action.facility]?.lastRecipe).toBe(action.recipe);
						expect(after.coins).toBe(before.coins);
						expect(after.xp).toBe(before.xp);
					} else if (action.type === "collect") {
						// The oldest job, done by the action's time, gives its goods to the barn and its XP
						// (MUST-03.4, 05.2, 05.4).
						const jobs = levelSim.advance(before, at).facilities[action.facility]?.jobs ?? [];
						expect(jobs[0]?.status).toBe("done");
						const made = recipes.get(jobs[0]?.recipe ?? "");
						const good = made?.good ?? "";
						expect(after.facilities[action.facility]?.jobs).toHaveLength(jobs.length - 1);
						expect((after.barn[good] ?? 0) - (before.barn[good] ?? 0)).toBe(made?.amount);
						expect(after.xp).toBe(before.xp + (made?.xp ?? NaN));
						expect(after.coins).toBe(before.coins + paidAt(after.xp) - paidAt(before.xp));
						expect(after.silo).toEqual(before.silo);
					} else if (action.type === "plant") {
						expect(after.coins).toBe(before.coins - crop.seedPrice);
						expect(gained).toBe(0);
					} else if (action.type === "buyFacility") {
						expect(after.coins).toBe(before.coins - (facilityPrices[action.facility] ?? NaN));
						expect(levelAt(after.xp)).toBeGreaterThanOrEqual(
							facilityLevels[action.facility] ?? NaN,
						);
						expect(before.facilities[action.facility]).toBeNull();
						expect(after.facilities[action.facility]).toEqual({
							tier: 1,
							jobs: [],
							lastRecipe: null,
							addOns: { loop: false, collector: false },
						});
						expectOnlyPaid(before, after);
					} else if (action.type === "buyAddOn") {
						// Jobs may finish on the way to the action's time; the add-on changes nothing else.
						const owned = levelSim.advance(before, at).facilities[action.facility];
						expect(after.coins).toBe(before.coins - addOnPrices[action.addOn]);
						expect(levelAt(after.xp)).toBeGreaterThanOrEqual(addOnLevels[action.addOn]);
						expect(owned?.addOns[action.addOn]).toBe(false);
						expect(after.facilities[action.facility]).toEqual({
							...owned,
							addOns: { ...owned?.addOns, [action.addOn]: true },
						});
						expectOnlyPaid(before, after);
					} else if (action.type === "buyPlot") {
						expect(after.coins).toBe(
							before.coins - (plotPrices[action.plot - content.start.plots] ?? NaN),
						);
						expect(after.plots).toHaveLength(before.plots.length + 1);
						expect(after.xp).toBe(before.xp);
						expect(gained).toBe(0);
					} else {
						// A harvest pays the level-up coins of the Levels its XP reaches (MUST-05.4).
						expect(after.xp).toBe(before.xp + crop.xp);
						expect(after.coins).toBe(before.coins + paidAt(after.xp) - paidAt(before.xp));
						expect([crop.baseYield, crop.baseYield + crop.bonusYield]).toContain(gained);
					}
				}
			}),
			params,
		);
	});

	it("MUST-05.2, 05.3: XP and the Level never go down", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				const { farms } = play(levelSim, id, played);
				farms.slice(1).forEach((farm, i) => {
					const before = farms[i]?.xp ?? 0;
					expect(farm.xp).toBeGreaterThanOrEqual(before);
					expect(levelAt(farm.xp)).toBeGreaterThanOrEqual(levelAt(before));
				});
			}),
			params,
		);
	});

	it("MUST-05.4: over a run, each Level reached pays its level-up coins exactly once", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				const { log, final } = play(levelSim, id, played);
				const seeds = log.filter(({ action }) => action.type === "plant").length;
				const plots = final.plots.length - content.start.plots;
				const facilities = facilityPrices.filter((_price, i) => final.facilities[i] !== null);
				const addOns = final.facilities.flatMap((owned) =>
					(["loop", "collector"] as const).flatMap((addOn) =>
						owned?.addOns[addOn] === true ? [addOnPrices[addOn]] : [],
					),
				);
				const spent =
					seeds * crop.seedPrice +
					[...plotPrices.slice(0, plots), ...facilities, ...addOns].reduce((sum, p) => sum + p, 0);

				expect(final.coins).toBe(content.start.coins - spent + paidAt(final.xp));
			}),
			params,
		);
	});
});

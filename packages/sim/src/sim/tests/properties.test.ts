// The property harness (ADR-0003, section 9, D10): MUST-01.2, MUST-02, MUST-14.1-14.7, idempotent
// advance and the JSON round trip, over the real slice content and a richer one that reaches every
// Level and the chicken pen, with fast-check's fixed seed from the root config.
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
// The slice's chicken pen (#86's "Decided by the lane"): unlocked at Level 2 for 30 coins, three
// chickens, a one-portion trough, an egg 180 s after each portion, 1 XP per egg collected.
const penLevel = 2;
const penPrice = 30;
const chickens = 3;
const layMs = 180_000;
const startFeed = 6;

/** The Level a farm with `xp` is at (MUST-05.3). */
const levelAt = (xp: number): number => levelXp.filter((threshold) => threshold <= xp).length;

/** The level-up coins paid in all by the time a farm has `xp` (MUST-05.4). */
const paidAt = (xp: number): number => paidBy[levelAt(xp) - 1] ?? NaN;

/**
 * Test content with the slice's Level table, plot prices and pen, but room and coins to reach every
 * Level, plot and the pen: wheat isn't sold yet (#87), so the slice's silo keeps a farm near Level
 * 2. 31 XP a harvest crosses Levels 2 and 3 in one gain.
 */
const richContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	crops: { wheat: { ...wheat, xp: 31 } },
};

/** A time at or after the farm's, from the generated delays (never before: see 14.7). */
const addDelay = (farm: FarmState, wait: number): number => farm.time + Math.abs(wait);

/** Chicken feed and eggs wherever they are: in the barn, a trough, eaten or waiting in a pen. */
const portionsAndEggs = (farm: FarmState): number =>
	(farm.barn["chickenFeed"] ?? 0) +
	(farm.barn["egg"] ?? 0) +
	farm.pens.reduce(
		(total, pen) =>
			total +
			(pen === null
				? 0
				: pen.trough +
					pen.products +
					pen.animals.filter((animal) => animal.status === "producing").length),
		0,
	);

const contents = [
	["the slice", sliceContent],
	["a farm that reaches every Level", richContent],
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

describe.each(contents)("the Level, plot and pen properties, over %s", (_name, content) => {
	const levelSim = createSim(content);
	const crop = content.crops.wheat;

	it("MUST-05.1, 14.4: coins, goods, plots and pens stay within their bounds, as safe integers", () => {
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
					expect(farm.pens).toHaveLength(1);
					const [pen] = farm.pens;
					if (levelAt(farm.xp) < penLevel) expect(pen).toBeNull();
					if (pen === null || pen === undefined) continue;

					expect(pen.trough).toBeGreaterThanOrEqual(0);
					expect(pen.trough).toBeLessThanOrEqual(1);
					expect(pen.products).toBeGreaterThanOrEqual(0);
					expect(pen.animals).toHaveLength(chickens);
					for (const animal of pen.animals) {
						// MUST-02.3: no chicken waits while the trough holds feed, and none is overdue.
						if (pen.trough > 0) expect(animal.status).toBe("producing");
						if (animal.status === "idle") continue;

						expect(animal.readyAt).toBeGreaterThan(farm.time);
						expect(animal.readyAt).toBeLessThanOrEqual(farm.time + layMs);
					}
				}
			}),
			params,
		);
	});

	it("MUST-14.5: goods and coins change only by planting, harvesting, buying, feeding and collecting", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				for (const { action, before, after } of play(levelSim, id, played).transitions) {
					const gained = (after.silo["wheat"] ?? 0) - (before.silo["wheat"] ?? 0);
					const fed = (before.barn["chickenFeed"] ?? 0) - (after.barn["chickenFeed"] ?? 0);
					const collected = (after.barn["egg"] ?? 0) - (before.barn["egg"] ?? 0);
					if (action.type !== "feed") expect(fed).toBe(0);
					if (action.type !== "collectProducts") expect(collected).toBe(0);
					if (action.type === "plant") {
						expect(after.coins).toBe(before.coins - crop.seedPrice);
						expect(gained).toBe(0);
					} else if (action.type === "buyFacility") {
						expect(after.coins).toBe(before.coins - (facilityPrices[action.facility] ?? NaN));
						expect(levelAt(after.xp)).toBeGreaterThanOrEqual(
							facilityLevels[action.facility] ?? NaN,
						);
						expect(before.facilities[action.facility]).toBeNull();
						expect(after.facilities[action.facility]).toEqual({ tier: 1, jobs: [] });
						expect(after.xp).toBe(before.xp);
						expect(after.silo).toEqual(before.silo);
						expect(after.barn).toEqual(before.barn);
					} else if (action.type === "buyPlot") {
						expect(after.coins).toBe(
							before.coins - (plotPrices[action.plot - content.start.plots] ?? NaN),
						);
						expect(after.plots).toHaveLength(before.plots.length + 1);
						expect(after.xp).toBe(before.xp);
						expect(gained).toBe(0);
					} else if (action.type === "buyPen") {
						expect(after.coins).toBe(before.coins - penPrice);
						expect(after.xp).toBe(before.xp);
						expect(gained).toBe(0);
					} else if (action.type === "feed") {
						// A one-portion trough takes one portion a feeding (MUST-02.2, 02.5).
						expect(fed).toBe(1);
						expect([after.xp, after.coins, gained]).toEqual([before.xp, before.coins, 0]);
					} else if (action.type === "collectProducts") {
						// 1 XP an egg, with the level-up coins of the Levels it reaches (MUST-02.4, 05.4).
						expect(collected).toBeGreaterThan(0);
						expect(after.xp).toBe(before.xp + collected);
						expect(after.coins).toBe(before.coins + paidAt(after.xp) - paidAt(before.xp));
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

	it("MUST-14.5: a laid egg is the portion its chicken ate, so feed and eggs together never change", () => {
		fc.assert(
			fc.property(farmId, timedActions, delay, (id, played, wait) => {
				const { farms, final } = play(levelSim, id, played);
				for (const farm of [...farms, levelSim.advance(final, addDelay(final, wait))]) {
					expect(portionsAndEggs(farm)).toBe(startFeed);
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
				const pens = final.pens.filter((pen) => pen !== null).length;
				const spent =
					seeds * crop.seedPrice +
					[...plotPrices.slice(0, plots), ...facilities].reduce((sum, p) => sum + p, 0) +
					pens * penPrice;

				expect(final.coins).toBe(content.start.coins - spent + paidAt(final.xp));
			}),
			params,
		);
	});
});

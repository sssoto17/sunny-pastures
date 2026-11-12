// The property harness (ADR-0003, section 9, D10): MUST-01.2, MUST-02, MUST-04, MUST-14.1-14.7,
// idempotent advance and the JSON round trip, over the real slice content and over test content
// that reaches every Level, so generated farms run jobs (#84), keep chickens (#86) and trade on the
// order board (#87), with fast-check's fixed seed from the root config.
import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { createSim, sliceContent, stateHash } from "../../index.js";
import type { Content, FarmState, Order, Sim } from "../../index.js";
import { assertSafeIntegers } from "../../state/index.js";
import { delay, farmId, play, replay, timedActions } from "../../state/tests/farms.js";
import type { Transition } from "../../state/tests/farms.js";
import { listDrawFaults } from "./orderTerms.js";
import { ownedFacility } from "./ownedFacility.js";

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
/** The add-ons' prices and the Levels that unlock them (#88). */
const addOnPrices = { loop: 80, collector: 60 } as const;
const addOnLevels = { loop: 5, collector: 4 } as const;
// The slice's tiers (#85's "Decided by the lane"): each facility's slots at tiers 1, 2 and 3, and
// the prices and Levels of its tiers 2 and 3, feed mill first.
const tierSlots = [2, 3, 3];
const tierPrices = [
	[60, 120],
	[100, 200],
];
const tierLevels = [
	[3, 5],
	[4, 5],
];
// The slice's chicken pen (#86's "Decided by the lane"): unlocked at Level 2 for 30 coins, three
// chickens, a one-portion trough, an egg 180 s after each portion, 1 XP per egg collected.
const penLevel = 2;
const penPrice = 30;
const chickens = 3;
const layMs = 180_000;
// The slice's order board (#87's "Decided by the lane"): the slots and refill delays at each Level.
const boardSlots = [3, 4, 5, 6, 7];
const deliveredMs = [120_000, 120_000, 90_000, 90_000, 60_000];
const discardedMs = [300_000, 300_000, 240_000, 240_000, 180_000];
/**
 * The slice's recipes (#84): the wheat each takes, the goods it makes, its time at tiers 1, 2 and
 * 3 (#85: 800 and 600 per mille, rounded down to whole seconds) and its XP. Cookies (#85) also
 * take eggs, and are made from tier 2 (MUST-03.1).
 */
const sliceRecipes = new Map(
	Object.entries({
		chickenFeed: {
			tier: 1,
			wheat: 2,
			eggs: 0,
			good: "chickenFeed",
			amount: 2,
			ms: [60_000, 48_000, 36_000],
			xp: 1,
		},
		bread: {
			tier: 1,
			wheat: 3,
			eggs: 0,
			good: "bread",
			amount: 1,
			ms: [300_000, 240_000, 180_000],
			xp: 2,
		},
		cookies: {
			tier: 2,
			wheat: 2,
			eggs: 2,
			good: "cookies",
			amount: 1,
			ms: [500_000, 400_000, 300_000],
			xp: 5,
		},
	} as const satisfies Record<string, TestRecipe>),
);

interface TestRecipe {
	/** The lowest tier that makes it (MUST-03.1). */
	readonly tier: number;
	readonly wheat: number;
	readonly eggs: number;
	readonly good: string;
	readonly amount: number;
	readonly ms: readonly number[];
	readonly xp: number;
}

/** The Level a farm with `xp` is at (MUST-05.3). */
const levelAt = (xp: number): number => levelXp.filter((threshold) => threshold <= xp).length;

/** The level-up coins paid in all by the time a farm has `xp` (MUST-05.4). */
const paidAt = (xp: number): number => paidBy[levelAt(xp) - 1] ?? NaN;

/** The test content's job XP: enough that a collect crosses two Levels in one gain (MUST-05.4). */
const richJobXp = 51;
/** The test content's chicken feed time: 61 s, so tiers 2 and 3 round down to 48 s and 36 s (D16). */
const richFeedSeconds = 61;
const richRecipes = new Map(
	[...sliceRecipes].map(([id, recipe]) => {
		const ms = id === "chickenFeed" ? [richFeedSeconds * 1000, 48_000, 36_000] : recipe.ms;
		return [id, { ...recipe, ms, xp: richJobXp }] as const;
	}),
);

/**
 * Test content with the slice's Level table and plot prices, but room and coins to reach every
 * Level and plot: wheat isn't sold yet (#87), so the slice's silo keeps a farm near Level 2.
 * 9 XP a harvest keeps a farm that has bought a facility below Level 5 for a while, so collects
 * reach Levels (#85: at 31 a harvest, one tending reached Level 5 before any collect), and 51 XP
 * a collect from 18 or 27 XP crosses Levels 3 and 4 in one gain. A small barn fills after a few
 * collects, so collects reach its bound and its refusal. Chicken feed's 61 s doesn't divide by the
 * tiers' per mille, so a job time that isn't rounded down to whole seconds fails 14.5 (#85).
 */
const richContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	barn: { capacity: 4 },
	crops: { wheat: { ...wheat, xp: 9 } },
	facilities: sliceContent.facilities.map((facility) => ({
		...facility,
		recipes: Object.fromEntries(
			Object.entries(facility.recipes).map(([id, recipe]) => [
				id,
				{ ...recipe, xp: richJobXp, ...(id === "chickenFeed" ? { seconds: richFeedSeconds } : {}) },
			]),
		),
	})),
};

/** A purchase changes neither XP nor goods: the coins it costs are checked beside it (MUST-14.5). */
function expectOnlyPaid(before: FarmState, after: FarmState): void {
	expect(after.xp).toBe(before.xp);
	expect(after.silo).toEqual(before.silo);
	expect(after.barn).toEqual(before.barn);
}
/** The test content's egg XP: enough that collecting one egg crosses a Level (MUST-05.4). */
const richEggXp = 31;

/**
 * Test content where collecting eggs crosses Levels and fills the barn (#86): 9 XP a harvest
 * reaches the pen's Level in two harvests, 31 XP an egg crosses a Level with each collect, and a
 * 5-good barn fills with a feed job's 2 chicken feed and a few eggs.
 */
const eggContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	barn: { capacity: 5 },
	crops: { wheat: { ...wheat, xp: 9 } },
	pens: sliceContent.pens.map((pen) => ({ ...pen, xp: richEggXp })),
};

/**
 * Test content where farms bake cookies (#85): 31 XP a harvest reaches the bakery's tier 2 at
 * Level 4 in one tending, and a 12-good barn holds chicken feed, eggs and cookies together.
 */
const cookieContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	barn: { capacity: 12 },
	crops: { wheat: { ...wheat, xp: 31 } },
};

/**
 * Whether the farm can make `good` now (`GLOSSARY.md`, "Producible"): wheat from Level 1, chicken
 * feed with the feed mill, bread with the bakery, eggs with the chicken pen.
 */
const isProducible = (farm: FarmState, good: string): boolean =>
	({
		wheat: true,
		chickenFeed: farm.facilities[0] !== null,
		bread: farm.facilities[1] !== null,
		egg: farm.pens[0] !== null,
	})[good] ?? false;

/** The open order in `slot` of a farm already advanced to an action's time: the one it acted on. */
const findOrder = (advanced: FarmState, slot: number): Order | null => {
	const found = advanced.board[slot];
	return found?.status === "open" ? found.order : null;
};

/** A time at or after the farm's, from the generated delays (never before: see 14.7). */
const addDelay = (farm: FarmState, wait: number): number => farm.time + Math.abs(wait);

/** Chicken feed and eggs wherever they are: in the barn, a trough, eaten or waiting in a pen. */
const countFeedAndEggs = (farm: FarmState): number =>
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

/** `goods` with `change` more of `good`, keyed as the stores are: no key at 0 (state/). */
const changeGood = (goods: FarmState["barn"], good: string, change: number): FarmState["barn"] => {
	const count = (goods[good] ?? 0) + change;
	const others = Object.entries(goods).filter(([key]) => key !== good);
	return Object.fromEntries(count > 0 ? [...others, [good, count]] : others);
};

/** Each content, with its recipes and the XP an egg gives, written out (#84, #86). */
const contents = [
	["the slice", sliceContent, sliceRecipes, 1],
	["a farm that reaches every Level", richContent, richRecipes, 1],
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

	it("MUST-03.5, 06.2: a job is refused for a full queue exactly when it holds its tier's slots", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				let farm = sim.newFarm(id);
				for (const { action, delay: wait } of played) {
					const result = sim.apply(farm, action, farm.time + wait);
					if (result.ok) {
						farm = result.state;
					} else if (action.type === "startJob" && result.reason.includes("queue is full")) {
						const owned = farm.facilities[action.facility];
						expect(owned?.jobs.length).toBe(tierSlots[(owned?.tier ?? NaN) - 1]);
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

/** Checks every accepted action of the generated runs over `sim`, as a property. */
const checkTransitions = (sim: Sim, check: (transition: Transition) => void): void => {
	fc.assert(
		fc.property(farmId, timedActions, (id, played) => {
			for (const transition of play(sim, id, played).transitions) check(transition);
		}),
		params,
	);
};

/**
 * Plays the generated runs over `content` and counts the cases each run reaches: the keys `name`
 * gives a transition, and the keys `nameRefusal` gives a refusal's reason.
 */
const countReached = (
	content: Content,
	name: (transition: Transition) => readonly string[],
	nameRefusal: (reason: string) => readonly string[],
): ReadonlyMap<string, number> => {
	const sim = createSim(content);
	const counts = new Map<string, number>();
	for (const [id, played] of fc.sample(fc.tuple(farmId, timedActions), params)) {
		const { transitions, refusals } = play(sim, id, played);
		const keys = [...transitions.flatMap(name), ...refusals.flatMap(nameRefusal)];
		for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
};

describe("the generated farms", () => {
	it("start and collect jobs, fill the barn, cross Levels by collecting and buy add-ons, so the job properties aren't vacuous (#84, #88)", () => {
		const counts = countReached(
			richContent,
			({ action, before, after }) => [
				...(action.type === "startJob" || action.type === "collect"
					? [`${action.type} ${String(action.facility)}`]
					: []),
				...(action.type === "buyAddOn" ? [`buyAddOn ${action.addOn}`] : []),
				...(action.type === "collect" && levelAt(after.xp) > levelAt(before.xp)
					? ["collect reaches a Level"]
					: []),
				...(levelAt(after.xp) - levelAt(before.xp) >= 2 ? ["one gain crosses two Levels"] : []),
			],
			(reason) => (reason.startsWith("The barn has room") ? ["barn full"] : []),
		);

		for (const key of [
			"startJob 0",
			"startJob 1",
			"collect 0",
			"collect 1",
			"collect reaches a Level",
			"one gain crosses two Levels",
			"barn full",
			"buyAddOn loop",
			"buyAddOn collector",
			"buyAddOn loop",
			"buyAddOn collector",
		]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThan(0);
		}
	});

	it("buy tiers 2 and 3 with jobs in the queue and fill it past tier 1's slots, so the tier properties aren't vacuous (#85)", () => {
		const counts = countReached(
			richContent,
			({ action, before, after }) => {
				if (action.type === "buyTier") {
					const jobs = before.facilities[action.facility]?.jobs ?? [];
					return [
						`buyTier ${String(action.tier)}`,
						...(jobs.some((job) => job.status === "running") ? ["buyTier with a job running"] : []),
					];
				}
				const queue = action.type === "startJob" ? after.facilities[action.facility] : null;
				return (queue?.jobs.length ?? 0) > (tierSlots[0] ?? NaN)
					? ["queue past tier 1's slots"]
					: [];
			},
			(reason) => (reason.includes("queue is full: 3 of 3") ? ["full at tier 2 or 3"] : []),
		);

		for (const key of [
			"buyTier 2",
			"buyTier 3",
			"buyTier with a job running",
			"queue past tier 1's slots",
			"full at tier 2 or 3",
		]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThan(0);
		}
	});

	it("bake cookies with eggs at bakery tier 2 and collect them, so the cookie branches aren't vacuous (#85)", () => {
		const counts = countReached(
			cookieContent,
			({ action, before, after }) => [
				...(action.type === "startJob" && action.recipe === "cookies" ? ["cookies started"] : []),
				...((after.barn["cookies"] ?? 0) > (before.barn["cookies"] ?? 0)
					? ["cookies collected"]
					: []),
			],
			() => [],
		);

		for (const key of ["cookies started", "cookies collected"]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThan(0);
		}
	});

	it("keep chickens, fill the barn and cross Levels by collecting eggs, so the pen properties aren't vacuous (#86)", () => {
		const counts = countReached(
			eggContent,
			({ action, before, after }) => [
				...(["buyPen", "feed", "collectProducts"].includes(action.type) ? [action.type] : []),
				...(action.type === "collectProducts" && levelAt(after.xp) > levelAt(before.xp)
					? ["collectProducts reaches a Level"]
					: []),
			],
			(reason) =>
				reason.includes("collecting from the chickenPen") ? ["barn full on collectProducts"] : [],
		);

		for (const key of [
			"buyPen",
			"feed",
			"collectProducts",
			"collectProducts reaches a Level",
			"barn full on collectProducts",
		]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThan(0);
		}
	});
});

/** Every running end time of the farm's other kinds: plots ripening, jobs finishing, animals producing. */
const listEndTimes = (farm: FarmState): number[] => [
	...farm.plots.flatMap((plot) => (plot.status === "growing" ? [plot.readyAt] : [])),
	...farm.facilities.flatMap((owned) =>
		(owned?.jobs ?? []).flatMap((job) => (job.status === "running" ? [job.readyAt] : [])),
	),
	...farm.pens.flatMap((pen) =>
		(pen?.animals ?? []).flatMap((animal) =>
			animal.status === "producing" ? [animal.readyAt] : [],
		),
	),
];

/**
 * Plays the generated runs over `content` and counts the order board's cases (#87): deliveries,
 * refusals for a short good, discards, refills after each, Levels and slots that a delivery's XP
 * reaches, orders drawn for a good the farm can't produce, and refills at the same time as another
 * kind's step.
 */
const countOrderCases = (content: Content): ReadonlyMap<string, number> => {
	const sim = createSim(content);
	const counts = new Map<string, number>();
	const count = (key: string): void => {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	};
	for (const [id, played] of fc.sample(fc.tuple(farmId, timedActions), params)) {
		const { transitions, refusals } = play(sim, id, played);
		for (const reason of refusals) {
			if (reason.startsWith("Delivering order")) count("deliver refused: a good short");
		}
		const emptiedBy = new Map<number, string>();
		for (const { action, at, before, after } of transitions) {
			const advanced = sim.advance(before, at);
			before.board.forEach((slot, i) => {
				if (slot.status !== "empty" || advanced.board[i]?.status !== "open") return;

				count(`refill after ${emptiedBy.get(i) ?? "?"}`);
				if (listEndTimes(before).includes(slot.refillAt)) {
					count("refill at the same time as another kind");
				}
			});
			if (action.type === "deliver" || action.type === "discard") {
				count(action.type);
				emptiedBy.set(action.slot, action.type);
			}
			if (action.type === "deliver" && levelAt(after.xp) > levelAt(before.xp)) {
				count("deliver reaches a Level");
			}
			if (action.type === "deliver" && after.board.length > before.board.length) {
				count("deliver opens a slot");
			}
			const stretched = after.board.filter(
				(slot) =>
					slot.status === "open" && slot.order.goods.some(({ good }) => !isProducible(after, good)),
			);
			if (stretched.length > 0) count("an open order asks for a good the farm can't produce");
		}
	}
	return counts;
};

describe("the generated farms on the order board", () => {
	it("deliver, are refused, discard, refill and cross Levels by delivering, so the order properties aren't vacuous (#87)", () => {
		const counts = countOrderCases(sliceContent);

		for (const key of [
			"deliver",
			"deliver refused: a good short",
			"discard",
			"refill after deliver",
			"refill after discard",
			"deliver reaches a Level",
			"deliver opens a slot",
			"an open order asks for a good the farm can't produce",
			"refill at the same time as another kind",
		]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThan(0);
		}
	});
});

describe.each([
	...contents,
	["a farm whose eggs cross Levels and fill the barn", eggContent, sliceRecipes, richEggXp],
	["a farm that bakes cookies", cookieContent, sliceRecipes, 1],
] as const)("the Level, plot and pen properties, over %s", (_name, content, recipes, eggXp) => {
	const levelSim = createSim(content);
	const crop = content.crops.wheat;

	it("MUST-05.1, 14.4: coins, goods, plots, queues and pens stay within their bounds, as safe integers", () => {
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
						// The slots follow the tier, from 1 up to 3 (MUST-03.5, 06.2).
						const tier = owned?.tier ?? 1;
						expect(tier).toBeGreaterThanOrEqual(1);
						expect(tier).toBeLessThanOrEqual(tierSlots.length);
						expect(jobs.length).toBeLessThanOrEqual(tierSlots[tier - 1] ?? NaN);
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

	it("MUST-14.5: goods and coins change only by planting, harvesting, buying, jobs, add-ons, feeding, collecting eggs and orders", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				for (const { action, at, before, after } of play(levelSim, id, played).transitions) {
					const gained = (after.silo["wheat"] ?? 0) - (before.silo["wheat"] ?? 0);
					// Feeding, collecting eggs, starting a job that takes eggs and delivering change the
					// barn too; their branches below check it exactly.
					const isBarnChanged = [
						"collect",
						"feed",
						"collectProducts",
						"startJob",
						"deliver",
					].includes(action.type);
					if (!isBarnChanged) expect(after.barn).toEqual(before.barn);
					const advanced = levelSim.advance(before, at);
					if (action.type !== "deliver" && action.type !== "discard") {
						// Only delivering and discarding empty a slot; a Level crossed adds slots after it.
						expect(after.board.slice(0, advanced.board.length)).toEqual(advanced.board);
					}
					if (action.type === "deliver") {
						// The order's goods leave storage, whole, and it pays its coins and XP with the
						// level-up coins of the Levels it reaches; its slot waits the delivered delay of the
						// Level reached (MUST-04.4, 04.5, 05.4).
						const order = findOrder(advanced, action.slot);
						expect(order).not.toBeNull();
						let [silo, barn] = [advanced.silo, advanced.barn];
						for (const { good, amount } of order?.goods ?? []) {
							if (good === "wheat") silo = changeGood(silo, good, -amount);
							else barn = changeGood(barn, good, -amount);
						}
						expect([after.silo, after.barn]).toEqual([silo, barn]);
						expect(after.xp).toBe(before.xp + (order?.xp ?? NaN));
						expect(after.coins).toBe(
							before.coins + (order?.coins ?? NaN) + paidAt(after.xp) - paidAt(before.xp),
						);
						expect(after.board[action.slot]).toEqual({
							status: "empty",
							refillAt: at + (deliveredMs[levelAt(after.xp) - 1] ?? NaN),
						});
					} else if (action.type === "discard") {
						// Only the slot changes: it waits the discarded delay of the farm's Level (MUST-04.5).
						expect(findOrder(advanced, action.slot)).not.toBeNull();
						const emptied = {
							status: "empty",
							refillAt: at + (discardedMs[levelAt(before.xp) - 1] ?? NaN),
						};
						expect(after).toEqual({
							...advanced,
							board: advanced.board.map((slot, i) => (i === action.slot ? emptied : slot)),
						});
					} else if (action.type === "feed") {
						// A one-portion trough takes one portion a feeding (MUST-02.2, 02.5).
						expect(after.barn).toEqual(changeGood(before.barn, "chickenFeed", -1));
						expect([after.xp, after.coins]).toEqual([before.xp, before.coins]);
						expect(after.silo).toEqual(before.silo);
					} else if (action.type === "collectProducts") {
						// Every egg waiting at the action's time goes to the barn, for the content's XP each,
						// with the level-up coins of the Levels it reaches (MUST-02.4, 05.2, 05.4).
						const waiting = levelSim.advance(before, at).pens[0]?.products ?? 0;
						expect(waiting).toBeGreaterThan(0);
						expect(after.barn).toEqual(changeGood(before.barn, "egg", waiting));
						expect(after.pens[0]?.products).toBe(0);
						expect(after.xp).toBe(before.xp + waiting * eggXp);
						expect(after.coins).toBe(before.coins + paidAt(after.xp) - paidAt(before.xp));
						expect(after.silo).toEqual(before.silo);
					} else if (action.type === "buyPen") {
						expect(after.coins).toBe(before.coins - penPrice);
						expect(levelAt(after.xp)).toBeGreaterThanOrEqual(penLevel);
						expect(before.pens[0]).toBeNull();
						expect(after.pens[0]).toEqual({
							trough: 0,
							animals: Array.from({ length: chickens }, () => ({ status: "idle" })),
							products: 0,
						});
						expect(after.xp).toBe(before.xp);
						expect(after.silo).toEqual(before.silo);
					} else if (action.type === "startJob") {
						// The inputs leave the silo, and the job ends the recipe's time at the facility's
						// tier now after the later of now and the job before it (MUST-03.2, 03.3, 06.2).
						const made = recipes.get(action.recipe);
						const tier = before.facilities[action.facility]?.tier ?? NaN;
						const jobs = before.facilities[action.facility]?.jobs ?? [];
						const last = jobs[jobs.length - 1];
						const from = last?.status === "running" ? Math.max(at, last.readyAt) : at;
						const queue = after.facilities[action.facility]?.jobs ?? [];
						expect(tier).toBeGreaterThanOrEqual(made?.tier ?? NaN);
						expect(gained).toBe(-(made?.wheat ?? NaN));
						expect(after.barn).toEqual(changeGood(before.barn, "egg", -(made?.eggs ?? NaN)));
						expect(queue).toHaveLength(jobs.length + 1);
						expect(queue[queue.length - 1]).toEqual({
							status: "running",
							recipe: action.recipe,
							readyAt: from + (made?.ms[tier - 1] ?? NaN),
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
						expect(after.facilities[action.facility]).toEqual(ownedFacility());
						expectOnlyPaid(before, after);
					} else if (action.type === "buyTier") {
						// The next tier, for its price, once its Level is reached; nothing else changes,
						// the jobs' stored finishes included (MUST-06.2, 06.7).
						const advanced = levelSim.advance(before, at);
						const owned = advanced.facilities[action.facility];
						const prices = tierPrices[action.facility] ?? [];
						const levels = tierLevels[action.facility] ?? [];
						expect(action.tier).toBe((owned?.tier ?? NaN) + 1);
						expect(after.coins).toBe(before.coins - (prices[action.tier - 2] ?? NaN));
						expect(levelAt(after.xp)).toBeGreaterThanOrEqual(levels[action.tier - 2] ?? NaN);
						expect(after.facilities).toEqual(
							advanced.facilities.map((current, i) =>
								i === action.facility ? { ...owned, tier: action.tier } : current,
							),
						);
						expect(after.xp).toBe(before.xp);
						expect(after.silo).toEqual(before.silo);
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

	it("MUST-14.5: an egg is the portion its chicken ate, so feed and eggs total what the feed mill made, less the eggs baked and what orders took", () => {
		const feedJob = recipes.get("chickenFeed")?.amount ?? NaN;
		fc.assert(
			fc.property(farmId, timedActions, delay, (id, played, wait) => {
				const { transitions, final } = play(levelSim, id, played);
				let made = 0;
				for (const { action, at, before, after } of transitions) {
					if (action.type === "collect") {
						const [job] = levelSim.advance(before, at).facilities[action.facility]?.jobs ?? [];
						if (job?.recipe === "chickenFeed") made += feedJob;
					}
					// Cookies take their eggs from the barn as the job starts (#85).
					if (action.type === "startJob") made -= recipes.get(action.recipe)?.eggs ?? NaN;
					if (action.type === "deliver") {
						for (const { good, amount } of findOrder(levelSim.advance(before, at), action.slot)
							?.goods ?? []) {
							if (good === "chickenFeed" || good === "egg") made -= amount;
						}
					}
					expect(countFeedAndEggs(after)).toBe(made);
				}
				expect(countFeedAndEggs(levelSim.advance(final, addDelay(final, wait)))).toBe(made);
			}),
			params,
		);
	});

	it("MUST-03.3, 06.7: no action moves a stored job finish, a tier bought included", () => {
		checkTransitions(levelSim, ({ action, at, before, after }) => {
			levelSim.advance(before, at).facilities.forEach((owned, facility) => {
				// Collecting takes the oldest job; every other job keeps its slot's order.
				const isCollected = action.type === "collect" && action.facility === facility;
				const kept = (owned?.jobs ?? []).slice(isCollected ? 1 : 0);
				const jobs = after.facilities[facility]?.jobs ?? [];
				expect(jobs.slice(0, kept.length)).toEqual(kept);
			});
		});
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
				const { log, transitions, final } = play(levelSim, id, played);
				const seeds = log.filter(({ action }) => action.type === "plant").length;
				const earned = transitions.reduce(
					(total, { action, at, before }) =>
						total +
						(action.type === "deliver"
							? (findOrder(levelSim.advance(before, at), action.slot)?.coins ?? NaN)
							: 0),
					0,
				);
				const plots = final.plots.length - content.start.plots;
				const facilities = facilityPrices.filter((_price, i) => final.facilities[i] !== null);
				const addOns = final.facilities.flatMap((owned) =>
					(["loop", "collector"] as const).flatMap((addOn) =>
						owned?.addOns[addOn] === true ? [addOnPrices[addOn]] : [],
					),
				);
				const pens = final.pens.filter((pen) => pen !== null).length;
				const tiers = final.facilities.flatMap((owned, i) =>
					(tierPrices[i] ?? []).slice(0, (owned?.tier ?? 1) - 1),
				);
				const spent =
					seeds * crop.seedPrice +
					[...plotPrices.slice(0, plots), ...facilities, ...addOns, ...tiers].reduce(
						(sum, p) => sum + p,
						0,
					) +
					pens * penPrice;

				expect(final.coins).toBe(content.start.coins - spent + earned + paidAt(final.xp));
			}),
			params,
		);
	});
	it("MUST-04.1, 04.2, 04.5, 04.6: the board has the Level's slots, each a valid order or refilling in time", () => {
		fc.assert(
			fc.property(farmId, timedActions, (id, played) => {
				for (const farm of play(levelSim, id, played).farms) {
					// MUST-04.1, 04.2: a slot per the Level's count, each open order asking for 1–3 different
					// goods unlocked at the farm's Level in set amounts, and each empty one refilling
					// within the longest delay, never overdue (MUST-04.5, 04.6).
					expect(farm.board).toHaveLength(boardSlots[levelAt(farm.xp) - 1] ?? NaN);
					const latest = farm.time + (discardedMs[0] ?? NaN);
					const faults = farm.board.flatMap((slot) => {
						if (slot.status === "open") return listDrawFaults(slot.order, levelAt(farm.xp));

						const isInTime = slot.refillAt > farm.time && slot.refillAt <= latest;
						return isInTime ? [] : [`refills at ${String(slot.refillAt)} ms`];
					});
					expect(faults).toEqual([]);
				}
			}),
			params,
		);
	});

	it("MUST-04.3: at most one open order asks for a good the farm can't produce", () => {
		fc.assert(
			fc.property(farmId, timedActions, delay, (id, played, wait) => {
				const { farms, final } = play(levelSim, id, played);
				for (const farm of [...farms, levelSim.advance(final, addDelay(final, wait))]) {
					const stretched = farm.board.filter(
						(slot) =>
							slot.status === "open" &&
							slot.order.goods.some(({ good }) => !isProducible(farm, good)),
					);
					expect(stretched.length).toBeLessThanOrEqual(1);
				}
			}),
			params,
		);
	});

	it("MUST-04.2, D9: orders are drawn from the orders stream only, never from the yields stream", () => {
		fc.assert(
			fc.property(
				farmId,
				timedActions,
				delay,
				fc.nat({ max: 2 ** 32 - 1 }),
				(id, played, wait, yields) => {
					const { final } = play(levelSim, id, played);
					const to = addDelay(final, wait);
					const advanced = levelSim.advance(final, to);
					const otherYields = { ...final, streams: { ...final.streams, yields } };

					// No step draws from the yields stream, and the refills draw the same orders whatever it is.
					expect(advanced.streams.yields).toBe(final.streams.yields);
					expect(levelSim.advance(otherYields, to).board).toEqual(advanced.board);
				},
			),
			params,
		);
	});

	it("MUST-04.6, ADR-0006 section 7: an empty slot keeps its stored refill time, and refills at it", () => {
		fc.assert(
			fc.property(farmId, timedActions, delay, (id, played, wait) => {
				const { transitions, final } = play(levelSim, id, played);
				const later = addDelay(final, wait);
				const steps = [
					...transitions.map(({ at, before, after }) => ({ at, before, after })),
					{ at: later, before: final, after: levelSim.advance(final, later) },
				];
				for (const { at, before, after } of steps) {
					const advanced = levelSim.advance(before, at);
					before.board.forEach((slot, i) => {
						if (slot.status !== "empty") return;

						if (slot.refillAt > at) expect(after.board[i]).toEqual(slot);
						else expect(advanced.board[i]?.status).toBe("open");
					});
				}
			}),
			params,
		);
	});
});

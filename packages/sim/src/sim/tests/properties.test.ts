// The property harness (ADR-0003, section 9, D10): MUST-01.2, MUST-02, MUST-04, MUST-14.1-14.7,
// idempotent advance and the JSON round trip, over the real slice content and over test content
// that reaches every Level, so generated farms run jobs (#84), keep chickens (#86) and trade on the
// order board (#87), with fast-check's fixed seed from the root config.
import fc from "fast-check";
import { afterAll, chai, describe, expect, inject, it, vi } from "vitest";

import { createSim, sliceContent, stateHash } from "../../index.js";
import type { Action, Content, FarmState, Order, Sim } from "../../index.js";
import { assertSafeIntegers } from "../../state/index.js";
import { delay, farmId, play, reachMargin, replay, timedActions } from "../../state/tests/farms.js";
import type { Transition } from "../../state/tests/farms.js";
import { requireProvided } from "../../state/tests/provided.js";
import { listDrawFaults } from "./orderTerms.js";
import { ownedFacility } from "./ownedFacility.js";
import { richContent, richFeedSeconds, richJobXp } from "./richContent.js";

const params = requireProvided("fastCheck", inject("fastCheck"));
// #200: the timeout scales with the run count; Vitest resets it after this file.
vi.setConfig({ testTimeout: inject("propertyTimeout") });
// #357: D10 compares every farm of a run, so over the rich content it takes about half the
// property timeout on CI (median 8.0 s of 15 s over 48 runs) and timed out in 5 of them on slow
// runners (cut off at 15.0 to 15.6 s). Twice the timeout gives those runners about 2x without
// lowering the run count; it applies to both contents, as the test does.
const roundTripTimeout = 2 * inject("propertyTimeout");

// #678: at 1,000 runs MUST-14.5 makes about 1.3 million expect calls a content, and it took 14.3 to
// 15.5 s of its 15 s on CI. Chai's proxy, which only turns a misspelt matcher into an error, cost
// about 1.6 µs of each call's 2.7. Every matcher here is a typed method call, so tsc still fails a
// misspelt one, called or not, and calling one that doesn't exist still throws. Restored after
// this file.
const isProxyUsedBefore = chai.config.useProxy;
chai.config.useProxy = false;
afterAll(() => {
	chai.config.useProxy = isProxyUsedBefore;
});

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

const richRecipes = new Map(
	[...sliceRecipes].map(([id, recipe]) => {
		const ms = id === "chickenFeed" ? [richFeedSeconds * 1000, 48_000, 36_000] : recipe.ms;
		return [id, { ...recipe, ms, xp: richJobXp }] as const;
	}),
);

/**
 * A purchase changes neither XP nor goods: the coins it costs are checked beside it, and `gained`
 * is the wheat it changed, net of the Loop's restarts (MUST-14.5).
 */
function expectOnlyPaid(before: FarmState, after: FarmState, gained: number): void {
	expect(after.xp).toBe(before.xp);
	expect(gained).toBe(0);
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

const wheatIn = (farm: FarmState): number => farm.silo["wheat"] ?? 0;

/** The facility that makes each of the slice's recipes: the feed mill, then the bakery (#84, #85). */
const recipeFacilities = new Map([
	["chickenFeed", 0],
	["bread", 1],
	["cookies", 1],
]);

/**
 * MUST-14.5 with no action between `from` and `to`: goods, XP and coins change only by the
 * Collector's moves and the Loop's restarts, each in a facility that has it (MUST-06.5, 06.6). A
 * recipe's moves are the goods it added to the barn; a facility's restarts are its queue's growth
 * plus its moves, each its last recipe, taking that recipe's wheat and eggs.
 */
function expectAutomated(
	from: FarmState,
	to: FarmState,
	recipes: ReadonlyMap<string, TestRecipe>,
): void {
	let xp = 0;
	const moves = [0, 0];
	for (const [id, made] of recipes) {
		const facility = recipeFacilities.get(id) ?? NaN;
		const moved = ((to.barn[made.good] ?? 0) - (from.barn[made.good] ?? 0)) / made.amount;
		expect(Number.isSafeInteger(moved) && moved >= 0).toBe(true);
		if (moved > 0) expect(from.facilities[facility]?.addOns.collector).toBe(true);
		moves[facility] = (moves[facility] ?? 0) + moved;
		xp += moved * made.xp;
	}
	let wheat = 0;
	let eggs = 0;
	moves.forEach((moved, i) => {
		const owned = from.facilities[i] ?? null;
		const restarts = (to.facilities[i]?.jobs.length ?? 0) - (owned?.jobs.length ?? 0) + moved;
		expect(restarts).toBeGreaterThanOrEqual(0);
		if (restarts === 0) return;

		expect(owned?.addOns.loop).toBe(true);
		const last = recipes.get(owned?.lastRecipe ?? "");
		wheat += restarts * (last?.wheat ?? NaN);
		eggs += restarts * (last?.eggs ?? NaN);
	});
	// No other good changes between actions: chickens lay into their pen, not the barn (#86).
	const made = new Set([...recipes.values()].map(({ good }) => good));
	const others = (barn: FarmState["barn"]): [string, number][] =>
		Object.entries(barn).filter(([good]) => !made.has(good) && good !== "egg");
	expect(Object.fromEntries(others(to.barn))).toEqual(Object.fromEntries(others(from.barn)));
	expect(to.barn["egg"] ?? 0).toBe((from.barn["egg"] ?? 0) - eggs);
	expect(wheatIn(to)).toBe(wheatIn(from) - wheat);
	expect(to.xp).toBe(from.xp + xp);
	expect(to.coins).toBe(from.coins + paidAt(to.xp) - paidAt(from.xp));
}

/**
 * `action` alone on `farm`, already at `at`, without the automated steps apply runs after it:
 * applied with every add-on off, so nothing moves or restarts after it, then with the add-ons
 * back. The action itself doesn't read them. buyAddOn would switch its add-on on and run it, so
 * its farm is the purchase written out: the price paid and the flag set, which its branch and the
 * real farm after it check.
 */
function actAlone(sim: Sim, farm: FarmState, action: Action, at: number): FarmState {
	if (action.type === "buyAddOn") {
		return {
			...farm,
			coins: farm.coins - addOnPrices[action.addOn],
			facilities: farm.facilities.map((owned, i) =>
				owned && i === action.facility
					? { ...owned, addOns: { ...owned.addOns, [action.addOn]: true } }
					: owned,
			),
		};
	}

	const off = { loop: false, collector: false };
	const result = sim.apply(
		{ ...farm, facilities: farm.facilities.map((owned) => owned && { ...owned, addOns: off }) },
		action,
		at,
	);
	if (!result.ok) throw new Error(`the action alone was refused: ${result.reason}`);

	return {
		...result.state,
		facilities: result.state.facilities.map((owned, i) => {
			const had = farm.facilities[i]?.addOns ?? off;
			return (
				owned && {
					...owned,
					addOns: {
						loop: owned.addOns.loop || had.loop,
						collector: owned.addOns.collector || had.collector,
					},
				}
			);
		}),
	};
}

/**
 * The Loop's restarts that apply ran after an action, at its time: in each facility with a Loop,
 * the jobs added behind those the Collector moved are running jobs of the last recipe, each ending
 * the recipe's time at the facility's tier after the later of now and the job before it
 * (MUST-06.5, ADR-0006 §7; #85).
 */
function expectRestarts(
	acted: FarmState,
	after: FarmState,
	recipes: ReadonlyMap<string, TestRecipe>,
): void {
	after.facilities.forEach((owned, i) => {
		const moves = [...recipes].reduce(
			(total, [id, made]) =>
				recipeFacilities.get(id) === i
					? total + ((after.barn[made.good] ?? 0) - (acted.barn[made.good] ?? 0)) / made.amount
					: total,
			0,
		);
		const queue = owned?.jobs ?? [];
		const first = (acted.facilities[i]?.jobs.length ?? 0) - moves;
		const made = recipes.get(owned?.lastRecipe ?? "");
		queue.slice(first).forEach((job, k) => {
			const previous = queue[first + k - 1];
			const from =
				previous?.status === "running" ? Math.max(after.time, previous.readyAt) : after.time;
			expect(job).toEqual({
				status: "running",
				recipe: owned?.lastRecipe,
				readyAt: from + (made?.ms[(owned?.tier ?? NaN) - 1] ?? NaN),
			});
		});
	});
}

/** The test content's cookies XP: from Level 4 (60 to 99 XP), one collect crosses Level 5. */
const cookieXp = 40;

/** `recipe` with the test content's cookies XP if it is the cookies. */
const setCookieXp = <Recipe extends { readonly xp: number }>(id: string, recipe: Recipe): Recipe =>
	id === "cookies" ? { ...recipe, xp: cookieXp } : recipe;

/**
 * Test content where farms bake cookies (#85): 12 XP a harvest reaches the bakery's tier 2 at
 * Level 4 in the start's six harvests (72 XP), and stays below Level 5 with the feed and eggs, so
 * collecting cookies crosses a Level (#197); a 12-good barn holds chicken feed, eggs and cookies
 * together.
 */
const cookieContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	barn: { capacity: 12 },
	crops: { wheat: { ...wheat, xp: 12 } },
	facilities: sliceContent.facilities.map((facility) => ({
		...facility,
		recipes: Object.fromEntries(
			Object.entries(facility.recipes).map(([id, recipe]) => [id, setCookieXp(id, recipe)]),
		),
	})),
};

const cookieRecipes = new Map(
	[...sliceRecipes].map(([id, recipe]) => [id, setCookieXp<TestRecipe>(id, recipe)]),
);

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
					// Refused for its time, not for another reason such as an occupied plot (#41, PR #156's
					// review), and never vacuous: a harvest always joins the log's actions, so an empty log
					// still checks one.
					const early = [...log.map(({ action }) => action), { type: "harvest", plot: 0 } as const];
					for (const action of early) {
						expect(sim.apply(final, action, final.time - back)).toEqual({
							ok: false,
							reason: expect.stringContaining("before the farm's time") as string,
						});
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

	it(
		"every farm survives a JSON round trip (D10)",
		() => {
			fc.assert(
				fc.property(farmId, timedActions, delay, (id, played, wait) => {
					const { farms, final } = play(sim, id, played);
					for (const farm of [...farms, sim.advance(final, addDelay(final, wait))]) {
						expect(JSON.parse(JSON.stringify(farm))).toEqual(farm);
					}
				}),
				params,
			);
		},
		roundTripTimeout,
	);
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
			expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(reachMargin(params.numRuns));
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
			expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(reachMargin(params.numRuns));
		}
	});

	it("bake cookies with eggs at bakery tier 2, are refused at tier 1, and collect them across a Level, so the cookie branches aren't vacuous (#85, #197)", () => {
		const cookieSim = createSim(cookieContent);
		const counts = countReached(
			cookieContent,
			({ action, at, before, after }) => {
				// The farm as the action finds it, after the steps up to its time: a Collector's moves
				// there gain XP too, so the Level the collect crosses is counted from this farm.
				const advanced = cookieSim.advance(before, at);
				const isCookieCollect =
					action.type === "collect" &&
					advanced.facilities[action.facility]?.jobs[0]?.recipe === "cookies";
				return [
					...(action.type === "startJob" && action.recipe === "cookies" ? ["cookies started"] : []),
					...((after.barn["cookies"] ?? 0) > (before.barn["cookies"] ?? 0)
						? ["cookies collected"]
						: []),
					...(isCookieCollect && levelAt(after.xp) > levelAt(advanced.xp)
						? ["cookie collect crosses a Level"]
						: []),
				];
			},
			(reason) =>
				reason === "The bakery makes cookies from tier 2, and it is at tier 1."
					? ["cookies refused at tier 1"]
					: [],
		);

		for (const key of [
			"cookies started",
			"cookies collected",
			"cookie collect crosses a Level",
			"cookies refused at tier 1",
		]) {
			expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(reachMargin(params.numRuns));
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
			expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(reachMargin(params.numRuns));
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
			expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(reachMargin(params.numRuns));
		}
	});
});

describe.each([
	...contents,
	["a farm whose eggs cross Levels and fill the barn", eggContent, sliceRecipes, richEggXp],
	["a farm that bakes cookies", cookieContent, cookieRecipes, 1],
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
				for (const transition of play(levelSim, id, played).transitions) {
					const { action, at } = transition;
					// The automated steps up to the action's time, then the action alone (checked
					// below), then the steps it made due at its time, which apply runs after it.
					const before = levelSim.advance(transition.before, at);
					expectAutomated(transition.before, before, recipes);
					const after = actAlone(levelSim, before, action, at);
					expectAutomated(after, transition.after, recipes);
					expectRestarts(after, transition.after, recipes);
					const gained = wheatIn(after) - wheatIn(before);
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
						expect(gained).toBe(0);
					} else if (action.type === "collectProducts") {
						// Every egg waiting at the action's time goes to the barn, for the content's XP each,
						// with the level-up coins of the Levels it reaches (MUST-02.4, 05.2, 05.4).
						const waiting = levelSim.advance(before, at).pens[0]?.products ?? 0;
						expect(waiting).toBeGreaterThan(0);
						expect(after.barn).toEqual(changeGood(before.barn, "egg", waiting));
						expect(after.pens[0]?.products).toBe(0);
						expect(after.xp).toBe(before.xp + waiting * eggXp);
						expect(after.coins).toBe(before.coins + paidAt(after.xp) - paidAt(before.xp));
						expect(gained).toBe(0);
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
						expect(gained).toBe(0);
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
						const jobs = before.facilities[action.facility]?.jobs ?? [];
						expect(jobs[0]?.status).toBe("done");
						const made = recipes.get(jobs[0]?.recipe ?? "");
						const good = made?.good ?? "";
						expect(after.facilities[action.facility]?.jobs.slice(0, jobs.length - 1)).toEqual(
							jobs.slice(1),
						);
						expect((after.barn[good] ?? 0) - (before.barn[good] ?? 0)).toBe(made?.amount);
						expect(after.xp).toBe(before.xp + (made?.xp ?? NaN));
						expect(after.coins).toBe(before.coins + paidAt(after.xp) - paidAt(before.xp));
						expect(gained).toBe(0);
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
						expectOnlyPaid(before, after, gained);
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
						const owned = before.facilities[action.facility];
						expect(after.coins).toBe(before.coins - addOnPrices[action.addOn]);
						expect(levelAt(after.xp)).toBeGreaterThanOrEqual(addOnLevels[action.addOn]);
						expect(owned?.addOns[action.addOn]).toBe(false);
						// The real farm after it has the add-on on and the facility otherwise as it was, but
						// for the moves and restarts the add-on made due at once, checked above.
						const bought = transition.after.facilities[action.facility];
						expect(bought?.addOns).toEqual({ ...owned?.addOns, [action.addOn]: true });
						expect([bought?.tier, bought?.lastRecipe]).toEqual([owned?.tier, owned?.lastRecipe]);
						expectOnlyPaid(before, after, gained);
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
				// Apart from the actions, only the add-ons change the barn's feed and eggs: the Collector
				// moves what the mill made in, and a Loop baking cookies takes eggs out (#88), before an
				// action or right after it; expectAutomated pins both to them.
				const inBarn = (farm: FarmState): number =>
					(farm.barn["chickenFeed"] ?? 0) + (farm.barn["egg"] ?? 0);
				let made = 0;
				for (const { action, at, before, after } of transitions) {
					const advanced = levelSim.advance(before, at);
					const acted = actAlone(levelSim, advanced, action, at);
					made += inBarn(advanced) - inBarn(before) + inBarn(after) - inBarn(acted);
					if (action.type === "collect") {
						const [job] = advanced.facilities[action.facility]?.jobs ?? [];
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
				const last = levelSim.advance(final, addDelay(final, wait));
				expect(countFeedAndEggs(last)).toBe(made + inBarn(last) - inBarn(final));
			}),
			params,
		);
	});

	it("MUST-03.3, 06.7: no action moves a stored job finish, a tier bought included", () => {
		checkTransitions(levelSim, ({ action, at, before }) => {
			// The action alone: the Collector's moves after it take whole jobs, checked in MUST-14.5.
			const advanced = levelSim.advance(before, at);
			const after = actAlone(levelSim, advanced, action, at);
			advanced.facilities.forEach((owned, facility) => {
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

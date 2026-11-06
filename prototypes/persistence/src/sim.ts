// Tiny spike sim (ADR-0001, issues #5 and #6): 6 wheat plots with a seeded bonus yield, a bakery
// that bakes up to 3 queued loaves one after another, and gifts. A bake job's state follows from
// its `readyAt`, so `advance` only has to ripen plots.
// Pure: time arrives as an argument (integer ms), randomness comes from `rng` in the farm.
// The one exception is `stateHash`, which uses node:crypto (ADR-0001: an open M2 decision).

import { createHash } from "node:crypto";

export const PLOTS = 6;
export const GROW_MS = 2 * 60_000;
export const BASE_YIELD = 2;
/** 10% of 2^32: a draw below this gives +1 wheat. */
export const BONUS_BELOW = 429_496_730;
export const BREAD_WHEAT = 3;
export const BAKE_MS = 5 * 60_000;
export const BAKERY_SLOTS = 3;

export type Plot =
  | { status: "empty" }
  | { status: "growing"; readyAt: number }
  | { status: "ready" };

export type FarmState = {
  plots: Plot[];
  wheat: number;
  bread: number;
  /** Bread being baked, queued or baked and waiting to be collected, in the order it was ordered. */
  bakery: BakeJob[];
  /** PRNG state (mulberry32), an unsigned 32-bit integer. */
  rng: number;
};

/** One loaf: it is ready at `readyAt` and stays in the bakery until it is collected. */
export type BakeJob = { readyAt: number };

/** What a gift holds. Whole, non-negative amounts, at least one of them above zero. */
export type Goods = { wheat: number; bread: number };

export type Action =
  | { type: "plant"; plot: number }
  | { type: "harvest"; plot: number }
  | { type: "bake" }
  | { type: "collect" }
  /** The goods leave this farm now; the inbox (#8) gives the gift its id, `<senderId>:<seq>`. */
  | { type: "sendGift"; to: string; goods: Goods }
  /** The server fills `goods` from the inbox before `apply`, so replay never reads another farm. */
  | { type: "claimGift"; giftId: string; goods: Goods };

export type ApplyResult = { ok: true; state: FarmState } | { ok: false; reason: string };

export function newFarm(seed: number): FarmState {
  return {
    plots: Array.from({ length: PLOTS }, () => ({ status: "empty" }) as const),
    wheat: 0,
    bread: 0,
    bakery: [],
    rng: seed >>> 0,
  };
}

/** Brings a farm up to time `to`: growing plots whose time has come become ready. */
export function advance(state: FarmState, to: number): FarmState {
  if (!Number.isSafeInteger(to)) throw new RangeError(`time must be integer ms, got ${to}`);
  return {
    ...state,
    plots: state.plots.map((p) =>
      p.status === "growing" && p.readyAt <= to ? { status: "ready" } : p,
    ),
  };
}

/** Applies one action at time `at`, advancing to `at` first. Never throws on a refused action. */
export function apply(state: FarmState, action: Action, at: number): ApplyResult {
  if (!Number.isSafeInteger(at)) return { ok: false, reason: `time must be integer ms, got ${at}` };
  const farm = advance(state, at);
  if (action.type === "bake") return bake(farm, at);
  if (action.type === "collect") return collect(farm, at);
  if (action.type === "sendGift") return sendGift(farm, action.goods);
  if (action.type === "claimGift") return claimGift(farm, action.goods);
  const plot = farm.plots[action.plot];
  if (!plot) return { ok: false, reason: `no plot ${action.plot}` };

  if (action.type === "plant") {
    if (plot.status !== "empty") return { ok: false, reason: `plot ${action.plot} is not empty` };
    return { ok: true, state: withPlot(farm, action.plot, { status: "growing", readyAt: at + GROW_MS }) };
  }

  if (plot.status !== "ready") return { ok: false, reason: `plot ${action.plot} is not ready` };
  const draw = mulberry32(farm.rng);
  const bonus = draw.value < BONUS_BELOW ? 1 : 0;
  return {
    ok: true,
    state: { ...withPlot(farm, action.plot, { status: "empty" }), wheat: farm.wheat + BASE_YIELD + bonus, rng: draw.next },
  };
}

function bake(farm: FarmState, at: number): ApplyResult {
  if (farm.wheat < BREAD_WHEAT) return { ok: false, reason: `baking needs ${BREAD_WHEAT} wheat, have ${farm.wheat}` };
  if (farm.bakery.length >= BAKERY_SLOTS) return { ok: false, reason: `the bakery is full (${BAKERY_SLOTS} jobs)` };
  // One job at a time: a job starts when it is ordered or when the job before it finishes.
  const last = farm.bakery.at(-1);
  const startsAt = last ? Math.max(at, last.readyAt) : at;
  const job = { readyAt: startsAt + BAKE_MS };
  return { ok: true, state: { ...farm, wheat: farm.wheat - BREAD_WHEAT, bakery: [...farm.bakery, job] } };
}

function collect(farm: FarmState, at: number): ApplyResult {
  const baked = farm.bakery.filter((j) => j.readyAt <= at).length;
  if (baked === 0) return { ok: false, reason: "no bread is ready to collect" };
  return { ok: true, state: { ...farm, bread: farm.bread + baked, bakery: farm.bakery.slice(baked) } };
}

function sendGift(farm: FarmState, goods: Goods): ApplyResult {
  const invalid = invalidGoods(goods);
  if (invalid) return { ok: false, reason: invalid };
  if (goods.wheat > farm.wheat || goods.bread > farm.bread) {
    return { ok: false, reason: `the farm has ${farm.wheat} wheat and ${farm.bread} bread` };
  }
  return { ok: true, state: { ...farm, wheat: farm.wheat - goods.wheat, bread: farm.bread - goods.bread } };
}

function claimGift(farm: FarmState, goods: Goods): ApplyResult {
  const invalid = invalidGoods(goods);
  if (invalid) return { ok: false, reason: invalid };
  return { ok: true, state: { ...farm, wheat: farm.wheat + goods.wheat, bread: farm.bread + goods.bread } };
}

function invalidGoods(goods: Goods): string | null {
  const amounts = [goods.wheat, goods.bread];
  if (!amounts.every((n) => Number.isSafeInteger(n) && n >= 0)) return "gift amounts must be whole and not negative";
  if (amounts.every((n) => n === 0)) return "a gift must hold some goods";
  return null;
}

/** SHA-256 (hex) over JSON with object keys sorted at every level. */
export function stateHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function withPlot(farm: FarmState, index: number, plot: Plot): FarmState {
  return { ...farm, plots: farm.plots.map((p, i) => (i === index ? plot : p)) };
}

/** mulberry32: one step returns the next PRNG state and a uniform unsigned 32-bit value. */
export function mulberry32(state: number): { next: number; value: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { next, value: (t ^ (t >>> 14)) >>> 0 };
}

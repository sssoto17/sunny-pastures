// Tiny spike sim (ADR-0001, issue #5): 6 wheat plots, a seeded bonus yield.
// Pure: time arrives as an argument (integer ms), randomness comes from `rng` in the farm.
// The one exception is `stateHash`, which uses node:crypto (ADR-0001: an open M2 decision).

import { createHash } from "node:crypto";

export const PLOTS = 6;
export const GROW_MS = 2 * 60_000;
export const BASE_YIELD = 2;
/** 10% of 2^32: a draw below this gives +1 wheat. */
export const BONUS_BELOW = 429_496_730;

export type Plot =
  | { status: "empty" }
  | { status: "growing"; readyAt: number }
  | { status: "ready" };

export type FarmState = {
  plots: Plot[];
  wheat: number;
  /** PRNG state (mulberry32), an unsigned 32-bit integer. */
  rng: number;
};

export type Action = { type: "plant"; plot: number } | { type: "harvest"; plot: number };

export type ApplyResult = { ok: true; state: FarmState } | { ok: false; reason: string };

export function newFarm(seed: number): FarmState {
  return {
    plots: Array.from({ length: PLOTS }, () => ({ status: "empty" }) as const),
    wheat: 0,
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
function mulberry32(state: number): { next: number; value: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { next, value: (t ^ (t >>> 14)) >>> 0 };
}

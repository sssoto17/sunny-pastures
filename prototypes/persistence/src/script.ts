// The gate's scripted player (ADR-0001, issue #6): a fixed seed gives the same 500 actions every
// time. It plays a shadow farm through the sim, so most actions are ones the rules accept, and
// now and then it sends an action the sim must refuse.

import {
  advance,
  apply,
  BAKERY_SLOTS,
  BREAD_WHEAT,
  mulberry32,
  newFarm,
  PLOTS,
  type Action,
  type FarmState,
} from "./sim.ts";

export type ScriptStep = { action: Action; at: number };
/** `seed` is both the farm's seed (`newFarm(seed)`) and the generator's. */
export type Script = { seed: number; steps: ScriptStep[] };

export const SCRIPT_LENGTH = 500;
/** The player is away for 8 hours before this step, so it meets offline progress. */
export const GAP_BEFORE_STEP = 250;

const SECOND = 1_000;
const HOUR = 60 * 60_000;
const FRIENDS = ["bob", "cleo"];
const SENDERS = ["alice", "dev"];
/** Chances per step; otherwise the player farms or bakes. */
const P_INVALID = 0.05;
const P_SEND = 0.04;
const P_CLAIM = 0.04;

export function generateScript(seed: number): Script {
  const rand = random(seed ^ 0x5eed);
  let farm = newFarm(seed);
  let t = 0;
  let claims = 0;
  const steps: ScriptStep[] = [];

  while (steps.length < SCRIPT_LENGTH) {
    t += steps.length === GAP_BEFORE_STEP ? 8 * HOUR : rand.int(2, 8) * SECOND;
    const now = advance(farm, t);
    const roll = rand.float();

    let action: Action | undefined;
    if (roll < P_INVALID) action = rand.pick(refusedActions(now, t));
    else if (roll < P_INVALID + P_SEND) action = giftToSend(now, rand);
    else if (roll < P_INVALID + P_SEND + P_CLAIM) {
      // Gift ids are `<senderId>:<seq>`; in the game the seq is the sender's (#8).
      claims++;
      const goods = { wheat: rand.int(0, 4), bread: rand.int(1, 2) };
      action = { type: "claimGift", giftId: `${rand.pick(SENDERS)}:${claims * 7}`, goods };
    }
    action ??= rand.pickOrNone(acceptedActions(now, t));
    if (!action) continue; // nothing to do yet: wait a little longer

    const result = apply(farm, action, t);
    if (result.ok) farm = result.state;
    steps.push({ action, at: t });
  }
  return { seed, steps };
}

/** Farming and baking moves the rules accept at `t` (gifts are chosen separately). */
function acceptedActions(farm: FarmState, t: number): Action[] {
  const actions: Action[] = [];
  farm.plots.forEach((p, plot) => {
    if (p.status === "empty") actions.push({ type: "plant", plot });
    if (p.status === "ready") actions.push({ type: "harvest", plot });
  });
  if (farm.wheat >= BREAD_WHEAT && farm.bakery.length < BAKERY_SLOTS) actions.push({ type: "bake" });
  if (farm.bakery.some((j) => j.readyAt <= t)) actions.push({ type: "collect" });
  return actions;
}

function giftToSend(farm: FarmState, rand: Random): Action | undefined {
  if (farm.wheat === 0 && farm.bread === 0) return undefined;
  const goods = { wheat: rand.int(0, farm.wheat), bread: rand.int(0, farm.bread) };
  if (goods.wheat + goods.bread === 0) {
    if (farm.wheat > 0) goods.wheat = 1;
    else goods.bread = 1;
  }
  return { type: "sendGift", to: rand.pick(FRIENDS), goods };
}

/** Deliberately invalid actions: each candidate is kept only if the sim refuses it at `t`. */
function refusedActions(farm: FarmState, t: number): Action[] {
  const candidates: Action[] = [
    { type: "plant", plot: PLOTS },
    { type: "claimGift", giftId: "alice:0", goods: { wheat: 0, bread: 0 } },
    { type: "sendGift", to: "bob", goods: { wheat: farm.wheat + 1, bread: 0 } },
    { type: "bake" },
    { type: "collect" },
    ...farm.plots.map((_, plot): Action => ({ type: "plant", plot })),
    ...farm.plots.map((_, plot): Action => ({ type: "harvest", plot })),
  ];
  return candidates.filter((a) => !apply(farm, a, t).ok);
}

type Random = ReturnType<typeof random>;

/** The generator's own PRNG stream, separate from the farm's. */
function random(seed: number) {
  let state = seed >>> 0;
  const float = () => {
    const draw = mulberry32(state);
    state = draw.next;
    return draw.value / 2 ** 32;
  };
  const int = (min: number, max: number) => min + Math.floor(float() * (max - min + 1));
  const pick = <T>(items: T[]): T => items[int(0, items.length - 1)]!;
  return {
    float,
    int,
    pick,
    pickOrNone: <T>(items: T[]): T | undefined => (items.length === 0 ? undefined : pick(items)),
  };
}

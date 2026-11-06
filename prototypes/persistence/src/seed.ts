// Seeding for the load runs (#10, SPIKE_CLOCK=1 only): gives each player about 1,000 accepted
// actions before a run, so B's replay tails look like a farm that has been played for a while.
// Player i of a seed gets 1,000 + (i × 37) mod 100 actions: 37 is coprime to 100 and 25, so the
// tails (seq mod N) spread across 0 to N−1 for B25 and B100 even with few players.
//
// Seeding goes through the store's own `commit`, one action at a time, so the rows are exactly
// what live traffic would write (B's snapshots at the same seqs, B1's upsert, A's processed keys)
// and there is no second write path to get wrong. It skips the HTTP layer and the handler's
// load per action, which is what makes it fast enough.

import { apply, BAKERY_SLOTS, BREAD_WHEAT, mulberry32, stateHash, type Action, type FarmState } from "./sim.ts";
import type { GameStore } from "./store.ts";

export type SeedRequest = { prefix: string; players: number; actions: number };
export type SeedResult = { seeded: number; skipped: number; farms: { farm: string; seq: number }[] };

export const MAX_SEED_PLAYERS = 1000;
const MAX_SEED_ACTIONS = 100_000;
/** Spread of the tails: the largest snapshot interval measured (B100). */
const TAIL_SPREAD = 100;
const TAIL_STRIDE = 37;
/** The seeded history ends this long before the seed request's server time. */
const END_BEFORE_NOW_MS = 60_000;
/** Farms seeded at once; each farm's own actions are committed one after another. */
const PARALLEL_FARMS = 8;

/** Returns the request, or a reason it is malformed. */
export function parseSeedRequest(body: unknown): SeedRequest | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { prefix, players, actions = 1000 } = body as Record<string, unknown>;
  if (typeof prefix !== "string" || !/^[\w-]{1,40}$/.test(prefix)) return "prefix must match [\\w-]{1,40}";
  if (!isIntIn(players, 1, MAX_SEED_PLAYERS)) return `players must be an integer from 1 to ${MAX_SEED_PLAYERS}`;
  if (!isIntIn(actions, 1, MAX_SEED_ACTIONS)) return `actions must be an integer from 1 to ${MAX_SEED_ACTIONS}`;
  return { prefix, players, actions };
}

function isIntIn(x: unknown, min: number, max: number): x is number {
  return Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
}

/** Seeds farms `<prefix>-0` … `<prefix>-<players−1>`; a farm that already has actions is skipped. */
export async function seedFarms(store: GameStore, req: SeedRequest, now: number): Promise<SeedResult> {
  const farms = Array.from({ length: req.players }, (_, i) => ({
    farm: `${req.prefix}-${i}`,
    count: req.actions + ((i * TAIL_STRIDE) % TAIL_SPREAD),
  }));
  const results: { farm: string; seq: number; seeded: boolean }[] = new Array(farms.length);
  let next = 0;
  const worker = async () => {
    while (next < farms.length) {
      const i = next++;
      const { farm, count } = farms[i]!;
      results[i] = await seedFarm(store, farm, count, now - END_BEFORE_NOW_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_FARMS, farms.length) }, worker));
  const seeded = results.filter((r) => r.seeded).length;
  return { seeded, skipped: results.length - seeded, farms: results.map(({ farm, seq }) => ({ farm, seq })) };
}

async function seedFarm(store: GameStore, farm: string, count: number, endAt: number) {
  const first = await store.load(farm);
  if (first.seq > 0) return { farm, seq: first.seq, seeded: false };

  let state = first.state;
  for (const [i, { action, at }] of history(first.state, count, endAt).entries()) {
    const seq = i + 1;
    const result = apply(state, action, at);
    if (!result.ok) throw new Error(`seed ${farm}: action ${seq} refused: ${result.reason}`);
    state = result.state;
    const outcome = await store.commit(farm, {
      expectedSeq: seq - 1,
      action,
      at,
      idempotencyKey: `seed-${seq}`,
      next: state,
      answer: { seq, hash: stateHash(state), rebased: false, retries: 0 },
    });
    if (outcome.kind !== "committed") throw new Error(`seed ${farm}: action ${seq} was not committed (${outcome.kind})`);
  }
  return { farm, seq: count, seeded: true };
}

/**
 * `count` actions an active player would make, 2–8 s apart, waiting when there is nothing to do;
 * shifted so the last one is at `endAt`. Plant, harvest, bake and collect, the live load mix
 * (#11); gifts stay out, as they do in Locust.
 */
function history(start: FarmState, count: number, endAt: number): { action: Action; at: number }[] {
  let rng = (start.rng ^ 0x5eed) >>> 0;
  const draw = () => {
    const d = mulberry32(rng);
    rng = d.next;
    return d.value / 2 ** 32;
  };
  const steps: { action: Action; at: number }[] = [];
  let farm = start;
  let t = 0;
  while (steps.length < count) {
    const choices: Action[] = [];
    let nextRipe = Infinity;
    farm.plots.forEach((p, plot) => {
      if (p.status === "empty") choices.push({ type: "plant", plot });
      else if (p.status === "ready" || p.readyAt <= t) choices.push({ type: "harvest", plot });
      else nextRipe = Math.min(nextRipe, p.readyAt);
    });
    if (farm.wheat >= BREAD_WHEAT && farm.bakery.length < BAKERY_SLOTS) choices.push({ type: "bake" });
    if (farm.bakery.some((j) => j.readyAt <= t)) choices.push({ type: "collect" });
    else if (farm.bakery.length > 0) nextRipe = Math.min(nextRipe, farm.bakery[0]!.readyAt);
    if (choices.length === 0) {
      t = nextRipe;
      continue;
    }
    const action = choices[Math.floor(draw() * choices.length)]!;
    const result = apply(farm, action, t);
    if (!result.ok) throw new Error(`seed history: ${result.reason}`); // a bug in this generator
    farm = result.state;
    steps.push({ action, at: t });
    t += 2_000 + Math.floor(draw() * 6_001);
  }
  const shift = endAt - steps.at(-1)!.at;
  return steps.map((s) => ({ action: s.action, at: s.at + shift }));
}

// The strategy factory (ADR-0001): picks store A, B1, B25 or B100 from STORE and SNAPSHOT_N, and
// is the composition root that hands the stores what they need from the sim. Stores import only
// the sim's types; the functions that run the rules (`newFarm`, B's `replay`) come in from here.

import type { Sql } from "postgres";
import { advance, apply, newFarm, type FarmState } from "./sim.ts";
import { createStoreA } from "./store-a.ts";
import { createStoreB, type Replay, type SnapshotN } from "./store-b.ts";
import type { GameStore } from "./store.ts";

export type StoreConfig = { name: "A" } | { name: `B${SnapshotN}`; snapshotN: SnapshotN };

const SNAPSHOT_NS: readonly SnapshotN[] = [1, 25, 100];

/** Reads STORE (A by default) and SNAPSHOT_N (required for B). Throws on anything else. */
export function storeConfig(env: { STORE?: string; SNAPSHOT_N?: string }): StoreConfig {
  const store = (env.STORE ?? "A").toUpperCase();
  if (store === "A") {
    if (env.SNAPSHOT_N !== undefined) throw new Error("SNAPSHOT_N only applies to STORE=B");
    return { name: "A" };
  }
  if (store !== "B") throw new Error(`STORE must be A or B, got ${env.STORE}`);
  const n = SNAPSHOT_NS.find((k) => String(k) === env.SNAPSHOT_N);
  if (n === undefined) throw new Error(`STORE=B needs SNAPSHOT_N=1, 25 or 100, got ${env.SNAPSHOT_N ?? "nothing"}`);
  return { name: `B${n}`, snapshotN: n };
}

/** Rebuilds a farm the way the handler built it: each action applied at its own time. */
export const replay: Replay = (state, actions, to) => {
  let farm = state;
  actions.forEach(({ action, at }, i) => {
    const r = apply(advance(farm, at), action, at);
    if (!r.ok) {
      // A logged action the rules now refuse means the sim isn't deterministic: never skip it.
      throw new Error(`replay refused action ${i + 1} of ${actions.length} (${JSON.stringify(action)}): ${r.reason}`);
    }
    farm = r.state;
  });
  return advance(farm, to);
};

/** A farm's first state. The PRNG seed comes from its id, so it is the same on every server. */
export function firstFarm(playerId: string): FarmState {
  return newFarm(fnv1a(playerId));
}

/** The Postgres schema a configuration's tables live in: one per store variant. */
export function storeSchema(config: StoreConfig): string {
  return `store_${config.name.toLowerCase()}`;
}

export function createStore(sql: Sql, config: StoreConfig, schema = storeSchema(config)): Promise<GameStore> {
  return config.name === "A"
    ? createStoreA(sql, { schema, newFarm: firstFarm })
    : createStoreB(sql, { schema, snapshotN: config.snapshotN, newFarm: firstFarm, replay });
}

/** FNV-1a over the farm id: a stable seed, so a farm's bonus rolls don't depend on the server. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

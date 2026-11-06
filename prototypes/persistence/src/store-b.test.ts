// Store B against the real local Postgres (DATABASE_URL), once per snapshot interval.
// Each run uses its own throwaway schemas.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { advance, apply, newFarm, type Action, type FarmState } from "./sim.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import { connect } from "./store-a.ts";
import { createStoreB, type Replay, type SnapshotN } from "./store-b.ts";
import { replay } from "./stores.ts";
import { StoreError, type Answer, type AuditableStore, type CommitEntry } from "./store.ts";

const url = process.env.DATABASE_URL;

function answer(seq: number): Answer {
  return { seq, hash: `hash-${seq}`, rebased: false, retries: 0 };
}

/** The entry the handler would commit for `action` at `at` on top of a farm at `expectedSeq`. */
function entry(farm: FarmState, expectedSeq: number, action: Action, at: number, idempotencyKey: string): CommitEntry {
  const r = apply(advance(farm, at), action, at);
  if (!r.ok) throw new Error(r.reason);
  return { expectedSeq, action, at, idempotencyKey, next: r.state, answer: answer(expectedSeq + 1) };
}

const plant = (plot: number): Action => ({ type: "plant", plot });
const harvest = (plot: number): Action => ({ type: "harvest", plot });

const GROW = 2 * 60_000;

/**
 * Commits `count` actions to a new farm: plant and harvest plot 0 in turn, one every 2 min, so
 * action i (from 1) takes effect at (i - 1) * 2 min. Returns the farm after each action
 * (index 0 is the new farm), as the handler computed it.
 */
async function play(store: AuditableStore, farmId: string, count: number): Promise<FarmState[]> {
  const farms = [newFarm(1)];
  for (let seq = 1; seq <= count; seq++) {
    const e = entry(farms[seq - 1]!, seq - 1, seq % 2 === 1 ? plant(0) : harvest(0), (seq - 1) * GROW, `k${seq}`);
    assert.deepStrictEqual(await store.commit(farmId, e), { kind: "committed", seq });
    farms.push(e.next);
  }
  return farms;
}

/** A replay that records how many actions each call was given. */
function countingReplay(): Replay & { calls: number[] } {
  const calls: number[] = [];
  return Object.assign((state: FarmState, actions: { action: Action; at: number }[], to: number) => {
    calls.push(actions.length);
    return replay(state, actions, to);
  }, { calls });
}

for (const n of [1, 25, 100] as const satisfies readonly SnapshotN[]) {
  describe(`store B${n}`, { skip: url ? false : "DATABASE_URL not set" }, () => {
    const sql = connect(url!);
    const schema = `store_b${n}_test_${process.pid}_${Date.now()}`;
    let store: AuditableStore;
    let inbox: Inbox;

    before(async () => {
      inbox = await createInbox(sql, { schema: `${schema}_inbox` });
      store = await createStoreB(sql, { schema, snapshotN: n, newFarm: () => newFarm(1), replay, inbox });
    });

    after(async () => {
      await sql`drop schema if exists ${sql(schema)} cascade`;
      await sql`drop schema if exists ${sql(`${schema}_inbox`)} cascade`;
      await sql.end();
    });

    test("an unknown farm loads as a new farm at seq 0", async () => {
      assert.deepStrictEqual(await store.load("nobody"), { state: newFarm(1), seq: 0, at: 0 });
    });

    test("a committed farm loads back strictly equal, types included", async () => {
      const e = entry(newFarm(1), 0, plant(0), 1_000, "k1");
      assert.deepStrictEqual(await store.commit("round-trip", e), { kind: "committed", seq: 1 });
      assert.deepStrictEqual(await store.load("round-trip"), { state: e.next, seq: 1, at: 1_000 });
    });

    test("a commit only succeeds while the farm is still at expectedSeq", async () => {
      const first = entry(newFarm(1), 0, plant(0), 0, "a");
      await store.commit("lock", first);

      const stale = await store.commit("lock", entry(newFarm(1), 0, plant(1), 5, "b"));
      assert.deepStrictEqual(stale, { kind: "conflict" });
      const ahead = await store.commit("lock", entry(first.next, 3, plant(1), 5, "c"));
      assert.deepStrictEqual(ahead, { kind: "conflict" }, "a seq gap is refused too");

      assert.deepStrictEqual(await store.load("lock"), { state: first.next, seq: 1, at: 0 }, "the losing commits wrote nothing");
      assert.equal(await store.processed("lock", "b"), null, "the losing commit did not use up its key");
      assert.equal(await store.processed("lock", "c"), null);
    });

    test("a repeated idempotency key returns the first answer and writes nothing", async () => {
      const first = { ...entry(newFarm(1), 0, plant(0), 0, "same"), answer: { seq: 1, hash: "first", rebased: true, retries: 2 } };
      await store.commit("idem", first);

      assert.deepStrictEqual(await store.processed("idem", "same"), first.answer);
      const again = await store.commit("idem", entry(first.next, 1, plant(1), 9, "same"));
      assert.deepStrictEqual(again, { kind: "duplicate", answer: first.answer });
      assert.deepStrictEqual(await store.load("idem"), { state: first.next, seq: 1, at: 0 });
    });

    test("keys are scoped to their farm", async () => {
      await store.commit("farm-x", entry(newFarm(1), 0, plant(0), 0, "shared"));
      assert.equal(await store.processed("farm-y", "shared"), null);
    });

    test(`load replays only the actions after the latest snapshot (every ${n === 1 ? "action, overwritten" : `${n}th action`})`, async () => {
      const farms = await play(store, "policy", 30);
      const counting = countingReplay();
      const reader = await createStoreB(sql, { schema, snapshotN: n, newFarm: () => newFarm(1), replay: counting, inbox });

      const loaded = await reader.load("policy");
      assert.deepStrictEqual(loaded, { state: farms[30], seq: 30, at: 29 * GROW });
      const expectedTail = { 1: 0, 25: 5, 100: 30 }[n];
      assert.deepStrictEqual(counting.calls, expectedTail === 0 ? [] : [expectedTail]);
    });

    test("load throws a store error when bigint columns arrive as strings", async () => {
      // A client without the bigint parser returns int8 as strings. "round-trip" has one action:
      // B1 meets the strings in its snapshot row, B25 and B100 in the log row they replay.
      const raw = postgres(url!, { onnotice: () => {} });
      try {
        const unguarded = await createStoreB(raw, { schema, snapshotN: n, newFarm: () => newFarm(1), replay, inbox });
        await assert.rejects(unguarded.load("round-trip"), StoreError);
      } finally {
        await raw.end();
      }
    });

    test("stateAt an earlier time returns that time's farm; an action at exactly t counts", async () => {
      const farms = await play(store, "audit", 30); // action i takes effect at (i - 1) * 2 min
      // Action 12 (a harvest) is at 22 min: just before it the farm is as after action 11.
      assert.deepStrictEqual(await store.stateAt("audit", 22 * 60_000 - 1), farms[11]);
      assert.deepStrictEqual(await store.stateAt("audit", 22 * 60_000), farms[12]);
      assert.equal(farms[12]!.wheat >= 12, true, "six harvests happened by then");
      assert.deepStrictEqual(await store.stateAt("audit", 29 * GROW), farms[30], "at the last action: the current farm");
    });

    test("stateAt advances to t after the last action before it", async () => {
      await store.commit("ripen", entry(newFarm(1), 0, plant(2), 60_000, "p"));
      assert.deepStrictEqual((await store.stateAt("ripen", 60_000 + GROW - 1)).plots[2], { status: "growing", readyAt: 60_000 + GROW });
      assert.deepStrictEqual((await store.stateAt("ripen", 60_000 + GROW)).plots[2], { status: "ready" });
    });

    test("stateAt before a farm's first action is the new farm", async () => {
      await store.commit("late", entry(newFarm(1), 0, plant(0), 10 * GROW, "p"));
      assert.deepStrictEqual(await store.stateAt("late", 10 * GROW - 1), newFarm(1));
      assert.deepStrictEqual(await store.stateAt("nobody-yet", 5), newFarm(1));
    });

    test("stateAt starts from the latest snapshot at or before t", async () => {
      await play(store, "audit-from", 30);
      const counting = countingReplay();
      const reader = await createStoreB(sql, { schema, snapshotN: n, newFarm: () => newFarm(1), replay: counting, inbox });

      await reader.stateAt("audit-from", 27 * GROW); // actions 1..28
      // B1 keeps only its latest snapshot (seq 30, after t), so it replays from the new farm.
      assert.deepStrictEqual(counting.calls, [{ 1: 28, 25: 3, 100: 28 }[n]]);
    });

    test("two racing commits at one seq: one is committed, the other conflicts and leaves no trace", async () => {
      await play(store, "race", 3);
      const farm = (await store.load("race")).state;
      const results = await Promise.all([
        store.commit("race", entry(farm, 3, plant(1), 6 * GROW, "left")),
        store.commit("race", entry(farm, 3, plant(2), 6 * GROW, "right")),
      ]);
      assert.deepStrictEqual(results.map((r) => r.kind).sort(), ["committed", "conflict"]);
      const loser = results[0]!.kind === "conflict" ? "left" : "right";
      assert.equal(await store.processed("race", loser), null);
      assert.equal((await store.load("race")).seq, 4);
    });

    test("the same key sent twice at once: one commit, and the other gets its answer", async () => {
      const e = entry(newFarm(1), 0, plant(0), 0, "twice");
      const results = await Promise.all([store.commit("resend", e), store.commit("resend", e)]);
      assert.deepStrictEqual(
        results.map((r) => r.kind).sort(),
        ["committed", "duplicate"],
      );
      assert.deepStrictEqual(results.find((r) => r.kind === "duplicate"), { kind: "duplicate", answer: e.answer });
    });
  });
}

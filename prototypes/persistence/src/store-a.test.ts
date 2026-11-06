// Store A against the real local Postgres (DATABASE_URL). Each run uses its own throwaway schema.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { apply, newFarm, type FarmState } from "./sim.ts";
import { connect, createStoreA } from "./store-a.ts";
import { StoreError, type Answer, type GameStore } from "./store.ts";

const url = process.env.DATABASE_URL;
const schema = `store_a_test_${process.pid}_${Date.now()}`;

function planted(plot: number, at: number, farm: FarmState = newFarm(1)): FarmState {
  const r = apply(farm, { type: "plant", plot }, at);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}

function answer(seq: number): Answer {
  return { seq, hash: `hash-${seq}`, rebased: false, retries: 0 };
}

describe("store A", { skip: url ? false : "DATABASE_URL not set" }, () => {
  const sql = connect(url!);
  let store: GameStore;

  before(async () => {
    store = await createStoreA(sql, { schema, newFarm: () => newFarm(1) });
  });

  after(async () => {
    await sql`drop schema if exists ${sql(schema)} cascade`;
    await sql.end();
  });

  test("an unknown farm loads as a new farm at seq 0", async () => {
    assert.deepStrictEqual(await store.load("nobody"), { state: newFarm(1), seq: 0, at: 0 });
  });

  test("a committed farm loads back strictly equal, types included", async () => {
    const next = planted(0, 1_000);
    const result = await store.commit("round-trip", {
      expectedSeq: 0, action: { type: "plant", plot: 0 }, at: 1_000, idempotencyKey: "k1", next, answer: answer(1),
    });
    assert.deepStrictEqual(result, { kind: "committed", seq: 1 });
    assert.deepStrictEqual(await store.load("round-trip"), { state: next, seq: 1, at: 1_000 });
  });

  test("a commit only succeeds while the farm is still at expectedSeq", async () => {
    const first = planted(0, 0);
    await store.commit("lock", { expectedSeq: 0, action: { type: "plant", plot: 0 }, at: 0, idempotencyKey: "a", next: first, answer: answer(1) });

    const stale = await store.commit("lock", {
      expectedSeq: 0, action: { type: "plant", plot: 1 }, at: 5, idempotencyKey: "b", next: planted(1, 5), answer: answer(1),
    });
    assert.deepStrictEqual(stale, { kind: "conflict" });
    assert.deepStrictEqual(await store.load("lock"), { state: first, seq: 1, at: 0 }, "the losing commit wrote nothing");
    assert.equal(await store.processed("lock", "b"), null, "the losing commit did not use up its key");
  });

  test("a repeated idempotency key returns the first answer and writes nothing", async () => {
    const first = planted(0, 0);
    const firstAnswer: Answer = { seq: 1, hash: "first", rebased: true, retries: 2 };
    await store.commit("idem", { expectedSeq: 0, action: { type: "plant", plot: 0 }, at: 0, idempotencyKey: "same", next: first, answer: firstAnswer });

    assert.deepStrictEqual(await store.processed("idem", "same"), firstAnswer);
    const again = await store.commit("idem", {
      expectedSeq: 1, action: { type: "plant", plot: 1 }, at: 9, idempotencyKey: "same", next: planted(1, 9, first), answer: answer(2),
    });
    assert.deepStrictEqual(again, { kind: "duplicate", answer: firstAnswer });
    assert.deepStrictEqual(await store.load("idem"), { state: first, seq: 1, at: 0 });
  });

  test("keys are scoped to their farm", async () => {
    await store.commit("farm-x", { expectedSeq: 0, action: { type: "plant", plot: 0 }, at: 0, idempotencyKey: "shared", next: planted(0, 0), answer: answer(1) });
    assert.equal(await store.processed("farm-y", "shared"), null);
  });

  test("load throws a store error when bigint columns arrive as strings", async () => {
    // A client without the bigint parser: postgres.js then returns int8 columns as strings.
    const raw = postgres(url!, { onnotice: () => {} });
    try {
      const unguarded = await createStoreA(raw, { schema, newFarm: () => newFarm(1) });
      await assert.rejects(unguarded.load("round-trip"), StoreError);
    } finally {
      await raw.end();
    }
  });
});

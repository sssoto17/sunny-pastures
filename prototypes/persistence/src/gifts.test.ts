// Gifts end to end (#8) in every store, against the real local Postgres (DATABASE_URL). Each run
// uses its own throwaway schemas: one per store, plus one inbox shared by all four, as in the spike.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { advance, apply, newFarm, type Action, type FarmState } from "./sim.ts";
import { handleAction } from "./handler.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import { connect, createStoreA } from "./store-a.ts";
import { createStoreB } from "./store-b.ts";
import { replay } from "./stores.ts";
import type { Answer, CommitEntry, GameStore } from "./store.ts";

const url = process.env.DATABASE_URL;
const MIN = 60_000;

function answer(seq: number): Answer {
  return { seq, hash: `hash-${seq}`, rebased: false, retries: 0 };
}

/** The entry the handler would commit for `action` at `at` on top of a farm at `expectedSeq`. */
function entry(farm: FarmState, expectedSeq: number, action: Action, at: number, idempotencyKey: string): CommitEntry {
  const r = apply(advance(farm, at), action, at);
  if (!r.ok) throw new Error(r.reason);
  return { expectedSeq, action, at, idempotencyKey, next: r.state, answer: answer(expectedSeq + 1) };
}

const rich: FarmState = { ...newFarm(1), wheat: 10, bread: 3 };

describe("gifts", { skip: url ? false : "DATABASE_URL not set" }, () => {
  const sql = connect(url!);
  const tag = `${process.pid}_${Date.now()}`;
  const schemas = [`gifts_test_inbox_${tag}`];
  let inbox: Inbox;
  const stores: { name: string; store: GameStore }[] = [];

  before(async () => {
    inbox = await createInbox(sql, { schema: schemas[0] });
    // Every farm in these tests starts with goods to give, so a send needs no harvests first.
    const options = { newFarm: () => rich, inbox };
    stores.push({ name: "A", store: await createStoreA(sql, { ...options, schema: `gifts_test_a_${tag}` }) });
    for (const n of [1, 25, 100] as const) {
      const schema = `gifts_test_b${n}_${tag}`;
      stores.push({ name: `B${n}`, store: await createStoreB(sql, { ...options, schema, snapshotN: n, replay }) });
    }
    schemas.push(`gifts_test_a_${tag}`, ...[1, 25, 100].map((n) => `gifts_test_b${n}_${tag}`));
  });

  after(async () => {
    for (const s of schemas) await sql`drop schema if exists ${sql(s)} cascade`;
    await sql.end();
  });

  /** Runs `body` once per store, each with its own farm ids so the shared inbox never mixes them. */
  function eachStore(name: string, body: (store: GameStore, farm: (id: string) => string) => Promise<void>) {
    for (const config of ["A", "B1", "B25", "B100"]) {
      test(`${config}: ${name}`, async () => {
        const { store } = stores.find((s) => s.name === config)!;
        await body(store, (id) => `${id}-${config.toLowerCase()}`);
      });
    }
  }

  eachStore("a commit that sends a gift puts it in the inbox as <senderId>:<seq>, sent at its time", async (store, farm) => {
    const alice = farm("alice");
    const bob = farm("bob");
    await store.commit(alice, entry(rich, 0, { type: "plant", plot: 0 }, 1_000, "k1"));
    const send = entry(rich, 1, { type: "sendGift", to: bob, goods: { wheat: 4, bread: 1 } }, 2 * MIN, "k2");
    assert.deepStrictEqual(await store.commit(alice, send), { kind: "committed", seq: 2 });

    assert.deepStrictEqual(await store.gift(`${alice}:2`), {
      id: `${alice}:2`, from: alice, to: bob, goods: { wheat: 4, bread: 1 }, sentAt: 2 * MIN, claimedAt: null,
    });
    assert.equal(await store.gift(`${alice}:1`), null, "a plant sends nothing");
  });

  eachStore("a gift to the sender's own farm is refused: no seq used, no gift row, goods stay, key unused", async (store, farm) => {
    const alice = farm("self");
    const send = entry(rich, 0, { type: "sendGift", to: alice, goods: { wheat: 1, bread: 0 } }, 0, "k1");
    assert.deepStrictEqual(await store.commit(alice, send), { kind: "refused", reason: "a farm can't send a gift to itself" });

    assert.deepStrictEqual(await store.load(alice), { state: rich, seq: 0, at: 0 });
    assert.equal(await store.gift(`${alice}:1`), null);
    assert.equal(await store.processed(alice, "k1"), null);
  });

  eachStore("a commit that claims a gift marks it claimed at the claim's time; the recipient gets the goods", async (store, farm) => {
    const [alice, bob] = [farm("giver"), farm("taker")];
    await store.commit(alice, entry(rich, 0, { type: "sendGift", to: bob, goods: { wheat: 4, bread: 1 } }, 0, "send"));
    const claim = entry(rich, 0, { type: "claimGift", giftId: `${alice}:1`, goods: { wheat: 4, bread: 1 } }, 5 * MIN, "claim");
    assert.deepStrictEqual(await store.commit(bob, claim), { kind: "committed", seq: 1 });

    assert.equal((await store.gift(`${alice}:1`))?.claimedAt, 5 * MIN);
    const loaded = await store.load(bob);
    assert.deepStrictEqual([loaded.state.wheat, loaded.state.bread], [14, 4]);
  });

  eachStore("a claim is refused for someone else's gift, a second claim, a missing gift or the wrong goods", async (store, farm) => {
    const [alice, bob, eve] = [farm("from"), farm("to"), farm("eve")];
    await store.commit(alice, entry(rich, 0, { type: "sendGift", to: bob, goods: { wheat: 2, bread: 0 } }, 0, "send"));
    const id = `${alice}:1`;
    const claim = (by: string, seq: number, giftId: string, wheat: number, key: string) =>
      store.commit(by, entry(rich, seq, { type: "claimGift", giftId, goods: { wheat, bread: 0 } }, MIN, key));

    assert.deepStrictEqual(await claim(eve, 0, id, 2, "e1"), { kind: "refused", reason: `gift ${id} is not for ${eve}` });
    assert.deepStrictEqual(await claim(bob, 0, `${alice}:9`, 2, "b0"), { kind: "refused", reason: `no gift ${alice}:9` });
    assert.deepStrictEqual(await claim(bob, 0, id, 3, "b1"), { kind: "refused", reason: `the claim's goods don't match gift ${id}` });
    assert.deepStrictEqual(await claim(bob, 0, id, 2, "b2"), { kind: "committed", seq: 1 });
    assert.deepStrictEqual(await claim(bob, 1, id, 2, "b3"), { kind: "refused", reason: `gift ${id} is already claimed` });

    assert.equal((await store.load(eve)).seq, 0, "the refused claims used no seq");
    assert.equal((await store.load(bob)).seq, 1);
    assert.equal(await store.processed(bob, "b3"), null, "nor a key");
  });

  /** A POST body, as the client sends it. */
  const post = (action: unknown, expectedSeq: number, idempotencyKey: string) => ({ action, expectedSeq, idempotencyKey });

  eachStore("over the handler: X sends Y a gift, Y claims it with only its id, and the goods move", async (store, farm) => {
    const [x, y] = [farm("hx"), farm("hy")];
    const sent = await handleAction(store, () => MIN, x, post({ type: "sendGift", to: y, goods: { wheat: 3, bread: 2 } }, 0, "s"));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepStrictEqual([(await store.load(x)).state.wheat, (await store.load(x)).state.bread], [7, 1], "the goods left X when sent");

    const claimed = await handleAction(store, () => 2 * MIN, y, post({ type: "claimGift", giftId: `${x}:1` }, 0, "c"));
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const yFarm = await store.load(y);
    assert.deepStrictEqual([yFarm.state.wheat, yFarm.state.bread, yFarm.seq], [13, 5, 1]);
    assert.deepStrictEqual(yFarm.state.bakery, rich.bakery);
    assert.equal((await store.gift(`${x}:1`))?.claimedAt, 2 * MIN);
  });

  eachStore("over the handler: a self-gift, someone else's gift, a second claim and a missing gift are 422s that use no seq", async (store, farm) => {
    const [x, y, z] = [farm("rx"), farm("ry"), farm("rz")];
    const self = await handleAction(store, () => 0, x, post({ type: "sendGift", to: x, goods: { wheat: 1, bread: 0 } }, 0, "self"));
    assert.deepStrictEqual(self, { status: 422, body: { error: "a farm can't send a gift to itself" } });
    assert.deepStrictEqual(await store.load(x), { state: rich, seq: 0, at: 0 }, "goods stay, no seq used");

    await handleAction(store, () => 0, x, post({ type: "sendGift", to: y, goods: { wheat: 1, bread: 0 } }, 0, "send"));
    const id = `${x}:1`;
    const claim = (by: string, key: string, giftId = id) =>
      handleAction(store, () => MIN, by, post({ type: "claimGift", giftId }, 0, key));

    assert.deepStrictEqual(await claim(z, "z1"), { status: 422, body: { error: `gift ${id} is not for ${z}` } });
    assert.deepStrictEqual(await claim(y, "y0", `${x}:5`), { status: 422, body: { error: `no gift ${x}:5` } });
    assert.equal((await claim(y, "y1")).status, 200);
    assert.deepStrictEqual(await claim(y, "y2"), { status: 422, body: { error: `gift ${id} is already claimed` } });
    assert.deepStrictEqual([(await store.load(y)).seq, (await store.load(z)).seq], [1, 0]);
    assert.equal((await store.load(y)).state.wheat, 11, "the goods arrived once");
  });

  eachStore("over the handler: two claims of one gift at once, with different keys, give the goods once", async (store, farm) => {
    const [x, y] = [farm("dx"), farm("dy")];
    await handleAction(store, () => 0, x, post({ type: "sendGift", to: y, goods: { wheat: 2, bread: 0 } }, 0, "send"));
    const results = await Promise.all(["c1", "c2"].map((key) =>
      handleAction(store, () => MIN, y, post({ type: "claimGift", giftId: `${x}:1` }, 0, key))));

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 422]);
    const loaded = await store.load(y);
    assert.deepStrictEqual([loaded.seq, loaded.state.wheat], [1, 12]);
  });
});

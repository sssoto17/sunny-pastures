import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction, handleRead, handleStateAt } from "./handler.ts";
import { newFarm, stateHash } from "./sim.ts";
import type { Answer, AuditableStore, CommitEntry, CommitResult, FarmRecord, GameStore } from "./store.ts";

const MIN = 60_000;

/** An in-memory GameStore with the same lock and key semantics as store A. */
function memoryStore(opts: { forcedConflicts?: number } = {}) {
  const farms = new Map<string, FarmRecord>();
  const keys = new Map<string, Answer>();
  let forced = opts.forcedConflicts ?? 0;
  const store: GameStore & { commits: number } = {
    commits: 0,
    async load(id) {
      return structuredClone(farms.get(id) ?? { state: newFarm(1), seq: 0, at: 0 });
    },
    async processed(id, key) {
      return keys.get(`${id}/${key}`) ?? null;
    },
    async commit(id, e: CommitEntry): Promise<CommitResult> {
      const k = `${id}/${e.idempotencyKey}`;
      const first = keys.get(k);
      if (first) return { kind: "duplicate", answer: first };
      if (forced > 0) {
        forced--;
        return { kind: "conflict" };
      }
      if ((farms.get(id)?.seq ?? 0) !== e.expectedSeq) return { kind: "conflict" };
      farms.set(id, structuredClone({ state: e.next, seq: e.expectedSeq + 1, at: e.at }));
      keys.set(k, e.answer);
      store.commits++;
      return { kind: "committed", seq: e.expectedSeq + 1 };
    },
  };
  return store;
}

const plant = (plot: number, expectedSeq: number, idempotencyKey: string) => ({
  action: { type: "plant", plot }, expectedSeq, idempotencyKey,
});
const harvest = (plot: number, expectedSeq: number, idempotencyKey: string) => ({
  action: { type: "harvest", plot }, expectedSeq, idempotencyKey,
});

test("plant, wait, harvest: each accepted action takes the next seq", async () => {
  const store = memoryStore();
  const planted = await handleAction(store, () => 0, "f", plant(0, 0, "k1"));
  assert.equal(planted.status, 200);
  assert.equal(planted.body.seq, 1);

  const harvested = await handleAction(store, () => 2 * MIN, "f", harvest(0, 1, "k2"));
  assert.equal(harvested.status, 200);
  assert.deepEqual(
    { seq: harvested.body.seq, rebased: harvested.body.rebased, retries: harvested.body.retries },
    { seq: 2, rebased: false, retries: 0 },
  );
  const stored = await store.load("f");
  assert.equal(stored.seq, 2);
  assert.ok(stored.state.wheat >= 2);
  assert.equal(harvested.body.hash, stateHash(stored.state), "the answered hash is the stored farm's");
});

test("a refused action is not committed and does not use up a seq", async () => {
  const store = memoryStore();
  const refused = await handleAction(store, () => 0, "f", harvest(0, 0, "k1"));
  assert.equal(refused.status, 422);
  assert.equal(store.commits, 0);
  assert.equal((await store.load("f")).seq, 0);

  const next = await handleAction(store, () => 0, "f", plant(0, 0, "k2"));
  assert.equal(next.body.seq, 1);
});

test("a conflict is retried up to 3 times", async () => {
  const store = memoryStore({ forcedConflicts: 3 });
  const res = await handleAction(store, () => 0, "f", plant(0, 0, "k1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.retries, 3);
});

test("a fourth conflict gives 503 and commits nothing", async () => {
  const store = memoryStore({ forcedConflicts: 4 });
  const res = await handleAction(store, () => 0, "f", plant(0, 0, "k1"));
  assert.equal(res.status, 503);
  assert.equal(store.commits, 0);
});

test("a stale expectedSeq is applied on top of the current farm and marked rebased", async () => {
  const store = memoryStore();
  await handleAction(store, () => 0, "f", plant(0, 0, "tab-1"));
  const res = await handleAction(store, () => 10, "f", plant(1, 0, "tab-2"));
  assert.equal(res.status, 200);
  assert.equal(res.body.seq, 2);
  assert.equal(res.body.rebased, true);
});

test("a repeated idempotency key returns the first answer, even if the action would now be refused", async () => {
  const store = memoryStore();
  const first = await handleAction(store, () => 0, "f", plant(0, 0, "same"));
  const again = await handleAction(store, () => 5, "f", plant(0, 0, "same"));
  assert.deepEqual(again, first);
  assert.equal(store.commits, 1);
});

test("server time never runs backwards past the farm's last action", async () => {
  const store = memoryStore();
  await handleAction(store, () => 10 * MIN, "f", plant(0, 0, "k1"));
  // A clock behind the last action (another instance) must not make the plant look older.
  await handleAction(store, () => 0, "f", plant(1, 1, "k2"));
  assert.equal((await store.load("f")).at, 10 * MIN);
});

test("a malformed body is a 400 and touches nothing", async () => {
  const store = memoryStore();
  for (const body of [
    null,
    { action: { type: "plant", plot: 0 }, expectedSeq: 0 },
    { action: { type: "dance", plot: 0 }, expectedSeq: 0, idempotencyKey: "k" },
    { action: { type: "plant", plot: 0.5 }, expectedSeq: 0, idempotencyKey: "k" },
    { action: { type: "plant", plot: 0 }, expectedSeq: "0", idempotencyKey: "k" },
  ]) {
    assert.equal((await handleAction(store, () => 0, "f", body)).status, 400, JSON.stringify(body));
  }
  assert.equal(store.commits, 0);
});

test("reading a farm advances it in memory and writes nothing", async () => {
  const store = memoryStore();
  await handleAction(store, () => 0, "f", plant(0, 0, "k1"));
  const read = await handleRead(store, () => 2 * MIN, "f");
  assert.equal(read.status, 200);
  assert.equal(read.body.seq, 1);
  assert.deepEqual(read.body.state.plots[0], { status: "ready" });
  assert.equal(read.body.hash, stateHash(read.body.state));
  assert.deepEqual((await store.load("f")).state.plots[0], { status: "growing", readyAt: 2 * MIN });
});

test("stateAt on a store without history is a 501", async () => {
  const res = await handleStateAt(memoryStore(), "f", "0");
  assert.equal(res.status, 501);
});

test("stateAt passes t to an auditable store and answers that farm with its hash", async () => {
  const asked: number[] = [];
  const then = { ...newFarm(1), wheat: 7 };
  const store: AuditableStore = {
    ...memoryStore(),
    async stateAt(_id, t) {
      asked.push(t);
      return then;
    },
  };
  const res = await handleStateAt(store, "f", "120000");
  assert.deepStrictEqual(res, { status: 200, body: { at: 120_000, hash: stateHash(then), state: then } });
  assert.deepStrictEqual(asked, [120_000]);
});

test("stateAt needs t as non-negative integer ms", async () => {
  const asked: number[] = [];
  const store: AuditableStore = { ...memoryStore(), async stateAt(_id, t) { asked.push(t); return newFarm(1); } };
  for (const t of ["", "1.5", "-1", "abc", "1e3", "9007199254740992"]) {
    assert.equal((await handleStateAt(store, "f", t)).status, 400, t);
  }
  assert.deepStrictEqual(asked, []);
});

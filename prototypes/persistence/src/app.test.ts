// The HTTP seam (#10): requests in, responses out, against an in-memory store and a fixed clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppOptions, type TimingRow } from "./app.ts";
import { stateHash } from "./sim.ts";
import { firstFarm } from "./stores.ts";
import { csvSink } from "./timing.ts";
import type { Gift } from "./inbox.ts";
import type { Answer, CommitEntry, CommitResult, FarmRecord, GameStore } from "./store.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** An in-memory GameStore with store A's semantics; `delay` makes a call take at least that long. */
function memoryStore(delay: { load?: number; commit?: number } = {}, gifts = new Map<string, Gift>()): GameStore {
  const farms = new Map<string, FarmRecord>();
  const keys = new Map<string, Answer>();
  const wait = (ms = 0) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  return {
    async load(id) {
      await wait(delay.load);
      return structuredClone(farms.get(id) ?? { state: firstFarm(id), seq: 0, at: 0 });
    },
    async processed(id, key) {
      return keys.get(`${id}/${key}`) ?? null;
    },
    async gift(giftId) {
      return gifts.get(giftId) ?? null;
    },
    async commit(id, e: CommitEntry): Promise<CommitResult> {
      await wait(delay.commit);
      const first = keys.get(`${id}/${e.idempotencyKey}`);
      if (first) return { kind: "duplicate", answer: first };
      if ((farms.get(id)?.seq ?? 0) !== e.expectedSeq) return { kind: "conflict" };
      farms.set(id, structuredClone({ state: e.next, seq: e.expectedSeq + 1, at: e.at }));
      keys.set(`${id}/${e.idempotencyKey}`, e.answer);
      return { kind: "committed", seq: e.expectedSeq + 1 };
    },
  };
}

/** Starts the app on a free port; `rows` collects what would go to the server's CSV. */
async function serve(t: { after: (fn: () => void) => void }, opts: Partial<AppOptions> = {}) {
  const rows: TimingRow[] = [];
  const server = createServer(
    createApp({
      store: memoryStore(),
      storeName: "A",
      clock: () => 0,
      spikeClock: true,
      onTiming: (row) => rows.push(row),
      ...opts,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: { method?: string; body?: unknown; offset?: string } = {}) =>
    fetch(base + path, {
      method: init.method ?? "GET",
      headers: init.offset === undefined ? {} : { "x-spike-clock-offset": init.offset },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  return { call, rows };
}

const act = (type: "plant" | "harvest", plot: number, expectedSeq: number, idempotencyKey: string) => ({
  action: { type, plot }, expectedSeq, idempotencyKey,
});

test("X-Spike-Clock-Offset moves the server time forward when SPIKE_CLOCK=1", async (t) => {
  const { call } = await serve(t);
  await call("/farms/f/actions", { method: "POST", body: act("plant", 0, 0, "k1") });

  const early = await call("/farms/f/actions", { method: "POST", body: act("harvest", 0, 1, "k2") });
  assert.equal(early.status, 422, "at clock 0 the wheat is still growing");

  const later = await call("/farms/f/actions", {
    method: "POST", body: act("harvest", 0, 1, "k3"), offset: String(2 * MIN),
  });
  assert.equal(later.status, 200, "2 minutes ahead the wheat is ripe");
});

test("without SPIKE_CLOCK=1 the offset header is ignored", async (t) => {
  const { call } = await serve(t, { spikeClock: false });
  await call("/farms/f/actions", { method: "POST", body: act("plant", 0, 0, "k1") });
  const res = await call("/farms/f/actions", {
    method: "POST", body: act("harvest", 0, 1, "k2"), offset: String(2 * MIN),
  });
  assert.equal(res.status, 422);
});

test("a malformed offset is a 400 and touches nothing", async (t) => {
  const { call } = await serve(t);
  for (const offset of ["-1", "1.5", "soon", "", "1e9"]) {
    const res = await call("/farms/f/actions", { method: "POST", body: act("plant", 0, 0, `k${offset}`), offset });
    assert.equal(res.status, 400, `offset ${JSON.stringify(offset)}`);
  }
  assert.equal(((await (await call("/farms/f")).json()) as { seq: number }).seq, 0);
});

test("the farm's time never runs backwards when a later request carries a smaller offset", async (t) => {
  const { call } = await serve(t);
  await call("/farms/f/actions", { method: "POST", body: act("plant", 0, 0, "k1"), offset: String(8 * HOUR) });
  // Without the offset this request's time is 8 h earlier; the plant is clamped to 8 h, so the
  // plot planted at 8 h is still growing at 8 h.
  await call("/farms/f/actions", { method: "POST", body: act("plant", 1, 1, "k2") });
  const farm = (await (await call("/farms/f", { offset: String(8 * HOUR) })).json()) as {
    state: { plots: { status: string; readyAt?: number }[] };
  };
  assert.deepEqual(farm.state.plots[1], { status: "growing", readyAt: 8 * HOUR + 2 * MIN });
});

/** `load;dur=1.2, sim;dur=0.3, …` → { load: 1.2, sim: 0.3, … } */
function serverTiming(res: Response): Record<string, number> {
  const header = res.headers.get("server-timing") ?? "";
  return Object.fromEntries(
    header.split(",").filter(Boolean).map((part) => {
      const [name, dur] = part.trim().split(";dur=");
      return [name!, Number(dur)];
    }),
  );
}

test("every response carries Server-Timing with load, sim and commit, and the CSV gets the same numbers", async (t) => {
  const { call, rows } = await serve(t);
  const responses = [
    await call("/farms/f"),
    await call("/farms/f/actions", { method: "POST", body: act("plant", 0, 0, "k1") }),
    await call("/farms/f/actions", { method: "POST", body: act("harvest", 0, 1, "k2") }), // 422
    await call("/farms/f/actions", { method: "POST", body: "{" as unknown }), // 400
    await call("/farms/f/at/5"), // 501 on A
    await call("/nowhere"), // 404
  ];
  assert.deepEqual(responses.map((r) => r.status), [200, 200, 422, 400, 501, 404]);
  assert.equal(rows.length, responses.length, "one CSV row per response");
  responses.forEach((res, i) => {
    const timing = serverTiming(res);
    assert.deepEqual(Object.keys(timing).sort(), ["commit", "load", "sim", "total"]);
    for (const dur of Object.values(timing)) assert.ok(dur >= 0, `${res.url}: ${JSON.stringify(timing)}`);
    const row = rows[i]!;
    assert.equal(row.status, res.status);
    assert.deepEqual(
      { load: row.loadMs, sim: row.simMs, commit: row.commitMs, total: row.totalMs },
      timing,
      "the header and the CSV row hold the same numbers",
    );
  });
  assert.deepEqual(rows.map((r) => r.route), ["read", "action", "action", "action", "stateAt", "none"]);
  assert.deepEqual(rows.map((r) => r.farm), ["f", "f", "f", "f", "f", ""]);
  assert.ok(rows.every((r) => r.store === "A"));
});

test("store time lands in load and commit, the rest of the handler in sim", async (t) => {
  const { call, rows } = await serve(t, { store: memoryStore({ load: 30, commit: 20 }) });
  const res = await call("/farms/f/actions", { method: "POST", body: act("plant", 0, 0, "k1") });
  const timing = serverTiming(res);
  assert.ok(timing.load! >= 29, `load ${timing.load}`);
  assert.ok(timing.commit! >= 19, `commit ${timing.commit}`);
  assert.ok(timing.sim! < 15, `sim ${timing.sim}`);
  assert.ok(timing.total! >= timing.load! + timing.commit! + timing.sim! - 0.01, JSON.stringify(timing));
  assert.equal(rows[0]!.retries, 0);
  assert.equal(rows[0]!.offsetMs, 0);
});

test("a store with history still answers stateAt with its seq, and its time lands in load", async (t) => {
  const store = Object.assign(memoryStore(), {
    async stateAt(id: string) {
      await new Promise((r) => setTimeout(r, 20));
      return { state: firstFarm(id), seq: 4 };
    },
  });
  const { call } = await serve(t, { store, storeName: "B25", clock: () => 10 * MIN });
  const res = await call("/farms/f/at/5");
  assert.equal(res.status, 200);
  assert.ok(serverTiming(res).load! >= 19);
  assert.deepStrictEqual(await res.json(), { at: 5, seq: 4, hash: stateHash(firstFarm("f")), state: firstFarm("f") });
});

test("stateAt at a t later than the request's server time is a 400 and never reaches the store", async (t) => {
  const asked: number[] = [];
  const store = Object.assign(memoryStore(), {
    async stateAt(id: string, at: number) {
      asked.push(at);
      return { state: firstFarm(id), seq: 0 };
    },
  });
  const { call } = await serve(t, { store, storeName: "B25", clock: () => 10 * MIN });
  assert.equal((await call(`/farms/f/at/${10 * MIN + 1}`)).status, 400);
  // The clock-offset header moves this request's server time, so the same t is history now.
  assert.equal((await call(`/farms/f/at/${10 * MIN + 1}`, { offset: "1" })).status, 200);
  assert.deepStrictEqual(asked, [10 * MIN + 1]);
});

test("the CSV sink writes a header and one line per row", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "timing-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "server.csv");
  const sink = csvSink(path);
  const row: TimingRow = {
    t: 1700000000000, store: "B25", method: "POST", route: "action", farm: "smoke-a-3", status: 200,
    loadMs: 1.25, simMs: 0.5, commitMs: 2, totalMs: 4.1, retries: 0, offsetMs: 28800000,
  };
  sink.write(row);
  sink.write({ ...row, route: "read", method: "GET", retries: null, offsetMs: 0 });
  await sink.close();
  assert.equal(
    await readFile(path, "utf8"),
    "t,store,method,route,farm,status,loadMs,simMs,commitMs,totalMs,retries,offsetMs\n" +
      "1700000000000,B25,POST,action,smoke-a-3,200,1.25,0.5,2,4.1,0,28800000\n" +
      "1700000000000,B25,GET,read,smoke-a-3,200,1.25,0.5,2,4.1,,0\n",
  );
});

test("without SPIKE_CLOCK=1 there are no seed or storage endpoints", async (t) => {
  const { call } = await serve(t, { spikeClock: false, storage: async () => ({ tables: [], bytes: 0 }) });
  assert.equal((await call("/spike/seed", { method: "POST", body: { prefix: "s", players: 1 } })).status, 404);
  assert.equal((await call("/spike/storage")).status, 404);
  assert.equal(((await (await call("/farms/s-0")).json()) as { seq: number }).seq, 0, "nothing was seeded");
});

test("seeding gives each player about 1,000 accepted actions, with tails spread across 0 to 99", async (t) => {
  const now = 1_800_000_000_000;
  const { call } = await serve(t, { clock: () => now });
  const res = await call("/spike/seed", { method: "POST", body: { prefix: "s", players: 4 } });
  assert.equal(res.status, 200);
  // 1,000 plus (i × 37) mod 100: 37 is coprime to 100 and 25, so tails spread for B25 and B100.
  const expected = [
    { farm: "s-0", seq: 1000 },
    { farm: "s-1", seq: 1037 },
    { farm: "s-2", seq: 1074 },
    { farm: "s-3", seq: 1011 },
  ];
  assert.deepEqual(await res.json(), { seeded: 4, skipped: 0, farms: expected });
  for (const { farm, seq } of expected) {
    assert.equal(((await (await call(`/farms/${farm}`)).json()) as { seq: number }).seq, seq);
  }
});

test("a seeded farm's history ends before now, so the next action is not pushed into the future", async (t) => {
  const now = 1_800_000_000_000;
  const { call } = await serve(t, { clock: () => now });
  await call("/spike/seed", { method: "POST", body: { prefix: "s", players: 1, actions: 40 } });
  const farm = (await (await call("/farms/s-0")).json()) as { seq: number; state: { plots: { status: string }[] } };
  // Harvest whatever is ripe and plant an empty plot, all at `now`.
  let seq = farm.seq;
  const ripe = farm.state.plots.findIndex((p) => p.status === "ready");
  if (ripe >= 0) {
    assert.equal((await call("/farms/s-0/actions", { method: "POST", body: act("harvest", ripe, seq, "h") })).status, 200);
    seq++;
  }
  const after = (await (await call("/farms/s-0")).json()) as { state: { plots: { status: string }[] } };
  const empty = after.state.plots.findIndex((p) => p.status === "empty");
  assert.ok(empty >= 0);
  await call("/farms/s-0/actions", { method: "POST", body: act("plant", empty, seq, "p") });
  const planted = (await (await call("/farms/s-0")).json()) as { state: { plots: { readyAt?: number }[] } };
  assert.equal(planted.state.plots[empty]!.readyAt, now + 2 * MIN, "planted at now, not clamped later");
});

test("seeding twice skips farms that already have actions", async (t) => {
  const { call } = await serve(t, { clock: () => 1_800_000_000_000 });
  await call("/spike/seed", { method: "POST", body: { prefix: "s", players: 2, actions: 30 } });
  const again = await call("/spike/seed", { method: "POST", body: { prefix: "s", players: 3, actions: 30 } });
  assert.deepEqual(await again.json(), {
    seeded: 1,
    skipped: 2,
    farms: [{ farm: "s-0", seq: 30 }, { farm: "s-1", seq: 67 }, { farm: "s-2", seq: 104 }],
  });
});

test("a malformed seed request is a 400", async (t) => {
  const { call } = await serve(t);
  for (const body of [
    {},
    { prefix: "s", players: 0 },
    { prefix: "s", players: 1001 },
    { prefix: "bad prefix", players: 1 },
    { prefix: "s", players: 1, actions: 0 },
    { prefix: "s", players: 1.5 },
  ]) {
    assert.equal((await call("/spike/seed", { method: "POST", body })).status, 400, JSON.stringify(body));
  }
});

test("a claim reaches the store's gift inbox through the timings", async (t) => {
  const gifts = new Map<string, Gift>([
    ["bob:1", { id: "bob:1", from: "bob", to: "f", goods: { wheat: 2, bread: 0 }, sentAt: 0, claimedAt: null }],
  ]);
  const { call } = await serve(t, { store: memoryStore({}, gifts) });
  const claim = (giftId: string, key: string) => ({ action: { type: "claimGift", giftId }, expectedSeq: 0, idempotencyKey: key });
  assert.equal((await call("/farms/f/actions", { method: "POST", body: claim("nobody:9", "k1") })).status, 422);
  assert.equal((await call("/farms/f/actions", { method: "POST", body: claim("bob:1", "k2") })).status, 200);
});

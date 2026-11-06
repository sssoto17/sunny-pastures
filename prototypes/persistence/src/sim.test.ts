import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, apply, newFarm, stateHash, type FarmState } from "./sim.ts";

const MIN = 60_000;

function ok(r: ReturnType<typeof apply>): FarmState {
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return (r as { ok: true; state: FarmState }).state;
}

test("a new farm has 6 empty plots and no wheat", () => {
  const farm = newFarm(1);
  assert.equal(farm.plots.length, 6);
  assert.ok(farm.plots.every((p) => p.status === "empty"));
  assert.equal(farm.wheat, 0);
});

test("wheat planted at t can be harvested at t + 2 min, not a millisecond earlier", () => {
  const planted = ok(apply(newFarm(1), { type: "plant", plot: 0 }, 1_000));

  const early = apply(planted, { type: "harvest", plot: 0 }, 1_000 + 2 * MIN - 1);
  assert.equal(early.ok, false);

  const harvested = ok(apply(planted, { type: "harvest", plot: 0 }, 1_000 + 2 * MIN));
  assert.ok(harvested.wheat === 2 || harvested.wheat === 3, `wheat was ${harvested.wheat}`);
  assert.equal(harvested.plots[0]!.status, "empty");
});

/** Plants and harvests plot 0 `n` times, returning the yield of each harvest. */
function harvestYields(seed: number, n: number): number[] {
  let farm = newFarm(seed);
  let t = 0;
  const yields: number[] = [];
  for (let i = 0; i < n; i++) {
    farm = ok(apply(farm, { type: "plant", plot: 0 }, t));
    t += 2 * MIN;
    const before = farm.wheat;
    farm = ok(apply(farm, { type: "harvest", plot: 0 }, t));
    yields.push(farm.wheat - before);
  }
  return yields;
}

test("the bonus wheat depends only on the seed in the farm", () => {
  assert.deepEqual(harvestYields(42, 200), harvestYields(42, 200));
  assert.notDeepEqual(harvestYields(42, 200), harvestYields(43, 200));
});

test("a harvest gives 2 wheat, and +1 about 10% of the time", () => {
  const yields = harvestYields(7, 10_000);
  assert.ok(yields.every((y) => y === 2 || y === 3));
  const bonusRate = yields.filter((y) => y === 3).length / yields.length;
  assert.ok(bonusRate > 0.09 && bonusRate < 0.11, `bonus rate ${bonusRate}`);
});

test("only integer millisecond times are accepted", () => {
  assert.equal(apply(newFarm(1), { type: "plant", plot: 0 }, 1.5).ok, false);
  assert.equal(apply(newFarm(1), { type: "plant", plot: 0 }, Number.NaN).ok, false);
  assert.throws(() => advance(newFarm(1), 0.5));
});

test("refused actions: unknown plot, planting a busy plot, harvesting an empty one", () => {
  const planted = ok(apply(newFarm(1), { type: "plant", plot: 0 }, 0));
  assert.equal(apply(planted, { type: "plant", plot: 6 }, 0).ok, false);
  assert.equal(apply(planted, { type: "plant", plot: 0 }, 1).ok, false);
  assert.equal(apply(planted, { type: "harvest", plot: 1 }, 2 * MIN).ok, false);
});

test("advancing shows ripe wheat without changing anything else", () => {
  const planted = ok(apply(newFarm(1), { type: "plant", plot: 3 }, 0));
  const later = advance(planted, 2 * MIN);
  assert.deepEqual(later, { ...planted, plots: planted.plots.map((p, i) => (i === 3 ? { status: "ready" } : p)) });
  assert.deepEqual(planted.plots[3], { status: "growing", readyAt: 2 * MIN }, "advance does not mutate its input");
});

test("state hash is SHA-256 over JSON with sorted keys", () => {
  // Reference: printf '%s' '{"a":[{"c":3,"d":2}],"b":1}' | sha256sum
  const expected = "aa0fff90b247460fff3592ff491ac879c69b05ee5efa14393d3154bd9199273f";
  assert.equal(stateHash({ b: 1, a: [{ d: 2, c: 3 }] }), expected);
  assert.equal(stateHash({ a: [{ c: 3, d: 2 }], b: 1 }), expected);
});

test("bread costs 3 wheat, takes 5 min and waits in the bakery until it is collected", () => {
  const baking = ok(apply({ ...newFarm(1), wheat: 4 }, { type: "bake" }, 0));
  assert.equal(baking.wheat, 1);

  assert.equal(apply(baking, { type: "collect" }, 5 * MIN - 1).ok, false, "not baked yet");
  const collected = ok(apply(baking, { type: "collect" }, 8 * 60 * MIN));
  assert.equal(collected.bread, 1);
  assert.equal(apply(collected, { type: "collect" }, 8 * 60 * MIN).ok, false, "nothing left to collect");
});

test("the bakery holds up to 3 jobs and bakes them one after another", () => {
  let farm: FarmState = { ...newFarm(1), wheat: 12 };
  for (let i = 0; i < 3; i++) farm = ok(apply(farm, { type: "bake" }, 0));
  assert.equal(apply(farm, { type: "bake" }, 0).ok, false, "a fourth job is refused");
  assert.equal(farm.wheat, 3, "three jobs cost 9 wheat");

  // Ordered together at 0, ready at 5, 10 and 15 min: not all at 5.
  assert.equal(ok(apply(farm, { type: "collect" }, 10 * MIN)).bread, 2);
  // After an 8-hour gap all three are ready, each having started when the one before finished.
  assert.equal(ok(apply(farm, { type: "collect" }, 8 * 60 * MIN)).bread, 3);
});

test("baked bread waiting to be collected keeps its slot, and a new job starts when ordered", () => {
  let farm: FarmState = { ...newFarm(1), wheat: 12 };
  farm = ok(apply(farm, { type: "bake" }, 0));
  farm = ok(apply(farm, { type: "bake" }, 0)); // ready at 10 min
  farm = ok(apply(farm, { type: "bake" }, 60 * MIN)); // bakery idle since 10 min: ready at 65, not 15
  assert.equal(apply(farm, { type: "bake" }, 60 * MIN).ok, false, "two loaves waiting still fill two slots");

  assert.equal(ok(apply(farm, { type: "collect" }, 65 * MIN - 1)).bread, 2);
  const all = ok(apply(farm, { type: "collect" }, 65 * MIN));
  assert.equal(all.bread, 3);
  assert.deepEqual(all.bakery, []);
});

test("a gift's goods leave the sender's farm when it is sent", () => {
  const farm: FarmState = { ...newFarm(1), wheat: 5, bread: 2 };
  const sent = ok(apply(farm, { type: "sendGift", to: "bob", goods: { wheat: 4, bread: 1 } }, 0));
  assert.equal(sent.wheat, 1);
  assert.equal(sent.bread, 1);
  assert.equal(apply(farm, { type: "sendGift", to: "bob", goods: { wheat: 6, bread: 0 } }, 0).ok, false, "more wheat than the farm has");
  assert.equal(apply(farm, { type: "sendGift", to: "bob", goods: { wheat: 0, bread: 3 } }, 0).ok, false, "more bread than the farm has");
});

test("a claim adds the goods its payload carries, so no other farm is needed", () => {
  const claimed = ok(apply(newFarm(1), { type: "claimGift", giftId: "alice:7", goods: { wheat: 4, bread: 1 } }, 0));
  assert.equal(claimed.wheat, 4);
  assert.equal(claimed.bread, 1);
});

test("a gift must hold some goods, in whole non-negative amounts", () => {
  const farm: FarmState = { ...newFarm(1), wheat: 5, bread: 2 };
  for (const goods of [{ wheat: 0, bread: 0 }, { wheat: -1, bread: 2 }, { wheat: 1.5, bread: 0 }]) {
    assert.equal(apply(farm, { type: "sendGift", to: "bob", goods }, 0).ok, false, `send ${JSON.stringify(goods)}`);
    assert.equal(apply(farm, { type: "claimGift", giftId: "alice:7", goods }, 0).ok, false, `claim ${JSON.stringify(goods)}`);
  }
});

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { newFarm } from "./sim.ts";
import { replay, storeConfig } from "./stores.ts";

test("STORE and SNAPSHOT_N pick A, B1, B25 or B100", () => {
  assert.deepStrictEqual(storeConfig({}), { name: "A" }, "A by default, as in #5");
  assert.deepStrictEqual(storeConfig({ STORE: "A" }), { name: "A" });
  assert.deepStrictEqual(storeConfig({ STORE: "B", SNAPSHOT_N: "1" }), { name: "B1", snapshotN: 1 });
  assert.deepStrictEqual(storeConfig({ STORE: "B", SNAPSHOT_N: "25" }), { name: "B25", snapshotN: 25 });
  assert.deepStrictEqual(storeConfig({ STORE: "b", SNAPSHOT_N: "100" }), { name: "B100", snapshotN: 100 });
});

test("a store configuration that would measure the wrong thing is refused", () => {
  for (const env of [
    { STORE: "B" }, // no silent default interval
    { STORE: "B", SNAPSHOT_N: "50" },
    { STORE: "B", SNAPSHOT_N: "25x" },
    { STORE: "A", SNAPSHOT_N: "25" }, // A has no snapshots
    { STORE: "C" },
  ]) {
    assert.throws(() => storeConfig(env), /STORE|SNAPSHOT_N/, JSON.stringify(env));
  }
});

test("replay applies each action at its own time, then advances", () => {
  const farm = replay(newFarm(1), [
    { action: { type: "plant", plot: 0 }, at: 0 },
    { action: { type: "harvest", plot: 0 }, at: 120_000 },
    { action: { type: "plant", plot: 1 }, at: 130_000 },
  ], 250_000);
  assert.deepStrictEqual(farm.plots.slice(0, 2), [{ status: "empty" }, { status: "ready" }]);
  assert.ok(farm.wheat === 2 || farm.wheat === 3);
});

test("replay throws on an action the rules refuse instead of skipping it", () => {
  assert.throws(
    () => replay(newFarm(1), [{ action: { type: "harvest", plot: 0 }, at: 0 }], 0),
    /seq|refused/,
  );
});

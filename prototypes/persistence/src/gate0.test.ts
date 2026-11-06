import { test } from "node:test";
import assert from "node:assert/strict";
import { runGate0 } from "./gate0.ts";
import { generateScript } from "./script.ts";
import { apply, newFarm } from "./sim.ts";

test("step 0 passes: two runs and replays from snapshots at N = 1, 25 and 100 give one hash", () => {
  const result = runGate0(generateScript(42));
  assert.deepEqual(result.runs.map((r) => r.label), ["run 1", "run 2", "replay N=1", "replay N=25", "replay N=100"]);
  for (const run of result.runs) assert.match(run.hash, /^[0-9a-f]{64}$/);
  assert.equal(new Set(result.runs.map((r) => r.hash)).size, 1);
  assert.equal(result.pass, true);
});

test("step 0 fails when the rules are not deterministic", () => {
  // Hidden state outside the farm: every call sees a different world.
  let calls = 0;
  const leaky: typeof apply = (state, action, at) => {
    const r = apply(state, action, at);
    return r.ok && ++calls % 97 === 0 ? { ok: true, state: { ...r.state, wheat: r.state.wheat + 1 } } : r;
  };
  const result = runGate0(generateScript(42), { newFarm, apply: leaky });
  assert.equal(result.pass, false);
  assert.ok(new Set(result.runs.map((r) => r.hash)).size > 1);
});

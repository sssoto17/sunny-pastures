import { test } from "node:test";
import assert from "node:assert/strict";
import { generateScript } from "./script.ts";
import { apply, newFarm } from "./sim.ts";

const HOUR = 60 * 60_000;

test("the script is 500 actions at integer ms in time order, the same every time for a seed", () => {
  const script = generateScript(42);
  assert.equal(script.steps.length, 500);
  for (const [i, step] of script.steps.entries()) {
    assert.ok(Number.isSafeInteger(step.at), `step ${i} at ${step.at}`);
    if (i > 0) assert.ok(step.at >= script.steps[i - 1]!.at, `step ${i} goes back in time`);
  }
  assert.deepEqual(generateScript(42), script);
  assert.notDeepEqual(generateScript(43).steps, script.steps);
});

test("the script has an 8-hour gap, gifts both ways, refused actions and every action accepted", () => {
  const { seed, steps } = generateScript(42);
  const gaps = steps.slice(1).map((s, i) => s.at - steps[i]!.at);
  assert.ok(gaps.some((g) => g >= 8 * HOUR), "an 8-hour gap");

  let farm = newFarm(seed);
  const accepted = new Map<string, number>();
  let refused = 0;
  for (const { action, at } of steps) {
    const result = apply(farm, action, at);
    if (!result.ok) refused++;
    else {
      farm = result.state;
      accepted.set(action.type, (accepted.get(action.type) ?? 0) + 1);
    }
    if (action.type === "claimGift") assert.match(action.giftId, /^[\w-]+:\d+$/, "gift id is <senderId>:<seq>");
  }
  for (const type of ["plant", "harvest", "bake", "collect", "sendGift", "claimGift"]) {
    assert.ok((accepted.get(type) ?? 0) >= 3, `${type} accepted ${accepted.get(type) ?? 0} times`);
  }
  assert.ok(refused >= 10 && refused <= 75, `${refused} refused actions`);
});

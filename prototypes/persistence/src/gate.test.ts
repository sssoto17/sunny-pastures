// The full equivalence gate (ADR-0001, #9) against the real local Postgres (DATABASE_URL). Each
// run uses its own throwaway schemas, dropped by the gate itself.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SPECS, runGate, type StoreSpec } from "./gate.ts";
import { runGate0 } from "./gate0.ts";
import { generateScript } from "./script.ts";
import { apply, newFarm } from "./sim.ts";
import { connect } from "./store-a.ts";
import type { AuditableStore, GameStore } from "./store.ts";

const url = process.env.DATABASE_URL;
const script = generateScript(42);

describe("equivalence gate", { skip: url ? false : "DATABASE_URL not set" }, () => {
  const sql = connect(url!);
  let runs = 0;
  const tag = () => `t${process.pid}_${Date.now()}_${runs++}`;

  after(async () => {
    await sql.end();
  });

  test("the script ends on step 0's hash in A, B1, B25 and B100, and every B's stateAt matches the sim", async () => {
    const step0 = runGate0(script);
    const result = await runGate(sql, { script, tag: tag() });

    assert.deepStrictEqual(result.failures, []);
    assert.equal(result.pass, true);
    assert.equal(result.step0.pass, true);
    assert.deepStrictEqual(result.stores.map((s) => s.store), ["A", "B1", "B25", "B100"]);
    for (const run of result.stores) {
      assert.equal(run.pass, true, run.store);
      assert.equal(run.hash, step0.runs[0]!.hash, `${run.store} ends on step 0's hash`);
      assert.equal(run.seq, step0.accepted, `${run.store} committed every accepted action`);
      assert.equal(run.roundTrips, step0.accepted, `${run.store}: every commit loaded back strictly equal`);
      if (run.store === "A") {
        assert.deepStrictEqual(run.stateAt, [], "A keeps no history");
      } else {
        assert.equal(run.stateAt.length, 10, run.store);
        assert.ok(run.stateAt.every((c) => c.match), run.store);
      }
    }
    const times = result.stores.filter((s) => s.store !== "A").map((s) => s.stateAt.map((c) => c.t));
    assert.deepStrictEqual(times[1], times[0], "every B is asked at the same times");
    assert.equal(new Set(times[0]).size, 10, "ten different times");
  });

  test("a store that writes something the sim didn't compute fails, labelled store", async () => {
    // Store A, except that the commit after the 100th action quietly stores one extra bread.
    const leaky: StoreSpec = {
      name: "A",
      async create(sql, options) {
        const store = await DEFAULT_SPECS[0]!.create(sql, options);
        return {
          ...store,
          commit: (id, entry) =>
            store.commit(id, entry.expectedSeq === 100 ? { ...entry, next: { ...entry.next, bread: entry.next.bread + 1 } } : entry),
        } satisfies GameStore;
      },
    };
    const result = await runGate(sql, { script, tag: tag(), specs: [leaky] });

    assert.equal(result.step0.pass, true);
    assert.equal(result.pass, false);
    const [run] = result.stores;
    assert.equal(run!.pass, false);
    assert.notEqual(run!.hash, runGate0(script).runs[0]!.hash);
    assert.equal(run!.roundTrips, 100, "the first 100 commits loaded back equal; the 101st didn't");
    assert.ok(result.failures.length > 0);
    assert.ok(result.failures.every((f) => f.store === "A" && f.label === "store"), JSON.stringify(result.failures));
    assert.ok(result.failures.some((f) => f.check === "round trip" && /seq 101/.test(f.detail)), JSON.stringify(result.failures));
  });

  test("a B whose stateAt answers the wrong seq fails the stateAt check, labelled store", async () => {
    const offByOne: StoreSpec = {
      name: "B25",
      async create(sql, options) {
        const store = (await DEFAULT_SPECS[2]!.create(sql, options)) as AuditableStore;
        return {
          ...store,
          async stateAt(id, t) {
            const at = await store.stateAt(id, t);
            return { ...at, seq: at.seq + 1 };
          },
        } satisfies AuditableStore;
      },
    };
    const result = await runGate(sql, { script, tag: tag(), specs: [offByOne] });

    const [run] = result.stores;
    assert.equal(run!.hash, runGate0(script).runs[0]!.hash, "the script itself still ends right");
    assert.equal(run!.pass, false);
    assert.ok(run!.stateAt.every((c) => !c.match));
    assert.deepStrictEqual(new Set(result.failures.map((f) => `${f.store} ${f.check} ${f.label}`)), new Set(["B25 stateAt store"]));
  });

  test("a store that throws fails that store only, labelled store", async () => {
    const broken: StoreSpec = {
      name: "B1",
      async create(sql, options) {
        const store = await DEFAULT_SPECS[1]!.create(sql, options);
        return { ...store, load: () => Promise.reject(new Error("disk on fire")) };
      },
    };
    const result = await runGate(sql, { script, tag: tag(), specs: [broken, DEFAULT_SPECS[0]!] });

    assert.deepStrictEqual(result.stores.map((s) => [s.store, s.pass]), [["B1", false], ["A", true]]);
    assert.equal(result.stores[0]!.hash, null);
    assert.deepStrictEqual(result.failures.map((f) => [f.store, f.label]), [["B1", "store"]]);
    assert.match(result.failures[0]!.detail, /disk on fire/);
  });

  test("when step 0 fails, every failure is labelled sim", async () => {
    // Hidden state outside the farm, as in gate0.test.ts: the rules give a different world each call.
    let calls = 0;
    const leaky: typeof apply = (state, action, at) => {
      const r = apply(state, action, at);
      return r.ok && ++calls % 97 === 0 ? { ok: true, state: { ...r.state, wheat: r.state.wheat + 1 } } : r;
    };
    const result = await runGate(sql, { script, tag: tag(), rules: { newFarm, apply: leaky }, specs: [DEFAULT_SPECS[0]!] });

    assert.equal(result.step0.pass, false);
    assert.equal(result.pass, false);
    assert.ok(result.failures.length > 0);
    assert.ok(result.failures.every((f) => f.label === "sim"), JSON.stringify(result.failures));
  });

  test("the gate leaves no schemas behind", async () => {
    const t = tag();
    await runGate(sql, { script, tag: t, specs: [DEFAULT_SPECS[3]!] });
    const left = await sql`select nspname from pg_namespace where nspname like ${`gate_${t}%`}`;
    assert.deepStrictEqual([...left], []);
  });
});

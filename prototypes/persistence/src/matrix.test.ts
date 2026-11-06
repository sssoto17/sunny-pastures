// The load matrix runner's planning (#15): which configurations to run, in what order, and which
// are already done, so a paused or ended session resumes where it stopped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completed, lock, machineDiff, plan, type Configuration } from "./matrix.ts";

const ids = (configs: Configuration[]) => configs.map((c) => c.id);

test("the matrix runs run 1 of every configuration before any run 2, so a timebox cut leaves one run each", () => {
  const configs = plan({ stores: ["A", "B25"], users: [50, 200], runs: 2 });
  assert.deepStrictEqual(ids(configs), [
    "r1-A-u50", "r1-A-u200", "r1-B25-u50", "r1-B25-u200",
    "r2-A-u50", "r2-A-u200", "r2-B25-u50", "r2-B25-u200",
  ]);
});

test("the full #11 matrix is 4 stores × 2 player counts × 3 runs", () => {
  const configs = plan({ stores: ["A", "B1", "B25", "B100"], users: [50, 200], runs: 3 });
  assert.equal(configs.length, 24);
  assert.equal(new Set(ids(configs)).size, 24);
});

test("each configuration gets its own fresh schema, a valid lower-case Postgres name", () => {
  const configs = plan({ stores: ["A", "B1", "B25", "B100"], users: [50, 200], runs: 3 });
  const schemas = configs.map((c) => c.schema);
  assert.equal(new Set(schemas).size, schemas.length);
  for (const s of schemas) assert.match(s, /^[a-z_][a-z0-9_]{0,62}$/);
  assert.equal(configs.find((c) => c.id === "r2-B100-u200")!.schema, "load_r2_b100_u200");
});

test("a configuration carries what the server needs: STORE and, for B, SNAPSHOT_N", () => {
  const [a, b] = plan({ stores: ["A", "B100"], users: [50], runs: 1 });
  assert.deepStrictEqual([a!.env, b!.env], [{ STORE: "A" }, { STORE: "B", SNAPSHOT_N: "100" }]);
});

test("only configurations whose folder holds done.json count as done; a half-written one runs again", () => {
  const root = mkdtempSync(join(tmpdir(), "matrix-"));
  mkdirSync(join(root, "r1-A-u50"));
  writeFileSync(join(root, "r1-A-u50", "done.json"), "{}");
  mkdirSync(join(root, "r1-A-u200")); // a session ended mid-run: locust output but no done.json
  writeFileSync(join(root, "r1-A-u200", "server.csv"), "t\n");
  writeFileSync(join(root, "README.md"), "not a configuration");

  assert.deepStrictEqual([...completed(root)], ["r1-A-u50"]);
  const pending = plan({ stores: ["A"], users: [50, 200], runs: 1 }).filter((c) => !completed(root).has(c.id));
  assert.deepStrictEqual(ids(pending), ["r1-A-u200"]);
});

test("a results folder that doesn't exist yet has nothing done", () => {
  assert.deepStrictEqual([...completed(join(tmpdir(), "matrix-does-not-exist-" + process.pid))], []);
});

test("resuming on a different machine is caught: the fields that differ are named", () => {
  const recorded = { cpu: "Intel Xeon @ 2.10GHz", cores: 4, ramGiB: 15, os: "Ubuntu 24.04.5 LTS", postgres: "16.15", node: "v24.22.2", locust: "2.47.0" };
  assert.deepStrictEqual(machineDiff(recorded, { ...recorded }), []);
  assert.deepStrictEqual(machineDiff(recorded, { ...recorded, cores: 8, postgres: "17.6" }), ["cores", "postgres"]);
});

test("only one runner at a time: a second one is refused while the first holds the lock", () => {
  // Two runners would share port 4010, and the second would delete the first's half-written
  // folder and drop its live schema (seen in the dry run).
  const path = join(mkdtempSync(join(tmpdir(), "matrix-lock-")), "matrix.lock");
  const release = lock(path);
  assert.throws(() => lock(path), new RegExp(`another matrix runner \\(pid ${process.pid}\\)`));
  release();
  assert.equal(existsSync(path), false);
  lock(path)();
});

test("a lock left by a runner that died (its pid is gone) is taken over", () => {
  const path = join(mkdtempSync(join(tmpdir(), "matrix-lock-")), "matrix.lock");
  writeFileSync(path, "2147483646\n"); // no such process
  const release = lock(path);
  release();
});

test("normal configurations carry ADR-0001's timing: 60 s warm-up, 300 s measured, players wait between taps", () => {
  const [c] = plan({ stores: ["A"], users: [50], runs: 1 });
  assert.deepStrictEqual([c!.kind, c!.warmupS, c!.measureS, c!.noWait], ["normal", 60, 300, false]);
});

test("one stress run per store comes after every normal configuration: 200 users, no wait, 60 s + 120 s", () => {
  const configs = plan({ stores: ["A", "B1", "B25", "B100"], users: [50, 200], runs: 3, stress: { users: 200, warmupS: 60, measureS: 120 } });
  assert.equal(configs.length, 28);
  assert.deepStrictEqual(ids(configs.slice(24)), ["stress-A-u200", "stress-B1-u200", "stress-B25-u200", "stress-B100-u200"]);
  assert.ok(configs.slice(0, 24).every((c) => c.kind === "normal" && !c.noWait));
  const s = configs.find((c) => c.id === "stress-B25-u200")!;
  assert.deepStrictEqual(
    { kind: s.kind, users: s.users, warmupS: s.warmupS, measureS: s.measureS, noWait: s.noWait, schema: s.schema, env: s.env },
    { kind: "stress", users: 200, warmupS: 60, measureS: 120, noWait: true, schema: "load_stress_b25_u200", env: { STORE: "B", SNAPSHOT_N: "25" } },
  );
});

test("the normal timing can be shortened (dry runs) without touching the stress timing", () => {
  const configs = plan({ stores: ["A"], users: [50], runs: 1, warmupS: 5, measureS: 10, stress: { users: 200, warmupS: 60, measureS: 120 } });
  assert.deepStrictEqual(configs.map((c) => [c.id, c.warmupS, c.measureS]), [["r1-A-u50", 5, 10], ["stress-A-u200", 60, 120]]);
});

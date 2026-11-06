// The full equivalence gate (ADR-0001 "Decision rule", step 1; issue #9). Step 0 runs first, with
// no database. Then, for each store (A, B1, B25, B100), the 500-action script is played through
// the store itself, with explicit times and no HTTP: load → apply at the step's time → commit, the
// handler's loop without its clock. Each store must
//   - load every commit back strictly equal (types included) to the in-memory farm (round trip),
//   - end on step 0's state hash and seq (script),
//   - for B, answer `stateAt` like the in-memory sim at 10 random times (stateAt).
// A failure is labelled by step 0: if step 0 failed, the sim is at fault; if it passed, the store.
//
// The script claims gifts it makes up (`alice:7`), which the inbox refuses unless they exist. So
// before each store's run, a fresh inbox schema is seeded with every gift the script claims, sent
// at time 0 to the gate's farm. The script, and so step 0's hash, stay unchanged, and no run sees
// another run's gifts.
//
// Run: pnpm --filter @sunny-pastures/persistence-spike gate [seed]
// Needs DATABASE_URL (read from the repo .env; never printed). Uses throwaway schemas `gate_<tag>_*`
// and drops them when it is done.

import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import { DEFAULT_SEED, report as report0, runGate0, type Gate0Result, type Rules } from "./gate0.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import { generateScript, type Script } from "./script.ts";
import { advance, apply, mulberry32, newFarm, stateHash, type FarmState } from "./sim.ts";
import { connect, createStoreA } from "./store-a.ts";
import { createStoreB } from "./store-b.ts";
import { replay } from "./stores.ts";
import type { AuditableStore, FarmRecord, GameStore } from "./store.ts";

export type StoreName = "A" | "B1" | "B25" | "B100";
export type Label = "sim" | "store";
export type Check = "round trip" | "script" | "stateAt";

export type Failure = { store: StoreName; check: Check; label: Label; detail: string };

export type StateAtCheck = { t: number; seq: number; hash: string; match: boolean };

export type StoreRun = {
  store: StoreName;
  pass: boolean;
  /** The state hash of the farm the store loads after the script, or null if the run threw. */
  hash: string | null;
  seq: number | null;
  /** Commits that loaded back strictly equal to the in-memory farm. */
  roundTrips: number;
  /** Empty for A, which keeps no history. */
  stateAt: StateAtCheck[];
};

export type GateResult = {
  pass: boolean;
  step0: Gate0Result;
  stores: StoreRun[];
  failures: Failure[];
};

export type StoreOptions = { schema: string; inbox: Inbox; newFarm: (playerId: string) => FarmState };
/** How the gate builds one store; a test can hand in a broken one. */
export type StoreSpec = { name: StoreName; create(sql: Sql, options: StoreOptions): Promise<GameStore> };

export const DEFAULT_SPECS: readonly StoreSpec[] = [
  { name: "A", create: (sql, o) => createStoreA(sql, o) },
  ...([1, 25, 100] as const).map((n): StoreSpec => ({
    name: `B${n}`,
    create: (sql, o) => createStoreB(sql, { ...o, snapshotN: n, replay }),
  })),
];

/** The farm the script is played on; the script's gifts go to and from it. */
export const GATE_FARM = "gate";
export const STATE_AT_CHECKS = 10;
/** Seeds the choice of audit times, so every B variant (and every run) is asked the same ones. */
const STATE_AT_SEED = 0x57a7e;

export type GateOptions = {
  script: Script;
  /** Makes the run's schema names unique: `gate_<tag>_<store>` and `gate_<tag>_<store>_inbox`. */
  tag: string;
  specs?: readonly StoreSpec[];
  rules?: Rules;
};

export async function runGate(sql: Sql, { script, tag, specs = DEFAULT_SPECS, rules = { newFarm, apply } }: GateOptions): Promise<GateResult> {
  const step0 = runGate0(script, rules);
  const label: Label = step0.pass ? "store" : "sim";
  const expected = { hash: step0.runs[0]!.hash, seq: step0.accepted };
  const times = auditTimes(script);

  const stores: StoreRun[] = [];
  const failures: Failure[] = [];
  for (const spec of specs) {
    const problems: { check: Check; detail: string }[] = [];
    const run = await runStore(sql, spec, `gate_${tag}_${spec.name.toLowerCase()}`, script, rules, expected, times, problems);
    stores.push(run);
    failures.push(...problems.map((p) => ({ store: spec.name, label, ...p })));
  }
  return { pass: step0.pass && failures.length === 0, step0, stores, failures };
}

async function runStore(
  sql: Sql,
  spec: StoreSpec,
  schema: string,
  script: Script,
  rules: Rules,
  expected: { hash: string; seq: number },
  times: number[],
  problems: { check: Check; detail: string }[],
): Promise<StoreRun> {
  const run: StoreRun = { store: spec.name, pass: false, hash: null, seq: null, roundTrips: 0, stateAt: [] };
  const inboxSchema = `${schema}_inbox`;
  try {
    const inbox = await createInbox(sql, { schema: inboxSchema });
    for (const claim of claimedGifts(script, rules)) {
      const refused = await inbox.send(sql, { ...claim, to: GATE_FARM, sentAt: 0 });
      if (refused) throw new Error(`seeding gift ${claim.id}: ${refused}`);
    }
    const store = await spec.create(sql, { schema, inbox, newFarm: () => rules.newFarm(script.seed) });

    const final = await playScript(store, script, rules, run, problems);
    run.hash = stateHash(final.state);
    run.seq = final.seq;
    if (run.hash !== expected.hash || run.seq !== expected.seq) {
      problems.push({
        check: "script",
        detail: `ends at seq ${run.seq} with hash ${run.hash}; the in-memory sim ends at seq ${expected.seq} with ${expected.hash}`,
      });
    }

    if (isAuditable(store)) {
      for (const t of times) {
        const want = simAt(script, rules, t);
        const got = await store.stateAt(GATE_FARM, t);
        const match = isDeepStrictEqual(got, want);
        run.stateAt.push({ t, seq: got.seq, hash: stateHash(got.state), match });
        if (!match) {
          problems.push({
            check: "stateAt",
            detail: `at t=${t}: seq ${got.seq}, hash ${stateHash(got.state)}; the sim has seq ${want.seq}, hash ${stateHash(want.state)}`,
          });
        }
      }
    }
  } catch (e) {
    problems.push({ check: "script", detail: `threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` });
  } finally {
    await sql`drop schema if exists ${sql(schema)} cascade`;
    await sql`drop schema if exists ${sql(inboxSchema)} cascade`;
  }
  run.pass = problems.length === 0;
  return run;
}

/**
 * Plays the script through `store` the way the handler would, minus its clock: each step is
 * applied at its own time to the farm the store loads, and committed if the rules accept it.
 * Next to it runs the in-memory farm, and every load is compared with it strictly.
 */
async function playScript(
  store: GameStore,
  script: Script,
  rules: Rules,
  run: StoreRun,
  problems: { check: Check; detail: string }[],
): Promise<FarmRecord> {
  let memory: FarmRecord = { state: rules.newFarm(script.seed), seq: 0, at: 0 };
  let mismatches = 0;
  let loads = 0;
  /** Whether the last step committed, so the next load is that commit's round trip. */
  let committed = false;

  const loadAndCompare = async (): Promise<FarmRecord> => {
    const loaded = await store.load(GATE_FARM);
    loads++;
    if (isDeepStrictEqual(loaded, memory)) {
      if (committed) run.roundTrips++;
    } else if (mismatches++ === 0) {
      problems.push({
        check: "round trip",
        detail: `seq ${memory.seq} loaded back as seq ${loaded.seq} at ${loaded.at}, hash ${stateHash(loaded.state)}; ` +
          `the in-memory farm is at ${memory.at}, hash ${stateHash(memory.state)}`,
      });
    }
    return loaded;
  };

  for (const [i, { action, at }] of script.steps.entries()) {
    const loaded = await loadAndCompare();
    committed = false;
    const inMemory = rules.apply(memory.state, action, at);
    if (inMemory.ok) memory = { state: inMemory.state, seq: memory.seq + 1, at };

    const result = rules.apply(advance(loaded.state, at), action, at);
    if (result.ok !== inMemory.ok) {
      problems.push({
        check: "script",
        detail: `step ${i + 1} (${action.type}): the store's farm ${result.ok ? "accepted" : "refused"} what the in-memory sim ${inMemory.ok ? "accepted" : "refused"}`,
      });
    }
    if (!result.ok) continue;

    const seq = loaded.seq + 1;
    const outcome = await store.commit(GATE_FARM, {
      expectedSeq: loaded.seq,
      action,
      at,
      idempotencyKey: `step-${i + 1}`,
      next: result.state,
      answer: { seq, hash: stateHash(result.state), rebased: false, retries: 0 },
    });
    if (outcome.kind !== "committed" || outcome.seq !== seq) {
      throw new Error(`step ${i + 1} (${action.type}) at seq ${seq}: commit answered ${JSON.stringify(outcome)}`);
    }
    committed = true;
  }
  const final = await loadAndCompare();
  if (mismatches > 1) {
    problems.push({ check: "round trip", detail: `${mismatches} of ${loads} loads differed from the in-memory farm` });
  }
  return final;
}

/** Every gift the script claims and the rules accept the claim of, with the claimed goods. */
function claimedGifts(script: Script, rules: Rules) {
  const gifts: { id: string; from: string; goods: { wheat: number; bread: number } }[] = [];
  let farm = rules.newFarm(script.seed);
  for (const { action, at } of script.steps) {
    const r = rules.apply(farm, action, at);
    if (!r.ok) continue;
    farm = r.state;
    if (action.type === "claimGift") gifts.push({ id: action.giftId, from: action.giftId.split(":")[0]!, goods: action.goods });
  }
  return gifts;
}

/** The in-memory sim's answer to `stateAt(t)`: the accepted actions up to `t`, then advanced to `t`. */
function simAt(script: Script, rules: Rules, t: number): { state: FarmState; seq: number } {
  let state = rules.newFarm(script.seed);
  let seq = 0;
  for (const { action, at } of script.steps) {
    if (at > t) break;
    const r = rules.apply(state, action, at);
    if (!r.ok) continue;
    state = r.state;
    seq++;
  }
  return { state: advance(state, t), seq };
}

/**
 * Ten different times, spread over the script's steps rather than its clock: each picks a step at
 * random, then a moment from that step up to just before the next one. Picking by clock would put
 * most of them in the 8-hour gap; picking by step still lands in it about once in 50.
 */
function auditTimes(script: Script): number[] {
  const { steps } = script;
  let rng = (script.seed ^ STATE_AT_SEED) >>> 0;
  const draw = (below: number) => {
    const d = mulberry32(rng);
    rng = d.next;
    return Math.floor((d.value / 2 ** 32) * below);
  };
  const times = new Set<number>();
  while (times.size < STATE_AT_CHECKS) {
    const i = draw(steps.length);
    const span = i + 1 < steps.length ? steps[i + 1]!.at - steps[i]!.at : 1;
    times.add(steps[i]!.at + draw(span));
  }
  return [...times].sort((a, b) => a - b);
}

function isAuditable(store: GameStore): store is AuditableStore {
  return typeof (store as Partial<AuditableStore>).stateAt === "function";
}

export function report(result: GateResult, seed: number): string {
  const lines = [
    report0(result.step0, seed),
    "",
    "Gate step 1 (ADR-0001): the same script through each store, called directly with explicit times",
    "",
    ...result.stores.flatMap((run) => [
      `${run.store.padEnd(5)} ${run.pass ? "PASS" : "FAIL"}  seq ${run.seq ?? "-"}  hash ${run.hash ?? "-"}  ` +
        `round trips ${run.roundTrips}/${result.step0.accepted}` +
        (run.store === "A" ? "  stateAt n/a (no history)" : `  stateAt ${run.stateAt.filter((c) => c.match).length}/${run.stateAt.length}`),
      ...run.stateAt.map((c) => `        stateAt t=${String(c.t).padStart(8)}  seq ${String(c.seq).padStart(3)}  ${c.hash}  ${c.match ? "match" : "MISMATCH"}`),
    ]),
    ...result.failures.map((f) => `failure [${f.label}] ${f.store} ${f.check}: ${f.detail}`),
    "",
    result.pass
      ? "PASS: every store ends on step 0's hash, loads every commit back strictly equal, and every B's stateAt matches the sim"
      : result.step0.pass
        ? `FAIL: store code (${[...new Set(result.failures.map((f) => f.store))].join(", ")}); step 0 passed, so the sim is not at fault`
        : "FAIL: the sim (step 0 failed); store results are not evidence against any store",
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const seed = process.argv[2] === undefined ? DEFAULT_SEED : Number(process.argv[2]);
  if (!Number.isSafeInteger(seed)) {
    console.error(`seed must be an integer, got ${process.argv[2]}`);
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (run with --env-file pointing at the repo .env)");
    process.exit(1);
  }
  const sql = connect(url);
  try {
    const result = await runGate(sql, { script: generateScript(seed), tag: Date.now().toString(36) });
    console.log(report(result, seed));
    process.exitCode = result.pass ? 0 : 1;
  } finally {
    await sql.end();
  }
}

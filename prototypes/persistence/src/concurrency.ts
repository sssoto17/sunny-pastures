// The concurrency check (ADR-0001 "Method", #8): two requests hit one farm at the same instant,
// over HTTP against the spike server, 1,000 times per store configuration.
//
//   gift+harvest  sendGift and harvest on one farm at once: the goods are gone, the wheat is in,
//                 the gift row exists and seq went up by exactly 2.
//   same key      one harvest sent twice at once with one idempotency key: one commit, one
//                 identical duplicate answer, seq up by exactly 1.
//   control       X sends Y a gift while Y harvests: two farms, so 0 retries.
//
// Farms are set up in-process through the same handler and store, with a clock 10 minutes in the
// past, so their wheat is ripe when the server (real clock, untouched) gets the pair.
//
// Run: pnpm --filter @sunny-pastures/persistence-spike concurrency [pairs=1000] [A,B1,B25,B100]
// Needs DATABASE_URL (read from the repo .env; never printed). Uses the server's default schemas,
// with farm ids unique to the run.

import { spawn, type ChildProcess } from "node:child_process";
import { cpus } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { handleAction } from "./handler.ts";
import { advance, apply, type FarmState } from "./sim.ts";
import { connect } from "./store-a.ts";
import { createStore, storeConfig, type StoreConfig } from "./stores.ts";
import type { Answer, GameStore } from "./store.ts";

const MIN = 60_000;
const PORT = 4008;
const BASE = `http://127.0.0.1:${PORT}`;
const SCENARIOS = ["gift+harvest", "same key", "control"] as const;
type Scenario = (typeof SCENARIOS)[number];

type Tally = {
  pairs: number;
  /** A pair where both requests were answered 200 but the farm doesn't show both effects (or shows one twice). */
  lostUpdates: number;
  retries: number;
  /** Requests answered 503 (still busy after 3 retries). */
  unavailable: number;
  /** Requests answered with a stored first answer instead of a commit of their own. */
  duplicates: number;
  /** Any other non-200 (422, 500, …), with the first few reasons. */
  otherErrors: number;
  examples: string[];
  ms: number;
};

type Reply = { status: number; body: Answer | { error: string } };

const pairs = Number(process.argv[2] ?? 1000);
const names = (process.argv[3] ?? "A,B1,B25,B100").split(",");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (run with --env-file pointing at the repo .env)");
  process.exit(1);
}
if (!Number.isSafeInteger(pairs) || pairs < 1) throw new Error(`pairs must be a positive integer, got ${process.argv[2]}`);

const run = Date.now().toString(36);
const sql = connect(url);
const results: { config: string; scenario: Scenario; tally: Tally }[] = [];


async function runScenario(store: GameStore, config: string, scenario: Scenario): Promise<Tally> {
  const tally: Tally = { pairs, lostUpdates: 0, retries: 0, unavailable: 0, duplicates: 0, otherErrors: 0, examples: [], ms: 0 };
  const started = performance.now();
  for (let i = 0; i < pairs; i++) {
    const x = `cc-${run}-${config}-${scenario === "same key" ? "k" : scenario === "control" ? "c" : "g"}${i}`.replace(/[^\w-]/g, "");
    const y = `${x}-y`;
    const lost = await PAIRS[scenario](store, x, y, tally);
    if (lost) {
      tally.lostUpdates++;
      if (tally.examples.length < 5) tally.examples.push(`${x}: ${lost}`);
    }
  }
  tally.ms = Math.round(performance.now() - started);
  return tally;
}

/** Each runs one pair and returns why it counts as a lost update, or null. */
const PAIRS: Record<Scenario, (store: GameStore, x: string, y: string, tally: Tally) => Promise<string | null>> = {
  async "gift+harvest"(store, x, _y, tally) {
    const pre = await setUp(store, x, "rich");
    const gift = { wheat: 1, bread: 0 };
    const to = `${x}-friend`;
    const [send, harvest] = await Promise.all([
      post(x, { type: "sendGift", to, goods: gift }, pre.seq, "send"),
      post(x, { type: "harvest", plot: 1 }, pre.seq, "harvest"),
    ]);
    if (!count([send, harvest], tally)) return null;
    const after = await store.load(x);
    const sent = send.body as Answer;
    const harvestYield = yieldOf(pre.state, after.at);
    const problems = [
      after.seq !== pre.seq + 2 && `seq ${pre.seq} → ${after.seq}`,
      after.state.wheat !== pre.state.wheat - gift.wheat + harvestYield && `wheat ${pre.state.wheat} → ${after.state.wheat}`,
      after.state.plots[1]!.status !== "empty" && "plot 1 not harvested",
      !isDeepStrictEqual((await store.gift(`${x}:${sent.seq}`))?.goods, gift) && `no gift ${x}:${sent.seq}`,
    ].filter(Boolean);
    return problems.length ? problems.join(", ") : null;
  },

  async "same key"(store, x, _y, tally) {
    const pre = await setUp(store, x, "ripe");
    const replies = await Promise.all([1, 2].map(() => post(x, { type: "harvest", plot: 0 }, pre.seq, "once")));
    if (!count(replies, tally)) return null;
    const after = await store.load(x);
    if (isDeepStrictEqual(replies[0]!.body, replies[1]!.body)) tally.duplicates++;
    else return `answers differ: ${JSON.stringify(replies.map((r) => r.body))}`;
    return after.seq === pre.seq + 1 ? null : `seq ${pre.seq} → ${after.seq}`;
  },

  async control(store, x, y, tally) {
    const [preX, preY] = await Promise.all([setUp(store, x, "rich"), setUp(store, y, "ripe")]);
    const [send, harvest] = await Promise.all([
      post(x, { type: "sendGift", to: y, goods: { wheat: 1, bread: 0 } }, preX.seq, "send"),
      post(y, { type: "harvest", plot: 0 }, preY.seq, "harvest"),
    ]);
    if (!count([send, harvest], tally)) return null;
    const [postX, postY] = [await store.load(x), await store.load(y)];
    const problems = [
      postX.seq !== preX.seq + 1 && `${x} seq ${preX.seq} → ${postX.seq}`,
      postY.seq !== preY.seq + 1 && `${y} seq ${preY.seq} → ${postY.seq}`,
      (await store.gift(`${x}:${postX.seq}`))?.to !== y && "no gift row",
    ].filter(Boolean);
    return problems.length ? problems.join(", ") : null;
  },
};

/** Counts retries, 503s and other errors. True when both got a 200, so the farm can be checked. */
function count(replies: Reply[], t: Tally): boolean {
  for (const r of replies) {
    if (r.status === 200) t.retries += (r.body as Answer).retries;
    else if (r.status === 503) t.unavailable++;
    else {
      t.otherErrors++;
      if (t.examples.length < 5) t.examples.push(`${r.status}: ${JSON.stringify(r.body)}`);
    }
  }
  return replies.every((r) => r.status === 200);
}

/**
 * A farm 10 minutes into the past: "ripe" has plot 0 ready; "rich" has wheat and plot 1 ready.
 * Through the handler and the store directly, so the pair under test is the only HTTP traffic.
 */
async function setUp(store: GameStore, farmId: string, kind: "ripe" | "rich") {
  const t0 = Date.now() - 10 * MIN;
  const steps: [unknown, number][] = kind === "ripe"
    ? [[{ type: "plant", plot: 0 }, t0]]
    : [[{ type: "plant", plot: 0 }, t0], [{ type: "plant", plot: 1 }, t0], [{ type: "harvest", plot: 0 }, t0 + 2 * MIN]];
  for (const [i, [action, at]] of steps.entries()) {
    const res = await handleAction(store, () => at, farmId, { action, expectedSeq: i, idempotencyKey: `setup-${i}` });
    if (res.status !== 200) throw new Error(`setting up ${farmId}: ${JSON.stringify(res.body)}`);
  }
  return store.load(farmId);
}

/** The wheat a harvest of plot 1 gives this farm: the sim's own draw, the same in either order. */
function yieldOf(farm: FarmState, at: number): number {
  const r = apply(advance(farm, at), { type: "harvest", plot: 1 }, at);
  if (!r.ok) throw new Error(r.reason);
  return r.state.wheat - farm.wheat;
}

async function post(farmId: string, action: unknown, expectedSeq: number, idempotencyKey: string): Promise<Reply> {
  const res = await fetch(`${BASE}/farms/${farmId}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, expectedSeq, idempotencyKey }),
  });
  return { status: res.status, body: (await res.json()) as Reply["body"] };
}

async function startServer(config: StoreConfig): Promise<ChildProcess> {
  const env = { ...process.env, PORT: String(PORT), STORE: config.name.slice(0, 1) };
  if (config.name === "A") delete env.SNAPSHOT_N;
  else env.SNAPSHOT_N = String(config.snapshotN);
  // stdout carries only the "listening" line; stderr (errors) is passed through.
  const child = spawn(process.execPath, ["src/server.ts"], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/farms/ready-check`);
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  child.kill();
  throw new Error(`server for ${config.name} did not start`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}

function report(): string {
  const lines = [
    `Run ${run} on ${new Date().toISOString().slice(0, 10)}: ${pairs} pairs per scenario, Node ${process.version}, ${cpus().length} CPUs.`,
    "",
    "| Store | Scenario | Pairs | Lost updates | Retries | 503s | Duplicates | Other errors | Time (s) |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map(({ config, scenario, tally: t }) =>
      `| ${config} | ${scenario} | ${t.pairs} | ${t.lostUpdates} | ${t.retries} | ${t.unavailable} | ${t.duplicates} | ${t.otherErrors} | ${(t.ms / 1000).toFixed(1)} |`),
  ];
  const examples = results.flatMap(({ config, scenario, tally: t }) => t.examples.map((e) => `- ${config} ${scenario}: ${e}`));
  if (examples.length) lines.push("", "Examples:", ...examples);
  return lines.join("\n");
}

// Last, so every declaration above is initialised before the run starts.
try {
  for (const name of names) {
    const config = storeConfig(name === "A" ? { STORE: "A" } : { STORE: "B", SNAPSHOT_N: name.slice(1) });
    const store = await createStore(sql, config);
    const server = await startServer(config);
    try {
      for (const scenario of SCENARIOS) {
        const tally = await runScenario(store, config.name, scenario);
        results.push({ config: config.name, scenario, tally });
        console.error(`${config.name} ${scenario}: ${JSON.stringify({ ...tally, examples: tally.examples.length })}`);
      }
    } finally {
      await stopServer(server);
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}

console.log(report());

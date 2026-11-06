// The spike's HTTP layer (ADR-0001 "Method", #10): routes a request to the handler and writes the
// reply. Transport only: the handler owns load → advance → apply → commit.
//   GET  /farms/:id          → { seq, hash, state }, advanced to server time in memory, writes nothing
//   POST /farms/:id/actions  ← { action, expectedSeq, idempotencyKey } → { seq, hash, rebased, retries }
//   GET  /farms/:id/at/:t    → { at, hash, state }: the farm at server time t (ms); B only, 501 on A
// With SPIKE_CLOCK=1 only (load runs, never the game):
//   X-Spike-Clock-Offset: <ms> on any request moves that request's server time forward
//   POST /spike/seed     ← { prefix, players, actions? } → { seeded, skipped, farms: [{ farm, seq }] }
//   GET  /spike/storage  → bytes and rows per table of this store's schema
// Every response carries Server-Timing (load, sim, commit, total); see timing.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAction, handleRead, handleStateAt, type Clock, type Reply } from "./handler.ts";
import { parseSeedRequest, seedFarms } from "./seed.ts";
import { StoreError, type GameStore } from "./store.ts";
import { round, serverTimingHeader, timed, type TimingRow } from "./timing.ts";

export type { TimingRow } from "./timing.ts";

const MAX_BODY_BYTES = 16 * 1024;

export type AppOptions = {
  store: GameStore;
  /** A, B1, B25 or B100: written to every timing row. */
  storeName: string;
  /** Server time in integer ms. */
  clock: Clock;
  /** SPIKE_CLOCK=1: honour the clock-offset header and serve the /spike endpoints. */
  spikeClock: boolean;
  onTiming: (row: TimingRow) => void;
  /** GET /spike/storage's answer; 501 if not given. */
  storage?: () => Promise<unknown>;
};

type Routed = { route: string; farm: string; reply: Reply<unknown> };

export function createApp(opts: AppOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const start = performance.now();
    const { store, timings } = timed(opts.store);
    let routed: Routed;
    let handlerMs = 0;
    try {
      const clock = requestClock(opts, req);
      if ("error" in clock) {
        routed = { route: "none", farm: "", reply: { status: 400, body: { error: clock.error } } };
      } else {
        routed = await route(opts, req, store, clock.now, (ms) => (handlerMs = ms));
      }
    } catch (e) {
      console.error(e instanceof StoreError ? `store error: ${e.message}` : e);
      routed = {
        route: "none",
        farm: "",
        reply: { status: 500, body: { error: e instanceof StoreError ? "store error" : "internal error" } },
      };
    }
    const loadMs = round(timings.loadMs);
    const commitMs = round(timings.commitMs);
    const row: TimingRow = {
      t: Date.now(),
      store: opts.storeName,
      method: req.method ?? "",
      route: routed.route,
      farm: routed.farm,
      status: routed.reply.status,
      loadMs,
      commitMs,
      simMs: round(Math.max(0, handlerMs - timings.loadMs - timings.commitMs)),
      totalMs: round(performance.now() - start),
      retries: routed.route === "action" && routed.reply.status === 200
        ? (routed.reply.body as { retries: number }).retries
        : null,
      offsetMs: offsetOf(opts, req),
    };
    opts.onTiming(row);
    res.writeHead(routed.reply.status, {
      "content-type": "application/json",
      "server-timing": serverTimingHeader(row),
    });
    res.end(JSON.stringify(routed.reply.body));
  };
}

/** Picks the route; `handled(ms)` gets the time spent in the handler, after the body was read. */
async function route(
  opts: AppOptions,
  req: IncomingMessage,
  store: GameStore,
  clock: Clock,
  handled: (ms: number) => void,
): Promise<Routed> {
  const url = new URL(req.url ?? "/", "http://spike");
  const read = url.pathname.match(/^\/farms\/([\w-]{1,64})$/);
  const act = url.pathname.match(/^\/farms\/([\w-]{1,64})\/actions$/);
  const audit = url.pathname.match(/^\/farms\/([\w-]{1,64})\/at\/([^/]{1,20})$/);
  const run = async (routeName: string, farm: string, handler: () => Promise<Reply<unknown>>) => {
    const start = performance.now();
    const reply = await handler();
    handled(performance.now() - start);
    return { route: routeName, farm, reply };
  };

  if (read && req.method === "GET") return run("read", read[1]!, () => handleRead(store, clock, read[1]!));
  if (audit && req.method === "GET") return run("stateAt", audit[1]!, () => handleStateAt(store, audit[1]!, audit[2]!));
  if (act && req.method === "POST") {
    const body = await jsonBody(req);
    if (body instanceof Error) return { route: "action", farm: act[1]!, reply: badRequest(body) };
    return run("action", act[1]!, () => handleAction(store, clock, act[1]!, body));
  }
  if (opts.spikeClock && url.pathname === "/spike/seed" && req.method === "POST") {
    const body = await jsonBody(req);
    const seed = body instanceof Error ? body : parseSeedRequest(body);
    if (seed instanceof Error || typeof seed === "string") return { route: "seed", farm: "", reply: badRequest(seed) };
    // With farms seeded in parallel, load and commit add up across them, so sim reads 0 here.
    return run("seed", "", async () => ({ status: 200, body: await seedFarms(store, seed, clock()) }));
  }
  if (opts.spikeClock && url.pathname === "/spike/storage" && req.method === "GET") {
    const { storage } = opts;
    if (!storage) return { route: "storage", farm: "", reply: { status: 501, body: { error: "no storage report" } } };
    return run("storage", "", async () => ({ status: 200, body: await storage() }));
  }
  return { route: "none", farm: "", reply: { status: 404, body: { error: "not found" } } };
}

/** This request's server time: the base clock, moved forward by the offset header if allowed. */
function requestClock(opts: AppOptions, req: IncomingMessage): { now: Clock } | { error: string } {
  const offset = offsetOf(opts, req);
  if (Number.isNaN(offset)) return { error: "X-Spike-Clock-Offset must be non-negative integer ms" };
  return { now: offset === 0 ? opts.clock : () => opts.clock() + offset };
}

/** The offset header in ms: 0 if absent or not honoured, NaN if malformed. */
function offsetOf(opts: AppOptions, req: IncomingMessage): number {
  const header = req.headers["x-spike-clock-offset"];
  if (!opts.spikeClock || header === undefined) return 0;
  return typeof header === "string" && /^\d{1,15}$/.test(header) ? Number(header) : NaN;
}

function badRequest(reason: Error | string): Reply<{ error: string }> {
  return { status: 400, body: { error: reason instanceof Error ? reason.message : reason } };
}

/** The parsed JSON body, or the error that stopped it (too large, not JSON). */
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req));
  } catch (e) {
    return e instanceof Error ? e : new Error("bad body");
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Spike server (ADR-0001 "Method"). Routes and replies are in app.ts; this file only wires them up.
// Reads PORT, DATABASE_URL, STORE (A|B), SNAPSHOT_N (1|25|100), and for load runs (#10):
//   SPIKE_CLOCK=1  honour X-Spike-Clock-Offset and serve /spike/seed and /spike/storage
//   TIMING_CSV     where each response's timings go (default load/results/server-<store>-<time>.csv)

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { createApp } from "./app.ts";
import { storageReport } from "./storage.ts";
import { connect } from "./store-a.ts";
import { createStore, storeConfig, storeSchema } from "./stores.ts";
import { csvSink } from "./timing.ts";

const port = Number(process.env.PORT ?? 4005);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set (run `pnpm db:env` at the repo root, then use --env-file)");
  process.exit(1);
}

let config;
try {
  config = storeConfig(process.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const spikeClock = process.env.SPIKE_CLOCK === "1";
const csvPath = process.env.TIMING_CSV ||
  `load/results/server-${config.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
mkdirSync(dirname(csvPath), { recursive: true });
const timing = csvSink(csvPath);

const sql = connect(databaseUrl);
const store = await createStore(sql, config);
const schema = storeSchema(config);
const server = createServer(
  createApp({
    store,
    storeName: config.name,
    clock: () => Date.now(),
    spikeClock,
    onTiming: timing.write,
    storage: () => storageReport(sql, schema),
  }),
);

// Keep idle keep-alive connections longer than any client waits between requests (Locust's
// returning players wait up to 30 s). With Node's 5 s default, the server closes a connection just
// as the client reuses it, and the request fails with no status: a harness error, not a result.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(port, () => {
  console.log(`spike server (store ${config.name}) on http://127.0.0.1:${port}`);
  console.log(`timings → ${csvPath}${spikeClock ? "; SPIKE_CLOCK=1: clock offset, /spike/seed, /spike/storage" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void Promise.all([timing.close(), sql.end({ timeout: 5 })]).then(() => process.exit(0));
  });
}

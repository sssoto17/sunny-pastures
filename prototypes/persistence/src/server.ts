// Spike server (ADR-0001 "Method"). Reads PORT, DATABASE_URL, STORE (A|B) and SNAPSHOT_N (1|25|100).
//   GET  /farms/:id          → { seq, hash, state }, advanced to server time in memory, writes nothing
//   POST /farms/:id/actions  ← { action, expectedSeq, idempotencyKey } → { seq, hash, rebased, retries }
//   GET  /farms/:id/at/:t    → { at, hash, state }: the farm at server time t (ms); B only, 501 on A

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleAction, handleRead, handleStateAt, type Clock } from "./handler.ts";
import { connect } from "./store-a.ts";
import { StoreError } from "./store.ts";
import { createStore, storeConfig } from "./stores.ts";

const MAX_BODY_BYTES = 16 * 1024;

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

const sql = connect(databaseUrl);
const store = await createStore(sql, config);
const now: Clock = () => Date.now();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://spike");
    const read = url.pathname.match(/^\/farms\/([\w-]{1,64})$/);
    const act = url.pathname.match(/^\/farms\/([\w-]{1,64})\/actions$/);
    const audit = url.pathname.match(/^\/farms\/([\w-]{1,64})\/at\/([^/]{1,20})$/);

    if (read && req.method === "GET") return send(res, await handleRead(store, now, read[1]!));
    if (audit && req.method === "GET") return send(res, await handleStateAt(store, audit[1]!, audit[2]!));
    if (act && req.method === "POST") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return send(res, { status: 400, body: { error: e instanceof Error ? e.message : "bad body" } });
      }
      return send(res, await handleAction(store, now, act[1]!, body));
    }
    send(res, { status: 404, body: { error: "not found" } });
  } catch (e) {
    console.error(e instanceof StoreError ? `store error: ${e.message}` : e);
    send(res, { status: 500, body: { error: e instanceof StoreError ? "store error" : "internal error" } });
  }
});

server.listen(port, () => console.log(`spike server (store ${config.name}) on http://127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void sql.end({ timeout: 5 }).then(() => process.exit(0));
  });
}

function send(res: ServerResponse, reply: { status: number; body: unknown }): void {
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
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

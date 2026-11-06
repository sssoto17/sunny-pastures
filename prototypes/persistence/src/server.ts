// Spike server (ADR-0001 "Method"). Reads PORT and DATABASE_URL from the environment.
//   GET  /farms/:id          → { seq, hash, state }, advanced to server time in memory, writes nothing
//   POST /farms/:id/actions  ← { action, expectedSeq, idempotencyKey } → { seq, hash, rebased, retries }

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleAction, handleRead, type Clock } from "./handler.ts";
import { newFarm } from "./sim.ts";
import { connect, createStoreA } from "./store-a.ts";
import { StoreError } from "./store.ts";

const MAX_BODY_BYTES = 16 * 1024;

const port = Number(process.env.PORT ?? 4005);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set (run `pnpm db:env` at the repo root, then use --env-file)");
  process.exit(1);
}

const sql = connect(databaseUrl);
const store = await createStoreA(sql, { newFarm: (id) => newFarm(fnv1a(id)) });
const now: Clock = () => Date.now();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://spike");
    const read = url.pathname.match(/^\/farms\/([\w-]{1,64})$/);
    const act = url.pathname.match(/^\/farms\/([\w-]{1,64})\/actions$/);

    if (read && req.method === "GET") return send(res, await handleRead(store, now, read[1]!));
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

server.listen(port, () => console.log(`spike server (store A) on http://127.0.0.1:${port}`));

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

/** FNV-1a over the farm id: a stable seed, so a farm's bonus rolls don't depend on the server. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

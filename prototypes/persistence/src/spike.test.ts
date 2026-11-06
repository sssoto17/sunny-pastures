// The HTTP seam on the real local Postgres (DATABASE_URL): seeding through stores A and B25, and
// the storage report. Each run uses its own throwaway schemas.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { createApp } from "./app.ts";
import { storageReport } from "./storage.ts";
import { connect } from "./store-a.ts";
import { createStore, type StoreConfig } from "./stores.ts";

const url = process.env.DATABASE_URL;
const NOW = 1_800_000_000_000;

const configs: { config: StoreConfig; tables: Record<string, number> }[] = [
  // 3 players × 50 actions, plus (i × 37) mod 100: 50, 87 and 124 actions, 261 in all.
  { config: { name: "A" }, tables: { farms: 3, processed_keys: 261 } },
  // B25 snapshots at every 25th seq: 2 + 3 + 4.
  { config: { name: "B25", snapshotN: 25 }, tables: { actions: 261, snapshots: 9 } },
];

for (const { config, tables } of configs) {
  describe(`seed and storage on store ${config.name}`, { skip: url ? false : "DATABASE_URL not set" }, () => {
    const schema = `spike_${config.name.toLowerCase()}_test_${process.pid}_${Date.now()}`;
    let sql: Sql;
    let server: Server;
    let base: string;

    before(async () => {
      sql = connect(url!);
      const store = await createStore(sql, config, schema);
      server = createServer(
        createApp({
          store,
          storeName: config.name,
          clock: () => NOW,
          spikeClock: true,
          onTiming: () => {},
          storage: () => storageReport(sql, schema),
        }),
      );
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      server.close();
      await sql`drop schema if exists ${sql(schema)} cascade`;
      await sql.end();
    });

    test("seeded farms load back at their seeded seq", async () => {
      const res = await fetch(`${base}/spike/seed`, {
        method: "POST",
        body: JSON.stringify({ prefix: "p", players: 3, actions: 50 }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(((await res.json()) as { farms: unknown }).farms, [
        { farm: "p-0", seq: 50 },
        { farm: "p-1", seq: 87 },
        { farm: "p-2", seq: 124 },
      ]);
      const farm = (await (await fetch(`${base}/farms/p-2`)).json()) as { seq: number; hash: string };
      assert.equal(farm.seq, 124);
      if (config.name !== "A") {
        const audit = (await (await fetch(`${base}/farms/p-2/at/${NOW}`)).json()) as { hash: string };
        assert.equal(audit.hash, farm.hash, "B's replay of the seeded log gives the farm the read gives");
      }
    });

    test("the storage report counts this store's rows and bytes", async () => {
      const res = await fetch(`${base}/spike/storage`);
      assert.equal(res.status, 200);
      const report = (await res.json()) as {
        schema: string;
        bytes: number;
        tables: Record<string, { rows: number; bytes: number }>;
      };
      assert.equal(report.schema, schema);
      assert.deepEqual(
        Object.fromEntries(Object.entries(report.tables).map(([t, { rows }]) => [t, rows])),
        tables,
      );
      const sum = Object.values(report.tables).reduce((n, t) => n + t.bytes, 0);
      assert.ok(sum > 0);
      assert.equal(report.bytes, sum);
    });
  });
}

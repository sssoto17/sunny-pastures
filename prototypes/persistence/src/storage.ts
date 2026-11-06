// The storage report for the load runs (#10, SPIKE_CLOCK=1 only): rows and on-disk bytes per
// table in one store's schema, indexes and TOAST included (pg_total_relation_size). Read after a
// run to get bytes per player-hour (ADR-0001, decision rule step 3).

import type { Sql } from "postgres";

export type StorageReport = {
  schema: string;
  /** Sum of the tables' bytes. */
  bytes: number;
  tables: Record<string, { rows: number; bytes: number }>;
};

export async function storageReport(sql: Sql, schema: string): Promise<StorageReport> {
  const relations = await sql<{ table: string; bytes: number }[]>`
    select c.relname as table, pg_total_relation_size(c.oid) as bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind = 'r'
    order by c.relname`;
  const tables: StorageReport["tables"] = {};
  for (const { table, bytes } of relations) {
    // Exact counts: the spike's tables are small enough, and reltuples lags until ANALYZE.
    const [{ rows }] = await sql<{ rows: number }[]>`select count(*)::bigint as rows from ${sql(schema)}.${sql(table)}`;
    tables[table] = { rows: Number(rows), bytes: Number(bytes) };
  }
  const bytes = Object.values(tables).reduce((n, t) => n + t.bytes, 0);
  return { schema, bytes, tables };
}

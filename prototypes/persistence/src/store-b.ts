// Store B (ADR-0001): an append-only action log per farm, plus snapshots that bound replay.
// Patterns: Repository (SQL stays behind GameStore), Event Sourcing + Snapshot (the log is the
// truth, the snapshot a cache), Optimistic Offline Lock (the log row for expectedSeq + 1 can only
// be written once), Idempotent Receiver (the first answer is stored with its key in the log row),
// Interface Segregation (B is an AuditableStore, A isn't). The store never imports the sim's
// functions: `replay` and `newFarm` are handed in when it is created (ADR-0001, proposed).

import type { Sql } from "postgres";
import type { Action, FarmState } from "./sim.ts";
import { StoreError, type Answer, type AuditableStore, type CommitEntry, type CommitResult, type FarmRecord } from "./store.ts";

export type SnapshotN = 1 | 25 | 100;

/** Applies `actions` in seq order, each at its own time, then advances the farm to `to`. */
export type Replay = (state: FarmState, actions: { action: Action; at: number }[], to: number) => FarmState;

export type StoreBOptions = {
  schema?: string;
  snapshotN: SnapshotN;
  newFarm: (playerId: string) => FarmState;
  replay: Replay;
};

class Conflict extends Error {}

/** The same boundary check as store A: int8 columns must have arrived as safe integers. */
function checked(playerId: string, from: string, row: { seq: unknown; at: unknown }): { seq: number; at: number } {
  if (!Number.isSafeInteger(row.seq) || !Number.isSafeInteger(row.at)) {
    throw new StoreError(
      `farm ${playerId}: ${from} seq and at must be safe integers, got ${typeof row.seq} and ${typeof row.at}`,
    );
  }
  return { seq: row.seq as number, at: row.at as number };
}

export async function createStoreB(
  sql: Sql,
  { snapshotN, schema = `store_b${snapshotN}`, newFarm, replay }: StoreBOptions,
): Promise<AuditableStore> {
  const s = sql(schema);
  await sql`create schema if not exists ${s}`;
  await sql`
    create table if not exists ${s}.actions (
      farm_id         text   not null,
      seq             bigint not null check (seq > 0),
      at              bigint not null,
      action          jsonb  not null,
      idempotency_key text   not null,
      answer          jsonb  not null,
      primary key (farm_id, seq),
      unique (farm_id, idempotency_key)
    )`;
  // B1 keeps one snapshot row per farm (keyed by farm, like A's state row); B25 and B100 keep
  // every snapshot they take (keyed by farm and seq). Each variant has its own schema.
  const snapshotKey = snapshotN === 1 ? sql`primary key (farm_id)` : sql`primary key (farm_id, seq)`;
  await sql`
    create table if not exists ${s}.snapshots (
      farm_id text   not null,
      seq     bigint not null check (seq > 0),
      at      bigint not null,
      state   jsonb  not null,
      ${snapshotKey}
    )`;

  /**
   * The latest snapshot at or before `t` and the actions after it up to `t` (no `t`: all of them).
   * Actions' `at` never decreases with seq, so "up to t" is a prefix of the log. `load` uses the
   * queries without `t`, so the path that is measured has the plainest plan.
   */
  async function read(playerId: string, t?: number) {
    const [snap] = t === undefined
      ? await sql`
          select seq, at, state from ${s}.snapshots
          where farm_id = ${playerId} order by seq desc limit 1`
      : await sql`
          select seq, at, state from ${s}.snapshots
          where farm_id = ${playerId} and at <= ${t} order by seq desc limit 1`;
    const record: FarmRecord = snap
      ? { state: snap.state as FarmState, ...checked(playerId, "snapshot", snap) }
      : { state: newFarm(playerId), seq: 0, at: 0 };
    const rows = t === undefined
      ? await sql`
          select seq, at, action from ${s}.actions
          where farm_id = ${playerId} and seq > ${record.seq} order by seq`
      : await sql`
          select seq, at, action from ${s}.actions
          where farm_id = ${playerId} and seq > ${record.seq} and at <= ${t} order by seq`;
    const tail = rows.map((r) => ({ action: r.action as Action, ...checked(playerId, "action", r) }));
    return { record, tail };
  }

  return {
    /** The latest snapshot plus a replay of the newer actions; not advanced past the last one. */
    async load(playerId: string): Promise<FarmRecord> {
      const { record, tail } = await read(playerId);
      const last = tail.at(-1);
      if (!last) return record;
      return { state: replay(record.state, tail, last.at), seq: last.seq, at: last.at };
    },

    async stateAt(playerId: string, t: number): Promise<FarmState> {
      if (!Number.isSafeInteger(t)) throw new RangeError(`t must be integer ms, got ${t}`);
      const { record, tail } = await read(playerId, t);
      return replay(record.state, tail, t);
    },

    async processed(playerId: string, idempotencyKey: string): Promise<Answer | null> {
      const [row] = await sql`
        select answer from ${s}.actions
        where farm_id = ${playerId} and idempotency_key = ${idempotencyKey}`;
      return row ? (row.answer as Answer) : null;
    },
    async commit(playerId: string, entry: CommitEntry): Promise<CommitResult> {
      const seq = entry.expectedSeq + 1;
      try {
        return await sql.begin(async (tx): Promise<CommitResult> => {
          // One row claims the key and the next seq together. It is only written while the
          // farm is at expectedSeq: seq is taken if someone got there first, and the previous
          // action must exist, so the log has no gaps.
          const appended = await tx`
            insert into ${s}.actions (farm_id, seq, at, action, idempotency_key, answer)
            select ${playerId}, ${seq}, ${entry.at}, ${tx.json(entry.action)}, ${entry.idempotencyKey}, ${tx.json(entry.answer)}
            where ${entry.expectedSeq} = 0 or exists (
              select 1 from ${s}.actions where farm_id = ${playerId} and seq = ${entry.expectedSeq})
            on conflict do nothing
            returning 1`;
          if (appended.length === 0) {
            // A concurrent insert with the same key waited on the unique index, so a key
            // that is taken is visible here by now.
            const [row] = await tx`
              select answer from ${s}.actions
              where farm_id = ${playerId} and idempotency_key = ${entry.idempotencyKey}`;
            if (row) return { kind: "duplicate", answer: row.answer as Answer };
            // Nothing was written, but roll back anyway so a lost race never leaves a trace.
            throw new Conflict();
          }
          if (snapshotN === 1) {
            // B1: one snapshot per farm, overwritten. The log append above already won the
            // farm's next seq, so no other commit for this farm races this write.
            await tx`
              insert into ${s}.snapshots (farm_id, seq, at, state)
              values (${playerId}, ${seq}, ${entry.at}, ${tx.json(entry.next)})
              on conflict (farm_id) do update set seq = excluded.seq, at = excluded.at, state = excluded.state`;
          } else if (seq % snapshotN === 0) {
            await tx`
              insert into ${s}.snapshots (farm_id, seq, at, state)
              values (${playerId}, ${seq}, ${entry.at}, ${tx.json(entry.next)})`;
          }
          return { kind: "committed", seq };
        });
      } catch (e) {
        if (e instanceof Conflict) return { kind: "conflict" };
        throw e;
      }
    },
  };
}

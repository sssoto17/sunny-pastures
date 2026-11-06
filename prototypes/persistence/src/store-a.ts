// Store A (ADR-0001): one state row per farm, overwritten on every accepted action, plus a
// processed-keys table for idempotency. Patterns: Repository (SQL stays behind GameStore),
// Optimistic Offline Lock (the write only matches while the farm is at expectedSeq),
// Idempotent Receiver (the first answer is stored with its key). The store never runs the sim.

import postgres, { type Sql } from "postgres";
import type { Inbox } from "./inbox.ts";
import type { FarmState } from "./sim.ts";
import { StoreError, type Answer, type CommitEntry, type CommitResult, type FarmRecord, type GameStore } from "./store.ts";

/**
 * A client that parses int8 as a JS number. A convenience only: `load` still checks every
 * value, because a client without this option returns int8 columns as strings.
 */
export function connect(url: string): Sql {
  return postgres(url, {
    onnotice: () => {},
    types: {
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
}

export type StoreAOptions = {
  /** Postgres schema holding store A's tables. */
  schema?: string;
  /** The state of a farm that has never had an action accepted (seq 0). */
  newFarm: (playerId: string) => FarmState;
  /** The shared gift inbox; its writes join the commit's transaction. */
  inbox: Inbox;
};

class Conflict extends Error {}
class Refused extends Error {}

export async function createStoreA(sql: Sql, { schema = "store_a", newFarm, inbox }: StoreAOptions): Promise<GameStore> {
  const s = sql(schema);
  await sql`create schema if not exists ${s}`;
  await sql`
    create table if not exists ${s}.farms (
      farm_id text primary key,
      seq     bigint not null check (seq > 0),
      at      bigint not null,
      state   jsonb  not null
    )`;
  await sql`
    create table if not exists ${s}.processed_keys (
      farm_id         text   not null,
      idempotency_key text   not null,
      seq             bigint not null,
      answer          jsonb  not null,
      primary key (farm_id, idempotency_key)
    )`;

  return {
    async load(playerId: string): Promise<FarmRecord> {
      const [row] = await sql`select seq, at, state from ${s}.farms where farm_id = ${playerId}`;
      if (!row) return { state: newFarm(playerId), seq: 0, at: 0 };
      if (!Number.isSafeInteger(row.seq) || !Number.isSafeInteger(row.at)) {
        throw new StoreError(
          `farm ${playerId}: seq and at must be safe integers, got ${typeof row.seq} and ${typeof row.at}`,
        );
      }
      return { state: row.state as FarmState, seq: row.seq, at: row.at };
    },

    async processed(playerId: string, idempotencyKey: string): Promise<Answer | null> {
      const [row] = await sql`
        select answer from ${s}.processed_keys
        where farm_id = ${playerId} and idempotency_key = ${idempotencyKey}`;
      return row ? (row.answer as Answer) : null;
    },

    gift: (giftId) => inbox.gift(giftId),

    async commit(playerId: string, entry: CommitEntry): Promise<CommitResult> {
      const seq = entry.expectedSeq + 1;
      try {
        return await sql.begin(async (tx): Promise<CommitResult> => {
          // Claim the key first: a concurrent request with the same key waits here, then sees ours.
          const claimed = await tx`
            insert into ${s}.processed_keys (farm_id, idempotency_key, seq, answer)
            values (${playerId}, ${entry.idempotencyKey}, ${seq}, ${tx.json(entry.answer)})
            on conflict do nothing
            returning 1`;
          if (claimed.length === 0) {
            const [row] = await tx`
              select answer from ${s}.processed_keys
              where farm_id = ${playerId} and idempotency_key = ${entry.idempotencyKey}`;
            return { kind: "duplicate", answer: row!.answer as Answer };
          }

          const written =
            entry.expectedSeq === 0
              ? await tx`
                  insert into ${s}.farms (farm_id, seq, at, state)
                  values (${playerId}, ${seq}, ${entry.at}, ${tx.json(entry.next)})
                  on conflict do nothing
                  returning 1`
              : await tx`
                  update ${s}.farms set seq = ${seq}, at = ${entry.at}, state = ${tx.json(entry.next)}
                  where farm_id = ${playerId} and seq = ${entry.expectedSeq}
                  returning 1`;
          // Roll back the key claim too: a lost race must not use up the key.
          if (written.length === 0) throw new Conflict();
          // After the farm write, so a race for this farm is a conflict (and a retry) first.
          const refused = await inbox.forCommit(tx, playerId, seq, entry);
          if (refused) throw new Refused(refused);
          return { kind: "committed", seq };
        });
      } catch (e) {
        if (e instanceof Conflict) return { kind: "conflict" };
        if (e instanceof Refused) return { kind: "refused", reason: e.message };
        throw e;
      }
    },
  };
}

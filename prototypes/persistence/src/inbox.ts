// The gift inbox (ADR-0001, #8): one table shared by every store and outside the comparison, in its
// own schema. Sending a gift is the sender's action and inserts the gift; claiming it is the
// recipient's action and marks it claimed if it still isn't. Both run inside the commit's
// transaction (the stores pass their `tx` in), so a refusal here rolls the whole commit back: no
// seq is used, no key is claimed, and the farm keeps its goods. No action ever writes two farms.
//
// `send` and `claim` take any client or transaction and explicit times, so a script can also call
// them directly (the gate, #9), not only through a commit.

import type { Sql } from "postgres";
import type { CommitEntry } from "./store.ts";
import type { Goods } from "./sim.ts";
import { StoreError } from "./store.ts";

export type Gift = {
  /** `<senderId>:<seq>`: the sender's farm and the seq of the action that sent it. */
  id: string;
  from: string;
  to: string;
  goods: Goods;
  sentAt: number;
  /** Server time of the claim, or null while it is unclaimed. */
  claimedAt: number | null;
};

/** Why the inbox refused a write; the commit is rolled back and the handler answers 422. */
export type Refusal = string;

export interface Inbox {
  gift(id: string): Promise<Gift | null>;
  send(sql: Sql, gift: Omit<Gift, "claimedAt">): Promise<Refusal | null>;
  /** Marks the gift claimed by `by` at `at`, only if it is `by`'s, unclaimed and holds `goods`. */
  claim(sql: Sql, claim: { id: string; by: string; goods: Goods; at: number }): Promise<Refusal | null>;
  /** The inbox's part of a commit: what the committed action sends or claims, if anything. */
  forCommit(sql: Sql, playerId: string, seq: number, entry: Pick<CommitEntry, "action" | "at">): Promise<Refusal | null>;
}

export function giftId(senderId: string, seq: number): string {
  return `${senderId}:${seq}`;
}

export async function createInbox(sql: Sql, { schema = "inbox" }: { schema?: string } = {}): Promise<Inbox> {
  await sql`create schema if not exists ${sql(schema)}`;
  await sql`
    create table if not exists ${sql(schema)}.gifts (
      id         text   primary key,
      from_id    text   not null,
      to_id      text   not null check (to_id <> from_id),
      wheat      int    not null check (wheat >= 0),
      bread      int    not null check (bread >= 0),
      sent_at    bigint not null,
      claimed_at bigint
    )`;

  async function read(q: Sql, id: string): Promise<Gift | null> {
    const [row] = await q`
      select id, from_id, to_id, wheat, bread, sent_at, claimed_at from ${q(schema)}.gifts where id = ${id}`;
    if (!row) return null;
    const times = [row.sent_at, ...(row.claimed_at === null ? [] : [row.claimed_at])];
    if (!times.every(Number.isSafeInteger)) {
      throw new StoreError(`gift ${id}: times must be safe integers, got ${typeof row.sent_at} and ${typeof row.claimed_at}`);
    }
    return {
      id: row.id, from: row.from_id, to: row.to_id, goods: { wheat: row.wheat, bread: row.bread },
      sentAt: row.sent_at, claimedAt: row.claimed_at,
    };
  }

  const inbox: Inbox = {
    gift: (id) => read(sql, id),

    async send(q, gift) {
      if (gift.to === gift.from) return "a farm can't send a gift to itself";
      await q`
        insert into ${q(schema)}.gifts (id, from_id, to_id, wheat, bread, sent_at)
        values (${gift.id}, ${gift.from}, ${gift.to}, ${gift.goods.wheat}, ${gift.goods.bread}, ${gift.sentAt})`;
      return null;
    },

    async claim(q, { id, by, goods, at }) {
      const claimed = await q`
        update ${q(schema)}.gifts set claimed_at = ${at}
        where id = ${id} and to_id = ${by} and claimed_at is null
          and wheat = ${goods.wheat} and bread = ${goods.bread}
        returning 1`;
      if (claimed.length > 0) return null;
      const gift = await read(q, id);
      if (!gift) return `no gift ${id}`;
      if (gift.to !== by) return `gift ${id} is not for ${by}`;
      if (gift.claimedAt !== null) return `gift ${id} is already claimed`;
      return `the claim's goods don't match gift ${id}`;
    },

    forCommit(q, playerId, seq, { action, at }) {
      if (action.type === "sendGift") {
        return inbox.send(q, { id: giftId(playerId, seq), from: playerId, to: action.to, goods: action.goods, sentAt: at });
      }
      if (action.type === "claimGift") return inbox.claim(q, { id: action.giftId, by: playerId, goods: action.goods, at });
      return Promise.resolve(null);
    },
  };
  return inbox;
}

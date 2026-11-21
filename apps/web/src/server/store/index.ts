import "server-only";

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import type { Action, FarmState } from "@sunny-pastures/sim";

import type { Db } from "@/server/db";

import { actions, snapshots } from "./schema";

/**
 * The game store (ADR-0001, "Store interface"): B100, an append-only action log per farm plus a
 * snapshot every 100th action, over the Drizzle client (ADR-0007, section 5, Q9). It persists and
 * never runs the rules: `newFarm` and `replay` are handed in (`StoreDeps`). Patterns: Repository
 * (SQL stays behind `GameStore`), Event Sourcing with Snapshots, Optimistic Offline Lock (the log
 * row for `expectedSeq + 1` is written once, and only after its predecessor) and Idempotent
 * Receiver (the first answer is stored with its key, in the row that claims the seq).
 */
export interface GameStore {
	/**
	 * The farm after its last accepted action, not advanced past it: the newest snapshot, then a
	 * replay of the actions after it. A farm with no action is `newFarm` at seq 0. Never writes
	 * (MUST-11.5). Throws if `replay` throws (a refused or out-of-order row).
	 */
	readonly load: (playerId: string) => Promise<FarmRecord>;
	/** The answer stored with `idempotencyKey` on this farm, or `null` if no commit used the key. */
	readonly processed: (playerId: string, idempotencyKey: string) => Promise<Answer | null>;
	/**
	 * Appends the action as seq `expectedSeq + 1` in one transaction (MUST-13.7), only while the
	 * farm is still at `expectedSeq`, and writes `next` as a snapshot when that seq is a multiple of
	 * 100. A key the farm already used gives `duplicate` with its first answer and writes nothing
	 * (MUST-13.2); a farm no longer at `expectedSeq` gives `conflict` and writes nothing (MUST-13.3).
	 * `conflict` means this call wrote nothing, not that the key is unused: a commit with the same key
	 * may still be in flight, so retry with the same key, which then finds it as `duplicate`.
	 * Throws a `RangeError` when `expectedSeq` isn't a non-negative safe integer, and throws when the
	 * database refuses the row it writes, such as one with an `at` above 2^53 - 1.
	 */
	readonly commit: (playerId: string, entry: CommitEntry) => Promise<CommitResult>;
}

/** A farm as stored: the state after action `seq`, which took effect at `at` (ms), not advanced. */
export interface FarmRecord {
	readonly state: FarmState;
	readonly seq: number;
	readonly at: number;
}

/** What `POST /api/farm/actions` answers for an accepted action, stored with its key (ADR-0001). */
export interface Answer {
	readonly seq: number;
	readonly hash: string;
	readonly rebased: boolean;
	readonly retries: number;
}

export interface CommitEntry {
	/** The seq the farm was loaded at; the commit writes `expectedSeq + 1`. */
	readonly expectedSeq: number;
	readonly action: Action;
	/** The server time the action takes effect at, in ms. */
	readonly at: number;
	/** A UUID, scoped to the farm (ADR-0007, section 3). */
	readonly idempotencyKey: string;
	/** The farm after the action, written only as a snapshot (every 100th action). */
	readonly next: FarmState;
	/** Stored with the key, and returned as-is when the key comes again. */
	readonly answer: Answer;
}

export type CommitResult =
	| { readonly kind: "committed"; readonly seq: number }
	| { readonly kind: "duplicate"; readonly answer: Answer }
	| { readonly kind: "conflict" };

/**
 * What the store is built from (ADR-0001; ADR-0007, section 2): the client, and the rules'
 * `newFarm` and `replay` as plain functions, so the store imports `db` and the sim as types only.
 */
export interface StoreDeps {
	readonly db: Db;
	/** A new farm for `farmId`: the farm before its first action. */
	readonly newFarm: (farmId: string) => FarmState;
	/**
	 * Applies `actions` (the rows after `state`, in seq order) at their own `at`, then advances to
	 * `to`. Throws on a refused or out-of-order row (`@/server/rules`).
	 */
	readonly replay: (
		state: FarmState,
		actions: readonly { readonly seq: number; readonly at: number; readonly action: Action }[],
		to: number,
	) => FarmState;
}

/** A snapshot is taken at every seq that is a multiple of this (B100; ADR-0001). */
const snapshotEvery = 100;

/**
 * The rules version stamped on every row and snapshot. M3 has one (ADR-0006, section 2; ADR-0007,
 * section 5, Q5), and the store is built from `newFarm` and `replay` alone (#373), so it is a
 * constant here; M4's registry (#154) hands the store the current version instead.
 */
const rulesVersion = 1;

/**
 * Pinned, not left to the role's default: under repeatable read the loser of a race would throw a
 * serialization error instead of seeing the winner's row, so neither `conflict` nor `duplicate`
 * would hold (MUST-13.2, MUST-13.3).
 */
const readCommitted = { isolationLevel: "read committed" } as const;

export function createStore({ db, newFarm, replay }: StoreDeps): GameStore {
	return {
		async load(playerId) {
			const [snapshot] = await db
				.select({ seq: snapshots.seq, at: snapshots.at, state: snapshots.state })
				.from(snapshots)
				.where(eq(snapshots.farmId, playerId))
				// At the same seq, the higher rules version wins (ADR-0006, section 5).
				.orderBy(desc(snapshots.seq), desc(snapshots.rulesVersion))
				.limit(1);
			const from: FarmRecord =
				snapshot === undefined
					? { state: newFarm(playerId), seq: 0, at: 0 }
					: { state: readFarm(snapshot.state), seq: snapshot.seq, at: snapshot.at };

			const rows = await db
				.select({ seq: actions.seq, at: actions.at, action: actions.action })
				.from(actions)
				.where(and(eq(actions.farmId, playerId), gt(actions.seq, from.seq)))
				.orderBy(asc(actions.seq));
			const last = rows.at(-1);
			if (last === undefined) return from;

			const logged = rows.map(({ seq, at, action }) => ({ seq, at, action: readAction(action) }));
			// To the last row's time, so the farm isn't advanced past its last action (ADR-0001).
			return { state: replay(from.state, logged, last.at), seq: last.seq, at: last.at };
		},

		processed: async (playerId, idempotencyKey) => await findAnswer(db, playerId, idempotencyKey),

		async commit(playerId, entry) {
			const { expectedSeq } = entry;
			if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
				// The conditional insert is the only seq guard (ADR-0007, section 5, Q6), so a seq that
				// isn't one never reaches it: a string "5" would write seq "51".
				throw new RangeError(
					`Store error: expectedSeq must be a non-negative safe integer, got ${String(expectedSeq)}.`,
				);
			}

			const seq = expectedSeq + 1;
			return await db.transaction(async (tx): Promise<CommitResult> => {
				// One row claims the key and the next seq together, and only while the farm is at
				// expectedSeq: the seq is taken if another commit got there first, and the row before
				// it must exist, so the log has no gaps (ADR-0007, section 5, Q6). A raw template, as
				// postgres.js 4.x types the parameters server-side (Q9); the casts pin each type, since
				// `$n = 0` alone would be read as an integer and overflow past 2^31 - 1.
				const appended = await tx.execute(sql`
					insert into ${actions}
						(farm_id, seq, at, action, idempotency_key, answer, rules_version)
					select
						${playerId}::uuid, ${seq}::bigint, ${entry.at}::bigint,
						${JSON.stringify(entry.action)}::jsonb, ${entry.idempotencyKey}::uuid,
						${JSON.stringify(entry.answer)}::jsonb, ${rulesVersion}::integer
					where ${expectedSeq}::bigint = 0 or exists (
						select 1 from ${actions}
						where farm_id = ${playerId}::uuid and seq = ${expectedSeq}::bigint
					)
					on conflict do nothing
					returning 1`);
				if (appended.length === 0) {
					// Nothing was written. A key committed by now is visible to this new statement
					// under read committed; one still in flight isn't, so that call gets `conflict`.
					const answer = await findAnswer(tx, playerId, entry.idempotencyKey);
					return answer === null ? { kind: "conflict" } : { kind: "duplicate", answer };
				}

				if (seq % snapshotEvery === 0) {
					// The append above won this seq, so no other commit for this farm races this write.
					await tx
						.insert(snapshots)
						.values({ farmId: playerId, seq, at: entry.at, state: entry.next, rulesVersion })
						// A snapshot is a cache: one already at this seq and version mustn't fail the append.
						.onConflictDoNothing();
				}

				return { kind: "committed", seq };
			}, readCommitted);
		},
	};
}

/** The answer stored with the key on this farm, read on `handle`: the client, or a transaction. */
async function findAnswer(
	handle: Pick<Db, "select">,
	playerId: string,
	idempotencyKey: string,
): Promise<Answer | null> {
	const [row] = await handle
		.select({ answer: actions.answer })
		.from(actions)
		.where(and(eq(actions.farmId, playerId), eq(actions.idempotencyKey, idempotencyKey)));
	return row === undefined ? null : readAnswer(row.answer);
}

// The jsonb columns come back as parsed JSON with no runtime check (ADR-0007, section 5, Q4): the
// store wrote each from the type it is read as, and game_api may only append, so the log keeps it.
function readFarm(value: unknown): FarmState {
	return value as FarmState;
}

function readAction(value: unknown): Action {
	return value as Action;
}

function readAnswer(value: unknown): Answer {
	return value as Answer;
}

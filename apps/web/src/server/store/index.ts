import "server-only";

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import type { Action, FarmState } from "@sunny-pastures/sim";

import type { Answer } from "@/contract";
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
	 * The farm after its last accepted action, not advanced past it, under the current rules
	 * version: the newest snapshot (the higher version at one seq), then `replay` of the rows after
	 * it, each with its own rules version (ADR-0006, section 5). A farm with no snapshot and no row
	 * is `newFarm` at seq 0. Never writes (MUST-11.5). Throws a store error if the first row after
	 * the snapshot isn't at the snapshot's seq + 1 (seq 1 with no snapshot), and throws if `replay`
	 * throws (a refused or out-of-order row, or a rules version this code doesn't know: a 503).
	 */
	readonly load: (playerId: string) => Promise<FarmRecord>;
	/** The answer stored with `idempotencyKey` on this farm, or `null` if no commit used the key. */
	readonly processed: (playerId: string, idempotencyKey: string) => Promise<Answer | null>;
	/**
	 * Appends the action as seq `expectedSeq + 1` in one transaction (MUST-13.7), only while the
	 * farm is still at `expectedSeq`, and writes `next` as a snapshot when that seq is a multiple of
	 * 100. The row is stamped with the store's rules version. When it is the farm's first action
	 * under that version, the same transaction writes the base snapshot: the farm at `expectedSeq`
	 * after its version upgrade, as `load` gives it (ADR-0006, section 3). Throws a store error, and
	 * writes nothing, when the farm's latest row has a higher version: versions only go forward
	 * (section 8). A key the farm already used gives `duplicate` with its first answer and writes
	 * nothing (MUST-13.2); a farm no longer at `expectedSeq` gives `conflict` and writes nothing
	 * (MUST-13.3). `conflict` means this call wrote nothing, not that the key is unused: a commit
	 * with the same key may still be in flight, so retry with the same key, which then finds it as
	 * `duplicate`.
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

/** A snapshot as the store hands it to `replay`: the farm after `seq`, under `rulesVersion`. */
interface StoredSnapshot {
	readonly seq: number;
	readonly state: FarmState;
	readonly rulesVersion: number;
}

/** A log row as the store hands it to `replay`: the action accepted as `seq`, at `at` (ms). */
interface StoredRow {
	readonly seq: number;
	readonly at: number;
	readonly action: Action;
	readonly rulesVersion: number;
}

/**
 * What the store is built from (ADR-0001; ADR-0007, section 2): the client, and the rules'
 * `newFarm`, `replay` and `rulesVersion` as plain values, so the store imports `db` and the sim as
 * types only.
 */
export interface StoreDeps {
	readonly db: Db;
	/**
	 * The rules version stamped on every row and snapshot this store writes: the rules' own
	 * (`Rules.rulesVersion`), so a rules bump can't leave rows stamped with a stale one (#443).
	 */
	readonly rulesVersion: number;
	/** A new farm for `farmId` under the current version: the farm before its first action. */
	readonly newFarm: (farmId: string) => FarmState;
	/**
	 * The farm from `snapshot` (or a new one) after `rows` (the rows after it, in seq order), each
	 * under its own version, given a version upgrade to the current version and not advanced past
	 * the last row. Throws on a refused or out-of-order row and on an unknown or decreasing version
	 * (`@/server/rules`).
	 */
	readonly replay: (
		farmId: string,
		snapshot: StoredSnapshot | null,
		rows: readonly StoredRow[],
	) => FarmState;
}

/** A snapshot is taken at every seq that is a multiple of this (B100; ADR-0001). */
const snapshotEvery = 100;

/**
 * Pinned, not left to the role's default: under repeatable read the loser of a race would throw a
 * serialization error instead of seeing the winner's row, so neither `conflict` nor `duplicate`
 * would hold (MUST-13.2, MUST-13.3).
 */
const readCommitted = { isolationLevel: "read committed" } as const;

export function createStore(deps: StoreDeps): GameStore {
	const { db, rulesVersion } = deps;
	return {
		load: async (playerId) => await readFarm(db, deps, playerId),

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
				// The row at expectedSeq is the farm's latest while the farm is at expectedSeq, and a log
				// row never changes, so this read can't go stale before the insert below decides.
				const latest = expectedSeq === 0 ? null : await findVersion(tx, playerId, expectedSeq);
				checkForward(latest, rulesVersion);
				// The farm's first action under this version: its base snapshot is the farm `load` gives
				// at expectedSeq, read before the row below is in the log (ADR-0006, section 3).
				const base =
					latest !== null && latest < rulesVersion ? await readFarm(tx, deps, playerId) : null;
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

				// The append above won this seq, so no other commit for this farm races these writes,
				// and `base` was read with the farm at expectedSeq: a later row would have failed it.
				const written = [
					...(base === null ? [] : [{ seq: expectedSeq, at: base.at, state: base.state }]),
					...(seq % snapshotEvery === 0 ? [{ seq, at: entry.at, state: entry.next }] : []),
				];
				if (written.length > 0) {
					await tx
						.insert(snapshots)
						.values(written.map((snapshot) => ({ farmId: playerId, rulesVersion, ...snapshot })))
						// A snapshot is a cache: one already at this seq and version mustn't fail the append.
						.onConflictDoNothing();
				}

				return { kind: "committed", seq };
			}, readCommitted);
		},
	};
}

/**
 * `load`, read on `handle`: the client, or a commit's transaction, which reads the farm it is
 * about to write a base snapshot of.
 */
async function readFarm(
	handle: Pick<Db, "select">,
	{ newFarm, replay }: StoreDeps,
	playerId: string,
): Promise<FarmRecord> {
	const [snapshot] = await handle
		.select({
			seq: snapshots.seq,
			at: snapshots.at,
			state: snapshots.state,
			rulesVersion: snapshots.rulesVersion,
		})
		.from(snapshots)
		.where(eq(snapshots.farmId, playerId))
		// At the same seq, the higher rules version wins (ADR-0006, section 5).
		.orderBy(desc(snapshots.seq), desc(snapshots.rulesVersion))
		.limit(1);
	const fromSeq = snapshot?.seq ?? 0;
	const rows = await handle
		.select({
			seq: actions.seq,
			at: actions.at,
			action: actions.action,
			rulesVersion: actions.rulesVersion,
		})
		.from(actions)
		.where(and(eq(actions.farmId, playerId), gt(actions.seq, fromSeq)))
		.orderBy(asc(actions.seq));
	const [first] = rows;
	const last = rows.at(-1);
	if (snapshot === undefined && last === undefined) {
		return { state: newFarm(playerId), seq: 0, at: 0 };
	}

	if (first !== undefined && first.seq !== fromSeq + 1) {
		// `replay` checks the seqs too; the store keeps its own check of this boundary, so a lost
		// row here is a store error whatever `replay` it was handed (#443).
		throw new Error(
			`Store error: the first log row after seq ${String(fromSeq)} is seq ${String(first.seq)}, not seq ${String(fromSeq + 1)}.`,
		);
	}

	const from =
		snapshot === undefined
			? null
			: {
					seq: snapshot.seq,
					state: readState(snapshot.state),
					rulesVersion: snapshot.rulesVersion,
				};
	const logged = rows.map((row) => ({ ...row, action: readAction(row.action) }));
	// Called even with no row after the snapshot: an older version's snapshot still gets its version
	// upgrade (ADR-0006, section 5, step 4).
	const state = replay(playerId, from, logged);
	return last === undefined
		? { state, seq: fromSeq, at: snapshot?.at ?? 0 }
		: { state, seq: last.seq, at: last.at };
}

/** The rules version of the farm's row at `seq`, or `null` when there is none. */
async function findVersion(
	handle: Pick<Db, "select">,
	playerId: string,
	seq: number,
): Promise<number | null> {
	const [row] = await handle
		.select({ rulesVersion: actions.rulesVersion })
		.from(actions)
		.where(and(eq(actions.farmId, playerId), eq(actions.seq, seq)));
	return row?.rulesVersion ?? null;
}

/**
 * Throws the store error for a farm whose latest row is under a higher version than this store's:
 * an instance older than the farm writes nothing and answers 503 (ADR-0006, section 8).
 */
export function checkForward(latest: number | null, rulesVersion: number): void {
	if (latest !== null && latest > rulesVersion) {
		throw new Error(
			`Store error: the farm's latest action is under rules version ${String(latest)}, above this store's ${String(rulesVersion)}.`,
		);
	}
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
function readState(value: unknown): FarmState {
	return value as FarmState;
}

function readAction(value: unknown): Action {
	return value as Action;
}

function readAnswer(value: unknown): Answer {
	return value as Answer;
}

import type { Action, FarmState } from "@sunny-pastures/sim";

import type { Answer, CommitResult, FarmRecord, GameStore, StoreDeps } from "../index";

/**
 * What the in-memory store is built from: the rules' `newFarm` and `replay`, as B100 takes them,
 * and an optional script of injected conflicts.
 */
export interface MemoryStoreDeps extends Omit<StoreDeps, "db"> {
	/**
	 * Entry i scripts the i-th commit that would write, counted across the store's farms: `true`
	 * makes it a `conflict` that writes nothing, as if another commit had just taken the seq
	 * (`[true, true]`: conflict twice, then commit). A duplicate key or a refused `expectedSeq`
	 * doesn't use up an entry, and commits past the end of the script aren't touched.
	 */
	readonly conflicts?: readonly boolean[];
}

/**
 * A `GameStore` in memory (ADR-0007 section 6, "Action-handler tests"): a Fake object held to the
 * same contract as B100 (`./contract.ts`), so `game/`'s retry loop, `busy`, `rebased`, a resend
 * and the 422 mapping are tested with no database. It keeps B100's shape: a log per farm, a
 * snapshot at every 100th seq, `load` replaying the rows after the newest snapshot. Each value is
 * stored and handed back as a JSON copy, as jsonb columns would, so a caller's later change to its
 * own object doesn't reach the store. Past its first `await`, each method runs to the end without
 * yielding, so of two concurrent commits one sees the other's row, as with B100's transactions.
 */
export function createMemoryStore({ newFarm, replay, conflicts = [] }: MemoryStoreDeps): GameStore {
	const farms = new Map<string, MemoryFarm>();
	let scripted = 0;

	function findOrAddFarm(playerId: string): MemoryFarm {
		const found = farms.get(playerId);
		if (found !== undefined) return found;

		const farm: MemoryFarm = { rows: [], snapshots: new Map() };
		farms.set(playerId, farm);
		return farm;
	}

	return {
		async load(playerId) {
			await Promise.resolve();
			checkUuid(playerId, "playerId");
			const { rows, snapshots } = findOrAddFarm(playerId);
			const snapshotSeq = Math.floor(rows.length / snapshotEvery) * snapshotEvery;
			const snapshot = snapshots.get(snapshotSeq);
			const from: FarmRecord =
				snapshot === undefined
					? { state: newFarm(playerId), seq: 0, at: 0 }
					: { state: copy(snapshot.state), seq: snapshotSeq, at: snapshot.at };

			const after = rows.slice(from.seq);
			const last = after.at(-1);
			if (last === undefined) return from;

			const logged = after.map(({ seq, at, action }) => ({ seq, at, action: copy(action) }));
			return { state: replay(from.state, logged, last.at), seq: last.seq, at: last.at };
		},

		async processed(playerId, idempotencyKey) {
			await Promise.resolve();
			checkUuid(playerId, "playerId");
			checkUuid(idempotencyKey, "idempotencyKey");
			return findAnswer(findOrAddFarm(playerId), idempotencyKey);
		},

		async commit(playerId, entry): Promise<CommitResult> {
			await Promise.resolve();
			const { expectedSeq } = entry;
			if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
				// B100's own guard (ADR-0007, section 5, Q6), so the fake refuses what the store refuses.
				throw new RangeError(
					`Store error: expectedSeq must be a non-negative safe integer, got ${String(expectedSeq)}.`,
				);
			}

			checkUuid(playerId, "playerId");
			checkUuid(entry.idempotencyKey, "idempotencyKey");
			const farm = findOrAddFarm(playerId);
			const answer = findAnswer(farm, entry.idempotencyKey);
			if (answer !== null) return { kind: "duplicate", answer };

			if (farm.rows.length !== expectedSeq) return { kind: "conflict" };

			const isScriptedConflict = conflicts[scripted] ?? false;
			scripted++;
			if (isScriptedConflict) return { kind: "conflict" };

			const seq = expectedSeq + 1;
			farm.rows.push({
				seq,
				at: entry.at,
				action: copy(entry.action),
				idempotencyKey: entry.idempotencyKey,
				answer: copy(entry.answer),
			});
			if (seq % snapshotEvery === 0) {
				farm.snapshots.set(seq, { at: entry.at, state: copy(entry.next) });
			}

			return { kind: "committed", seq };
		},
	};
}

/** One farm's rows: `rows[i]` is seq `i + 1`, and the snapshots are keyed by seq. */
interface MemoryFarm {
	readonly rows: MemoryRow[];
	readonly snapshots: Map<number, { readonly at: number; readonly state: FarmState }>;
}

interface MemoryRow {
	readonly seq: number;
	readonly at: number;
	readonly action: Action;
	readonly idempotencyKey: string;
	readonly answer: Answer;
}

/** B100's snapshot interval (ADR-0001), which the contract's seq-100 case pins. */
const snapshotEvery = 100;

/**
 * B100's uuid columns refuse anything else (Postgres's 22P02), so the fake does too, and a test
 * that passes on the fake with a made-up id can't fail on B100 (#383's review). The canonical
 * hyphenated form only: Postgres takes a few more spellings, which no caller sends.
 */
function checkUuid(value: string, name: string): void {
	if (!uuidPattern.test(value)) {
		throw new TypeError(`Store error: ${name} must be a UUID, got ${JSON.stringify(value)}.`);
	}
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function findAnswer(farm: MemoryFarm, idempotencyKey: string): Answer | null {
	const row = farm.rows.find((candidate) => candidate.idempotencyKey === idempotencyKey);
	return row === undefined ? null : copy(row.answer);
}

/** A JSON round trip, as a value takes through a jsonb column. */
function copy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

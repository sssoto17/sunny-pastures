import type { Action, FarmState } from "@sunny-pastures/sim";

import type { Answer } from "@/contract";

import { checkForward } from "../index";
import type { CommitResult, FarmRecord, GameStore, StoreDeps } from "../index";

/**
 * What the in-memory store is built from: the rules' `newFarm`, `replay` and `rulesVersion`, as
 * B100 takes them, the farms it keeps, and an optional script of injected conflicts.
 */
export interface MemoryStoreDeps extends Omit<StoreDeps, "db" | "rulesVersion"> {
	/** Stamped on every row and snapshot it writes; 1, the game's one version, by default. */
	readonly rulesVersion?: number;
	/**
	 * The farms it reads and writes; a new set by default. Hand two stores the same `MemoryFarms`
	 * to share them, as two deploys at different rules versions share B100's tables (ADR-0006).
	 */
	readonly farms?: MemoryFarms;
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
export function createMemoryStore({
	newFarm,
	replay,
	rulesVersion = 1,
	farms = createMemoryFarms(),
	conflicts = [],
}: MemoryStoreDeps): GameStore {
	let scripted = 0;

	function findOrAddFarm(playerId: string): MemoryFarm {
		const found = farms.get(playerId);
		if (found !== undefined) return found;

		const farm: MemoryFarm = { rows: [], snapshots: [] };
		farms.set(playerId, farm);
		return farm;
	}

	/** B100's `load`: the newest snapshot, the higher version at one seq, then the rows after it. */
	function readFarm(playerId: string): FarmRecord {
		const { rows, snapshots } = findOrAddFarm(playerId);
		const snapshot = findNewest(snapshots);
		if (snapshot === null && rows.length === 0) return { state: newFarm(playerId), seq: 0, at: 0 };

		const from = snapshot ?? { seq: 0, at: 0 };
		const after = rows.slice(from.seq).map((row) => ({
			seq: row.seq,
			at: row.at,
			action: copy(row.action),
			rulesVersion: row.rulesVersion,
		}));
		const versioned =
			snapshot === null
				? null
				: { seq: snapshot.seq, state: copy(snapshot.state), rulesVersion: snapshot.rulesVersion };
		const state = replay(playerId, versioned, after);
		// Unadvanced: at the last row, or at the snapshot when no row follows it.
		const { seq, at } = after.at(-1) ?? from;
		return { state, seq, at };
	}

	return {
		async load(playerId) {
			await Promise.resolve();
			checkUuid(playerId, "playerId");
			return readFarm(playerId);
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
			// The row at expectedSeq: B100 checks its version first, in its transaction (ADR-0006, s. 8).
			const latest = expectedSeq === 0 ? null : (farm.rows[expectedSeq - 1]?.rulesVersion ?? null);
			checkForward(latest, rulesVersion);
			const answer = findAnswer(farm, entry.idempotencyKey);
			if (answer !== null) return { kind: "duplicate", answer };

			if (farm.rows.length !== expectedSeq) return { kind: "conflict" };

			const isScriptedConflict = conflicts[scripted] ?? false;
			scripted++;
			if (isScriptedConflict) return { kind: "conflict" };

			// The farm's first action under this version writes its base snapshot (ADR-0006, s. 3).
			const base = latest !== null && latest < rulesVersion ? readFarm(playerId) : null;
			if (base !== null) {
				farm.snapshots.push({ seq: base.seq, at: base.at, state: copy(base.state), rulesVersion });
			}

			const seq = expectedSeq + 1;
			farm.rows.push({
				seq,
				at: entry.at,
				action: copy(entry.action),
				idempotencyKey: entry.idempotencyKey,
				answer: copy(entry.answer),
				rulesVersion,
			});
			if (seq % snapshotEvery === 0) {
				farm.snapshots.push({ seq, at: entry.at, state: copy(entry.next), rulesVersion });
			}

			return { kind: "committed", seq };
		},
	};
}

/** The farms an in-memory store keeps, by farm id. */
export type MemoryFarms = Map<string, MemoryFarm>;

/** An empty set of farms, for stores that share them. */
export function createMemoryFarms(): MemoryFarms {
	return new Map();
}

/** One farm's rows (`rows[i]` is seq `i + 1`) and snapshots, each under its rules version. */
interface MemoryFarm {
	readonly rows: MemoryRow[];
	readonly snapshots: MemorySnapshot[];
}

interface MemorySnapshot {
	readonly seq: number;
	readonly at: number;
	readonly state: FarmState;
	readonly rulesVersion: number;
}

interface MemoryRow {
	readonly seq: number;
	readonly at: number;
	readonly action: Action;
	readonly idempotencyKey: string;
	readonly answer: Answer;
	readonly rulesVersion: number;
}

/** The newest snapshot: the highest seq, and at one seq the higher version (ADR-0006, s. 5). */
function findNewest(snapshots: readonly MemorySnapshot[]): MemorySnapshot | null {
	return snapshots.reduce<MemorySnapshot | null>(
		(newest, snapshot) =>
			newest === null ||
			snapshot.seq > newest.seq ||
			(snapshot.seq === newest.seq && snapshot.rulesVersion > newest.rulesVersion)
				? snapshot
				: newest,
		null,
	);
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

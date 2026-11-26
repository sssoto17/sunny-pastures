import type { Action, FarmState } from "@sunny-pastures/sim";

import type { CommitEntry, StoreDeps } from "../index";

// Stand-ins for the rules' `newFarm` and `replay` (#373): the store zone's tests may import the sim
// only as types (.fallowrc.jsonc, `storeTests`), and the store never looks inside a farm, so a farm
// that counts its actions shows what the store loaded and replayed. The real rules meet the store
// in the store gate (ADR-0007 section 6).

/** A farm that has had no action: every field empty. The same for every id, as no test needs more. */
export function newFarm(): FarmState {
	return {
		time: 0,
		coins: 0,
		xp: 0,
		silo: {},
		barn: {},
		plots: [],
		facilities: [],
		pens: [],
		board: [],
		streams: { yields: 0, orders: 0 },
	};
}

/** The stand-in's `apply`: each action adds 1 xp and moves the farm to its time. Never refuses. */
function applyAction(farm: FarmState, at: number): FarmState {
	return { ...farm, time: at, xp: farm.xp + 1 };
}

/**
 * The stand-in's `replay`: `applyAction` over the rows from the snapshot, or from `newFarm` when
 * there is none. It reads no version, and stays at the last row's time, as the rules' does.
 */
export const replay: StoreDeps["replay"] = (_farmId, snapshot, rows) =>
	rows.reduce((farm, { at }) => applyAction(farm, at), snapshot?.state ?? newFarm());

/** A seq and the rules version it is stored under, as a `replay` call was handed it. */
interface Versioned {
	readonly seq: number;
	readonly rulesVersion: number;
}

/** What one `replay` call was handed: the snapshot's and each row's seq and rules version. */
interface ReplayCall {
	readonly snapshot: Versioned | null;
	readonly rows: readonly Versioned[];
}

/** A `replay` (the stand-in, or `inner`) that records what each call was handed, in order. */
export function recordReplay(inner: StoreDeps["replay"] = replay): {
	replay: StoreDeps["replay"];
	calls: ReplayCall[];
} {
	const calls: ReplayCall[] = [];
	return {
		calls,
		replay: (farmId, snapshot, rows) => {
			calls.push({
				snapshot: snapshot === null ? null : pickVersioned(snapshot),
				rows: rows.map(pickVersioned),
			});
			return inner(farmId, snapshot, rows);
		},
	};
}

/** The rows `from` to `to`, both included, each under `rulesVersion`, as a `ReplayCall` lists. */
export function rowsFrom(from: number, to: number, rulesVersion: number): Versioned[] {
	return Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, rulesVersion }));
}

function pickVersioned({ seq, rulesVersion }: Versioned): Versioned {
	return { seq, rulesVersion };
}

export const plant = (plot: number): Action => ({ type: "plant", plot, crop: "wheat" });

/**
 * The entry the game loop would commit for one action at `at` on a farm at `expectedSeq`, its
 * answer naming the seq it claims. `idempotencyKey` is a new UUID unless given.
 */
export function makeEntry(
	farm: FarmState,
	expectedSeq: number,
	at: number,
	idempotencyKey: string = crypto.randomUUID(),
): CommitEntry {
	const seq = expectedSeq + 1;
	return {
		expectedSeq,
		action: plant(seq % 3),
		at,
		idempotencyKey,
		next: applyAction(farm, at),
		answer: { seq, hash: `hash-${String(seq)}`, rebased: false, retries: 0 },
	};
}

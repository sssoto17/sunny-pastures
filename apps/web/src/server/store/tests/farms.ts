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
export function applyAction(farm: FarmState, at: number): FarmState {
	return { ...farm, time: at, xp: farm.xp + 1 };
}

/** The stand-in's `replay`: `applyAction` over the rows, then on to `to` if that's later. */
export const replay: StoreDeps["replay"] = (state, actions, to) => {
	const farm = actions.reduce((current, { at }) => applyAction(current, at), state);
	return { ...farm, time: Math.max(farm.time, to) };
};

/** A `replay` that records the seqs of the rows each call was handed, in order. */
export function recordReplay(): { replay: StoreDeps["replay"]; calls: number[][] } {
	const calls: number[][] = [];
	return {
		calls,
		replay: (state, actions, to) => {
			calls.push(actions.map(({ seq }) => seq));
			return replay(state, actions, to);
		},
	};
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

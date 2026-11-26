import { createStore, type StoreApi } from "zustand/vanilla";

import {
	createSim,
	sliceContent,
	type Action,
	type FarmState,
	type OrderSlot,
	type OwnedFacility,
	type OwnedPen,
	type Plot,
} from "@sunny-pastures/sim";

import type { FarmEnvelope } from "@/contract";

import type { Api, LoadResult } from "../api";
import { withoutAction, type PendingAction } from "./pending";
import { predict } from "./predict";
import { sendPending } from "./sync";

// The client farm store (ADR-0010, section 4): an observable store with selectors (Zustand), so a
// screen subscribes to the slice it shows and the clock tick doesn't redraw the whole farm. It
// holds the last confirmed farm and the pending actions, and derives the predicted farm with the
// shared sim (MUST-12). Rejected there: `useReducer` + context, and our own store.

export interface FarmStore {
	/** The farm the server last answered with; null until it loads. */
	readonly confirmed: FarmEnvelope | null;
	/** In the order the player acted; the first is the one in flight. */
	readonly pending: readonly PendingAction[];
	/**
	 * `confirmed.state` with each pending action applied in order at its time, advanced to `now`;
	 * null until the farm loads.
	 */
	readonly predicted: FarmState | null;
	/** The farm's clock, in ms: never before `confirmed.at` and never backwards (MUST-11.3). */
	readonly now: number;
	readonly status: "loading" | "ready" | "error";
	/** Why `status` is `"error"`, as a sentence a player reads; null otherwise. */
	readonly error: string | null;
	/** Why the last action was refused or undone, as a sentence a player reads; null otherwise. */
	readonly lastRefusal: string | null;
	/** Loads the farm and starts the 1-second clock tick. */
	load(): Promise<void>;
	/**
	 * Applies `action` to the prediction at once, as a plain state update and never inside a
	 * transition (BASE-05), then sends it. A refusal is set as `lastRefusal`, never thrown.
	 */
	act(action: Action): void;
	/** Stops the clock tick, when the game unmounts. */
	stop(): void;
}

/** The rest of the client the store reaches: the game API (ADR-0010, section 5). */
export interface FarmStoreDeps {
	readonly api: Api;
}

/**
 * The client's rules version (ADR-0006, "The client"): the registry's current version, whose
 * content is `sliceContent`. An envelope under another version means the server's rules changed,
 * so the client reloads instead of predicting under the wrong rules (MUST-12).
 */
const rulesVersion = 1;
const reloadMessage = "The game has been updated. Please reload to update.";
const loadFailedMessage = "Your farm could not be loaded.";
const tickMs = 1000;

export function createFarmStore(deps: FarmStoreDeps): StoreApi<FarmStore> {
	const sim = createSim(sliceContent);
	let tick: ReturnType<typeof setInterval> | null = null;
	let isSending = false;

	return createStore<FarmStore>()((set, get) => {
		/** `max(Date.now(), confirmed.at)`, and never below the last `now` (MUST-11.3). */
		const readNow = () => Math.max(Date.now(), get().confirmed?.at ?? 0, get().now);

		const stop = () => {
			if (tick !== null) clearInterval(tick);
			tick = null;
		};

		/** Takes the server's farm, or reports a rules version this client doesn't run. */
		const confirm = (farm: FarmEnvelope, pending: readonly PendingAction[]): boolean => {
			if (farm.rulesVersion !== rulesVersion) {
				stop();
				set({ status: "error", error: reloadMessage });
				return false;
			}

			// `readNow` reads the farm confirmed so far, so the incoming farm's `at` counts here too.
			const now = Math.max(readNow(), farm.at);
			set({ confirmed: farm, pending, now, predicted: predict(sim, farm, pending, now) });
			return true;
		};

		/** Drops the pending action with `key`, so the prediction rolls back, and shows why. */
		const undo = (key: string, reason: string) => {
			const { confirmed, now } = get();
			const pending = withoutAction(get().pending, key);
			const predicted = confirmed === null ? null : predict(sim, confirmed, pending, now);
			set({ pending, predicted, lastRefusal: reason });
		};

		const drain = async () => {
			if (isSending) return;

			isSending = true;
			try {
				await sendPending({ api: deps.api, get, confirm, undo });
			} finally {
				isSending = false;
			}
		};

		return {
			confirmed: null,
			pending: [],
			predicted: null,
			now: 0,
			status: "loading",
			error: null,
			lastRefusal: null,
			load: async () => {
				stop();
				// Anything thrown on the way, a sign-in that throws included, ends the load as an error
				// the player can retry, never as a rejection nobody handles (#684).
				let result: LoadResult;
				try {
					result = await deps.api.loadFarm();
				} catch (thrown) {
					set({ status: "error", error: readThrownMessage(thrown) });
					return;
				}

				if (!result.ok) {
					set({ status: "error", error: result.message });
					return;
				}

				if (!confirm(result.farm, get().pending)) return;

				set({ status: "ready", error: null });
				// A second load, or a stop while this one was in flight, leaves one tick, never two.
				stop();
				tick = setInterval(() => {
					const { confirmed, pending } = get();
					const now = readNow();
					if (confirmed !== null) set({ now, predicted: predict(sim, confirmed, pending, now) });
				}, tickMs);
			},
			act: (action) => {
				const { predicted, status, error } = get();
				if (predicted === null || status !== "ready") {
					set({ lastRefusal: error ?? "The farm is still loading." });
					return;
				}

				const at = readNow();
				const result = sim.apply(predicted, action, at);
				if (!result.ok) {
					set({ lastRefusal: result.reason });
					return;
				}

				const entry = { action, idempotencyKey: crypto.randomUUID(), at };
				set({
					pending: [...get().pending, entry],
					predicted: result.state,
					now: at,
					lastRefusal: null,
				});
				void drain();
			},
			stop,
		};
	});
}

// SELECTORS: what the screens read, from the predicted farm. Each returns a value already in the
// state, or one memoized per farm, so a subscriber re-renders only when its slice changes.

export const selectCoins = (store: FarmStore): number | null => store.predicted?.coins ?? null;

/** The Level from 1, derived from XP through the Level table (MUST-05.3). */
export const selectLevel = (store: FarmStore): number | null =>
	store.predicted === null ? null : countLevels(store.predicted.xp);

export interface LevelProgress {
	/** From 1 (MUST-05.3). */
	readonly level: number;
	readonly xp: number;
	/** The XP that reached this Level. */
	readonly levelXp: number;
	/** The XP that reaches the next Level; null at the top Level. */
	readonly nextLevelXp: number | null;
}

let lastProgress: LevelProgress | null = null;

/**
 * The Level with the XP toward the next one, from the Level table (MUST-05.3). The same object
 * while XP stays the same, so the clock tick doesn't redraw what shows it.
 */
export const selectLevelProgress = (store: FarmStore): LevelProgress | null => {
	if (store.predicted === null) return null;

	const { xp } = store.predicted;
	if (lastProgress?.xp === xp) return lastProgress;

	const level = countLevels(xp);
	lastProgress = {
		level,
		xp,
		levelXp: sliceContent.levels[level - 1]?.xp ?? 0,
		nextLevelXp: sliceContent.levels[level]?.xp ?? null,
	};
	return lastProgress;
};

export interface FarmStorage {
	readonly silo: StoredGoods;
	readonly barn: StoredGoods;
}

interface StoredGoods {
	/** Goods by good id; a good has a key only while it has some. */
	readonly goods: Readonly<Record<string, number>>;
	/** The goods held, in all: what counts against `capacity` (MUST-06.4). */
	readonly used: number;
	readonly capacity: number;
}

const storageByFarm = new WeakMap<FarmState, FarmStorage>();

export const selectStorage = (store: FarmStore): FarmStorage | null => {
	const farm = store.predicted;
	if (farm === null) return null;

	const cached = storageByFarm.get(farm);
	if (cached !== undefined) return cached;

	const storage = {
		silo: { goods: farm.silo, used: countGoods(farm.silo), capacity: sliceContent.silo.capacity },
		barn: { goods: farm.barn, used: countGoods(farm.barn), capacity: sliceContent.barn.capacity },
	};
	storageByFarm.set(farm, storage);
	return storage;
};

/** Plot `index`, in content order; null before the farm loads or past the last plot. */
export const selectPlot =
	(index: number) =>
	(store: FarmStore): Plot | null =>
		store.predicted?.plots[index] ?? null;

/** Facility `index`, in content order; null before the farm loads or until it is bought. */
export const selectFacility =
	(index: number) =>
	(store: FarmStore): OwnedFacility | null =>
		store.predicted?.facilities[index] ?? null;

/** Pen `index`, in content order; null before the farm loads or until it is bought. */
export const selectPen =
	(index: number) =>
	(store: FarmStore): OwnedPen | null =>
		store.predicted?.pens[index] ?? null;

const noOrders: readonly OrderSlot[] = [];

/** The order board's slots; empty before the farm loads. */
export const selectOrders = (store: FarmStore): readonly OrderSlot[] =>
	store.predicted?.board ?? noOrders;

/** The thrown error's message, written as a sentence by whoever threw it; ours when it has none. */
function readThrownMessage(thrown: unknown): string {
	return thrown instanceof Error && thrown.message !== "" ? thrown.message : loadFailedMessage;
}

/**
 * The Level for `xp`: the Levels whose XP it has reached (MUST-05.3). The sim's `levelOf` holds
 * the same rule but isn't in the package's interface, so the client counts it from the content.
 */
function countLevels(xp: number): number {
	return sliceContent.levels.filter((level) => level.xp <= xp).length;
}

function countGoods(goods: Readonly<Record<string, number>>): number {
	return Object.values(goods).reduce((sum, count) => sum + count, 0);
}

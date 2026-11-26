import { describe, expect, it } from "vitest";

import { stateHash, type Action } from "@sunny-pastures/sim";
import { registry } from "@sunny-pastures/sim/versions";

import type { Answer, FarmEnvelope } from "@/contract";
import type { PlayerId } from "@/server/auth";
import { createRules } from "@/server/rules";
import type { GameStore } from "@/server/store";
import { createMemoryStore } from "@/server/store/tests/memoryStore";
import { createTiming } from "@/server/timing";
import type { Timing } from "@/server/timing";

import {
	loadFarm,
	submitAction,
	type GameDeps,
	type LoadResult,
	type SubmitRequest,
	type SubmitResult,
} from "../index";

const rules = createRules(registry);

describe("loadFarm", () => {
	it("gives a player with no action a new farm at seq 0", async () => {
		const playerId = newPlayerId();

		expect(await loadFarm(makeDeps(), playerId)).toEqual({
			kind: "loaded",
			farm: { seq: 0, at: 0, state: rules.newFarm(playerId), rulesVersion: 1 },
		});
	});

	it("returns the farm as committed, not advanced past its last action, and never writes (MUST-11.5)", async () => {
		const playerId = newPlayerId();
		const store = newStore();
		const submitted = await submitAction(
			makeDeps({ store }),
			playerId,
			buildRequest(plantWheat(0), 0),
		);
		const commits: unknown[] = [];
		const readOnly: GameStore = {
			...store,
			commit: (...args) => {
				commits.push(args);
				return store.commit(...args);
			},
		};
		let ticks = 0;
		const timing = createTiming(() => ticks++);

		const loaded = await loadFarm(
			makeDeps({ store: readOnly, serverTime: () => 3_600_000, timing }),
			playerId,
		);

		expect(loaded).toStrictEqual({
			kind: "loaded",
			farm: farmOf(submitted),
		});
		expect(loaded).toMatchObject({ farm: { seq: 1, at: 1_000, state: { time: 1_000 } } });
		expect(commits).toEqual([]);
		expect(timing.renderServerTiming()).toBe("load;dur=1");
	});

	it("answers busy when the store throws, as on an unknown rules version (ADR-0006, section 8)", async () => {
		const error = storeError();
		const store = { ...newStore(), load: () => Promise.reject(error) };

		expect(await loadFarm(makeDeps({ store }), newPlayerId())).toEqual({
			kind: "busy",
			cause: "store",
			error,
		});
	});
});

describe("submitAction", () => {
	it("commits a first action at server time and answers with the farm after it", async () => {
		const playerId = newPlayerId();
		const store = newStore();
		const deps = makeDeps({ store, serverTime: () => 1_000 });

		const result = await submitAction(deps, playerId, buildRequest(plantWheat(0), 0));

		const stored = await store.load(playerId);
		expect(stored).toMatchObject({ seq: 1, at: 1_000 });
		expect(stored.state.plots[0]).toEqual({ status: "growing", crop: "wheat", readyAt: 121_000 });
		expect(result).toStrictEqual({
			kind: "answered",
			answer: { seq: 1, hash: stateHash(stored.state), rebased: false, retries: 0 },
			farm: { seq: 1, at: 1_000, state: stored.state, rulesVersion: 1 },
		});
	});

	it("resends a used key's first answer unchanged, even when the action would now be refused (MUST-13.2)", async () => {
		const playerId = newPlayerId();
		const store = newStore();
		const key = crypto.randomUUID();
		const first = await submitAction(
			makeDeps({ store }),
			playerId,
			buildRequest(plantWheat(0), 0, key),
		);
		await submitAction(
			makeDeps({ store, serverTime: () => 2_000 }),
			playerId,
			buildRequest(plantWheat(1), 1),
		);

		let ticks = 0;
		const timing = createTiming(() => ticks++);
		const resent = await submitAction(
			makeDeps({ store, serverTime: () => 3_000, timing }),
			playerId,
			buildRequest(plantWheat(0), 0, key),
		);

		// Plot 1 is growing now, so the rules would refuse the action; the farm is a fresh load.
		const reloaded = await loadFarm(makeDeps({ store }), playerId);
		expect(first).toMatchObject({ kind: "answered", answer: { seq: 1, retries: 0 } });
		expect(resent).toStrictEqual({
			kind: "answered",
			answer: answerOf(first),
			farm: farmOf(reloaded),
		});
		expect(reloaded).toMatchObject({ farm: { seq: 2, at: 2_000 } });
		// Asked first, so the rules never ran: `processed`, then the fresh load.
		expect(timing.renderServerTiming()).toBe("load;dur=2");
	});

	it("refuses an action the rules refuse with the sim's reason word for word, and writes nothing", async () => {
		const playerId = newPlayerId();
		const store = newStore();
		await submitAction(makeDeps({ store }), playerId, buildRequest(plantWheat(0), 0));
		const key = crypto.randomUUID();

		const result = await submitAction(
			makeDeps({ store, serverTime: () => 2_000 }),
			playerId,
			buildRequest(plantWheat(0), 1, key),
		);

		expect(result).toStrictEqual({ kind: "refused", reason: "Plot 1 isn't empty." });
		expect(await store.processed(playerId, key)).toBeNull();
		expect((await store.load(playerId)).seq).toBe(1);
	});

	it("marks an action on a stale expectedSeq rebased, at the time of the farm's last action", async () => {
		const playerId = newPlayerId();
		const store = newStore();
		// Another tab's action, committed straight to the store at a later server time than this
		// request's stamp.
		const other = rules.sim.apply(rules.newFarm(playerId), plantWheat(1), 5_000);
		if (!other.ok) throw new Error(other.reason);
		await store.commit(playerId, {
			expectedSeq: 0,
			action: plantWheat(1),
			at: 5_000,
			idempotencyKey: crypto.randomUUID(),
			next: other.state,
			answer: { seq: 1, hash: stateHash(other.state), rebased: false, retries: 0 },
		});

		const result = await submitAction(
			makeDeps({ store, serverTime: () => 1_000 }),
			playerId,
			buildRequest(plantWheat(0), 0),
		);

		const stored = await store.load(playerId);
		expect(stored).toMatchObject({ seq: 2, at: 5_000 });
		expect(result).toStrictEqual({
			kind: "answered",
			answer: { seq: 2, hash: stateHash(stored.state), rebased: true, retries: 0 },
			farm: { seq: 2, at: 5_000, state: stored.state, rulesVersion: 1 },
		});
	});

	it("retries a conflict and commits once, counting the retry in the answer", async () => {
		const playerId = newPlayerId();
		const store = newStore([true]);

		const result = await submitAction(
			makeDeps({ store }),
			playerId,
			buildRequest(plantWheat(0), 0),
		);

		expect(result).toMatchObject({
			kind: "answered",
			answer: { seq: 1, rebased: false, retries: 1 },
			farm: { seq: 1, at: 1_000 },
		});
		expect((await store.load(playerId)).seq).toBe(1);
	});

	it("commits on the third retry after three conflicts (MUST-13.3)", async () => {
		const playerId = newPlayerId();
		const store = newStore([true, true, true]);

		const result = await submitAction(
			makeDeps({ store }),
			playerId,
			buildRequest(plantWheat(0), 0),
		);

		expect(result).toMatchObject({ kind: "answered", answer: { seq: 1, retries: 3 } });
	});

	it("answers busy and commits nothing when the third retry conflicts too (MUST-13.3)", async () => {
		const playerId = newPlayerId();
		const store = newStore([true, true, true, true]);
		const key = crypto.randomUUID();

		const result = await submitAction(
			makeDeps({ store }),
			playerId,
			buildRequest(plantWheat(0), 0, key),
		);

		expect(result).toStrictEqual({ kind: "busy", cause: "conflicts" });
		expect(await store.processed(playerId, key)).toBeNull();
		expect((await store.load(playerId)).seq).toBe(0);
		// The script is used up: the same key commits on the client's retry.
		expect(
			await submitAction(makeDeps({ store }), playerId, buildRequest(plantWheat(0), 0, key)),
		).toMatchObject({ kind: "answered", answer: { seq: 1, retries: 0 } });
	});

	it("reads server time once per request, so every retry commits at the same time", async () => {
		const playerId = newPlayerId();
		const store = newStore([true, true]);
		let reads = 0;
		const serverTime = (): number => {
			reads++;
			return reads * 1_000;
		};

		const result = await submitAction(
			makeDeps({ store, serverTime }),
			playerId,
			buildRequest(plantWheat(0), 0),
		);

		expect(reads).toBe(1);
		expect(result).toMatchObject({ answer: { retries: 2 }, farm: { at: 1_000 } });
		expect((await store.load(playerId)).at).toBe(1_000);
	});

	it("answers a resend that raced its first commit with the first answer, not a refusal", async () => {
		const playerId = newPlayerId();
		const store = newStore();
		const key = crypto.randomUUID();
		const first = await submitAction(
			makeDeps({ store }),
			playerId,
			buildRequest(plantWheat(0), 0, key),
		);
		// `processed` ran before the first commit landed; the load after it sees the commit.
		let asked = 0;
		const racing: GameStore = {
			...store,
			processed: async (id, idempotencyKey) => {
				asked++;
				return asked === 1 ? null : await store.processed(id, idempotencyKey);
			},
		};

		const resent = await submitAction(
			makeDeps({ store: racing, serverTime: () => 2_000 }),
			playerId,
			buildRequest(plantWheat(0), 0, key),
		);

		expect(resent).toMatchObject({ kind: "answered", farm: { seq: 1 } });
		expect(answerOf(resent)).toStrictEqual(answerOf(first));
	});

	it("answers a key the commit finds already used with the stored answer", async () => {
		const playerId = newPlayerId();
		const store = newStore();
		const key = crypto.randomUUID();
		const first = await submitAction(
			makeDeps({ store }),
			playerId,
			buildRequest(plantWheat(0), 0, key),
		);
		// `processed` misses the key, and the resend's action is one the rules would accept.
		const missing: GameStore = { ...store, processed: () => Promise.resolve(null) };

		const resent = await submitAction(
			makeDeps({ store: missing, serverTime: () => 2_000 }),
			playerId,
			buildRequest(plantWheat(1), 1, key),
		);

		expect(resent).toMatchObject({ kind: "answered", farm: { seq: 1, at: 1_000 } });
		expect(answerOf(resent)).toStrictEqual(answerOf(first));
	});

	it.each(["processed", "load", "commit"] as const)(
		"answers busy when the store's %s throws, with nothing committed (ADR-0006, section 8)",
		async (method) => {
			const playerId = newPlayerId();
			const store = newStore();
			const error = storeError();
			const failing: GameStore = { ...store, [method]: () => Promise.reject(error) };

			const result = await submitAction(
				makeDeps({ store: failing }),
				playerId,
				buildRequest(plantWheat(0), 0),
			);

			expect(result).toStrictEqual({ kind: "busy", cause: "store", error });
			expect((await store.load(playerId)).seq).toBe(0);
		},
	);

	it("times load, sim and commit, summed across a retry", async () => {
		let ticks = 0;
		// Each read of the clock moves it on 1 ms, so each timed step lasts 1 ms.
		const timing = createTiming(() => ticks++);

		await submitAction(
			makeDeps({ store: newStore([true]), timing }),
			newPlayerId(),
			buildRequest(plantWheat(0), 0),
		);

		// load: processed, then a load per attempt; sim and commit: once per attempt.
		expect(timing.renderServerTiming()).toBe("load;dur=3, sim;dur=2, commit;dur=2");
	});
});

interface DepsOptions {
	readonly store?: GameStore;
	readonly serverTime?: () => number;
	readonly timing?: Timing;
}

function makeDeps({
	store = newStore(),
	serverTime = () => 1_000,
	timing = createTiming(),
}: DepsOptions = {}): GameDeps {
	return { store, rules, timing, serverTime };
}

/** The in-memory store on the game's rules, with `conflicts` scripted (#383). */
function newStore(conflicts: readonly boolean[] = []): GameStore {
	const { newFarm, replay, rulesVersion } = rules;
	return createMemoryStore({ newFarm, replay, rulesVersion, conflicts });
}

function buildRequest(
	action: Action,
	expectedSeq: number,
	idempotencyKey = crypto.randomUUID(),
): SubmitRequest {
	return { action, expectedSeq, idempotencyKey };
}

function plantWheat(plot: number): Action {
	return { type: "plant", plot, crop: "wheat" };
}

/** What B100's `load` throws for a farm on rules the running code doesn't know (ADR-0006, s. 8). */
function storeError(): Error {
	return new Error("Store error: rules version 2 is unknown.");
}

/** The answer of a result that must be `answered`. */
function answerOf(result: SubmitResult): Answer {
	if (result.kind !== "answered") throw new Error(`Expected an answer, got ${result.kind}.`);

	return result.answer;
}

/** The farm of a result that must carry one. */
function farmOf(result: SubmitResult | LoadResult): FarmEnvelope {
	if (result.kind !== "answered" && result.kind !== "loaded") {
		throw new Error(`Expected a farm, got ${result.kind}.`);
	}

	return result.farm;
}

/** A verified player's id: auth brands the token's `sub`, a UUID, which the stores require. */
function newPlayerId(): PlayerId {
	return crypto.randomUUID() as PlayerId;
}

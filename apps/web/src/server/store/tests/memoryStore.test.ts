import { describe, expect, it } from "vitest";

import type { Action } from "@sunny-pastures/sim";

import { describeGameStore, playActions, type MakeStore } from "./contract";
import { makeEntry, newFarm, replay } from "./farms";
import { createMemoryStore } from "./memoryStore";

// The fake held to the store's contract (ADR-0007 section 6; #383): the same cases B100 passes in
// store.db.test.ts, with no database.
const makeMemoryStore: MakeStore = (rules = {}) => createMemoryStore({ newFarm, replay, ...rules });

describe("createMemoryStore", () => {
	describeGameStore(makeMemoryStore);
});

describe("createMemoryStore with scripted conflicts", () => {
	it("conflicts twice, writing nothing, then commits the same entry", async () => {
		const farmId = crypto.randomUUID();
		const store = createMemoryStore({ newFarm, replay, conflicts: [true, true] });
		const entry = makeEntry(newFarm(), 0, 1_000);

		expect(await store.commit(farmId, entry)).toEqual({ kind: "conflict" });
		expect(await store.commit(farmId, entry)).toEqual({ kind: "conflict" });
		expect(await store.processed(farmId, entry.idempotencyKey)).toBeNull();
		expect((await store.load(farmId)).seq).toBe(0);
		expect(await store.commit(farmId, entry)).toEqual({ kind: "committed", seq: 1 });
	});

	it("follows the script per commit: commit, conflict, then commit", async () => {
		const farmId = crypto.randomUUID();
		const store = createMemoryStore({ newFarm, replay, conflicts: [false, true] });
		const first = makeEntry(newFarm(), 0, 1_000);
		const second = makeEntry(first.next, 1, 2_000);

		expect(await store.commit(farmId, first)).toEqual({ kind: "committed", seq: 1 });
		expect(await store.commit(farmId, second)).toEqual({ kind: "conflict" });
		expect(await store.commit(farmId, second)).toEqual({ kind: "committed", seq: 2 });
	});

	it("answers a resent key as a duplicate without using up a scripted conflict", async () => {
		const farmId = crypto.randomUUID();
		const store = createMemoryStore({ newFarm, replay, conflicts: [false, true] });
		const first = makeEntry(newFarm(), 0, 1_000);
		await store.commit(farmId, first);

		expect(await store.commit(farmId, first)).toEqual({
			kind: "duplicate",
			answer: first.answer,
		});
		expect(await store.commit(farmId, makeEntry(first.next, 1, 2_000))).toEqual({
			kind: "conflict",
		});
	});

	it("answers a stale expectedSeq with a real conflict, without using up a scripted one", async () => {
		const farmId = crypto.randomUUID();
		const store = createMemoryStore({ newFarm, replay, conflicts: [true] });
		const entry = makeEntry(newFarm(), 0, 1_000);

		expect(await store.commit(farmId, makeEntry(newFarm(), 5, 1_000))).toEqual({
			kind: "conflict",
		});
		expect(await store.commit(farmId, entry)).toEqual({ kind: "conflict" });
		expect(await store.commit(farmId, entry)).toEqual({ kind: "committed", seq: 1 });
	});

	it("keeps the script per store, not per farm", async () => {
		const store = createMemoryStore({ newFarm, replay, conflicts: [true] });

		expect(await store.commit(crypto.randomUUID(), makeEntry(newFarm(), 0, 1_000))).toEqual({
			kind: "conflict",
		});
		expect(await store.commit(crypto.randomUUID(), makeEntry(newFarm(), 0, 1_000))).toEqual({
			kind: "committed",
			seq: 1,
		});
	});
});

describe("createMemoryStore's copies", () => {
	it("keeps the answer it stored, whatever the caller does to the object afterwards", async () => {
		const farmId = crypto.randomUUID();
		const store = createMemoryStore({ newFarm, replay });
		const entry = makeEntry(newFarm(), 0, 1_000);
		await store.commit(farmId, entry);

		(entry.answer as { seq: number }).seq = 99;

		expect(await store.processed(farmId, entry.idempotencyKey)).toEqual({
			seq: 1,
			hash: "hash-1",
			rebased: false,
			retries: 0,
		});
	});

	it("keeps the snapshot it stored, whatever the caller does to the farms it handed or got", async () => {
		const farmId = crypto.randomUUID();
		const store = createMemoryStore({ newFarm, replay });
		const [farm100] = (await playActions(store, farmId, 100)).slice(-1);
		const snapshot = structuredClone(farm100);

		(farm100 as { coins: number }).coins = 99;
		const loaded = await store.load(farmId);
		(loaded.state as { coins: number }).coins = 98;

		expect((await store.load(farmId)).state).toStrictEqual(snapshot);
	});

	it("keeps the actions it logged, whatever the caller or replay does to them", async () => {
		const farmId = crypto.randomUUID();
		const seen: Action[][] = [];
		const store = createMemoryStore({
			newFarm,
			replay: (state, actions, to) => {
				seen.push(actions.map(({ action }) => structuredClone(action)));
				for (const { action } of actions) (action as { plot: number }).plot = 99;
				return replay(state, actions, to);
			},
		});
		const entry = makeEntry(newFarm(), 0, 1_000);
		const action = structuredClone(entry.action);
		await store.commit(farmId, entry);

		(entry.action as { plot: number }).plot = 98;
		await store.load(farmId);
		await store.load(farmId);

		expect(seen).toEqual([[action], [action]]);
	});
});

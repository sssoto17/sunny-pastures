import { expect, it } from "vitest";

import type { GameStore, StoreDeps } from "../index";
import { makeEntry, newFarm, plant, recordReplay, replay } from "./farms";

// The store contract (ADR-0001, "Store interface"; ADR-0007 section 6, "Action-handler tests: an
// in-memory store held to a contract"): one suite that B100 runs as a `db` test and the in-memory
// store as a `unit` test, so the fake can't drift from the store without failing it (Contract
// test). The cases came over from #373's store.db.test.ts as they were (#383).

/** Builds a store with the stand-in rules (`./farms`), or with the `replay` a test hands in. */
export type MakeStore = (rules?: Partial<Pick<StoreDeps, "replay">>) => GameStore;

/**
 * A new farm id no other test uses ("Isolation by farm"): a player made on the stack for B100,
 * where every farm belongs to one, and a fresh UUID by default.
 */
export type MakePlayer = () => Promise<string>;

/** Declares the contract's cases on the stores `makeStore` builds; call it inside a `describe`. */
export function describeGameStore(
	makeStore: MakeStore,
	makePlayer: MakePlayer = async () => await Promise.resolve(crypto.randomUUID()),
): void {
	it("loads a farm with no action as a new farm at seq 0", async () => {
		const farmId = await makePlayer();

		expect(await makeStore().load(farmId)).toEqual({ state: newFarm(), seq: 0, at: 0 });
	});

	it("loads a committed farm back as it was committed, types included", async () => {
		const farmId = await makePlayer();
		const store = makeStore();
		const entry = makeEntry(newFarm(), 0, 1_000);

		expect(await store.commit(farmId, entry)).toEqual({ kind: "committed", seq: 1 });
		expect(await store.load(farmId)).toStrictEqual({ state: entry.next, seq: 1, at: 1_000 });
	});

	it("gives each commit the next seq, with no gaps (MUST-13.1)", async () => {
		const farmId = await makePlayer();
		const store = makeStore();

		const farms = await playActions(store, farmId, 5);

		expect(await store.load(farmId)).toStrictEqual({ state: farms[5], seq: 5, at: 5_000 });
	});

	it("loads what replaying the whole log from a new farm gives", async () => {
		const farmId = await makePlayer();
		const store = makeStore();
		await playActions(store, farmId, 3);
		// The log playActions wrote: makeEntry's action for each seq, at its second.
		const logged = [1, 2, 3].map((seq) => ({ seq, at: seq * 1_000, action: plant(seq % 3) }));

		expect(await store.load(farmId)).toStrictEqual({
			state: replay(newFarm(), logged, 3_000),
			seq: 3,
			at: 3_000,
		});
	});

	it("conflicts on a stale or skipped expectedSeq, and writes nothing (MUST-13.3)", async () => {
		const farmId = await makePlayer();
		const store = makeStore();
		const [, first] = await playActions(store, farmId, 1);
		const stale = makeEntry(newFarm(), 0, 2_000);
		const ahead = makeEntry(newFarm(), 2, 2_000);

		expect(await store.commit(farmId, stale)).toEqual({ kind: "conflict" });
		expect(await store.commit(farmId, ahead)).toEqual({ kind: "conflict" });
		expect(await store.load(farmId)).toStrictEqual({ state: first, seq: 1, at: 1_000 });
		expect(await store.processed(farmId, stale.idempotencyKey)).toBeNull();
		expect(await store.processed(farmId, ahead.idempotencyKey)).toBeNull();
	});

	it.each([-1, 1.5, Number.NaN, 2 ** 53])(
		"refuses an expectedSeq of %s, and writes nothing",
		async (expectedSeq) => {
			const farmId = await makePlayer();
			const store = makeStore();
			const entry = { ...makeEntry(newFarm(), 0, 1_000), expectedSeq };

			await expect(store.commit(farmId, entry)).rejects.toThrow(RangeError);
			expect((await store.load(farmId)).seq).toBe(0);
		},
	);

	it("refuses an expectedSeq that is a string, as an unchecked request body could send", async () => {
		const farmId = await makePlayer();
		const store = makeStore();
		await playActions(store, farmId, 5);
		const entry = { ...makeEntry(newFarm(), 5, 6_000), expectedSeq: "5" as unknown as number };

		await expect(store.commit(farmId, entry)).rejects.toThrow(RangeError);
		expect((await store.load(farmId)).seq).toBe(5);
	});

	it("answers a resent key with the first answer, and writes nothing (MUST-13.2)", async () => {
		const farmId = await makePlayer();
		const store = makeStore();
		const first = makeEntry(newFarm(), 0, 1_000);
		await store.commit(farmId, first);
		const resent = { ...makeEntry(first.next, 1, 2_000), idempotencyKey: first.idempotencyKey };

		expect(await store.processed(farmId, first.idempotencyKey)).toEqual(first.answer);
		expect(await store.commit(farmId, resent)).toEqual({ kind: "duplicate", answer: first.answer });
		expect(await store.load(farmId)).toStrictEqual({ state: first.next, seq: 1, at: 1_000 });
	});

	it("finds no answer for a key the farm never used, even one another farm used", async () => {
		const [farmId, otherId] = await Promise.all([makePlayer(), makePlayer()]);
		const store = makeStore();
		const entry = makeEntry(newFarm(), 0, 1_000);
		await store.commit(otherId, entry);

		expect(await store.processed(farmId, entry.idempotencyKey)).toBeNull();
		expect(await store.processed(farmId, crypto.randomUUID())).toBeNull();
	});

	it("commits one of two concurrent commits at the same expectedSeq; the other conflicts (MUST-13.3)", async () => {
		const farmId = await makePlayer();
		const store = makeStore();
		await playActions(store, farmId, 2);
		const { state: farm } = await store.load(farmId);
		const left = makeEntry(farm, 2, 3_000);
		const right = makeEntry(farm, 2, 3_001);

		const results = await Promise.all([store.commit(farmId, left), store.commit(farmId, right)]);

		expect(results.map(({ kind }) => kind).sort()).toEqual(["committed", "conflict"]);
		const [winner, loser] = results[0].kind === "committed" ? [left, right] : [right, left];
		expect(await store.processed(farmId, loser.idempotencyKey)).toBeNull();
		expect(await store.load(farmId)).toStrictEqual({ state: winner.next, seq: 3, at: winner.at });
	});

	it("commits a key sent twice at once only once; the other gets the first answer", async () => {
		const farmId = await makePlayer();
		const store = makeStore();
		const entry = makeEntry(newFarm(), 0, 1_000);

		const results = await Promise.all([store.commit(farmId, entry), store.commit(farmId, entry)]);

		expect(results).toEqual(
			expect.arrayContaining([
				{ kind: "committed", seq: 1 },
				{ kind: "duplicate", answer: entry.answer },
			]),
		);
		expect((await store.load(farmId)).seq).toBe(1);
	});

	it("loads from the snapshot at seq 100, replaying only the actions after it", async () => {
		const farmId = await makePlayer();
		const recorded = recordReplay();
		// One store for the whole case, as the in-memory store keeps its farms per store; commits
		// never replay, so the calls recorded are the load's alone.
		const store = makeStore({ replay: recorded.replay });
		const farms = await playActions(store, farmId, 130);

		const loaded = await store.load(farmId);

		expect(loaded).toStrictEqual({ state: farms[130], seq: 130, at: 130_000 });
		expect(recorded.calls).toEqual([Array.from({ length: 30 }, (_, i) => 101 + i)]);
	});
}

/**
 * Commits `count` actions to `farmId` from seq 1, one a second, and returns the farm after each
 * (index 0 is the new farm), as the game loop computed it.
 */
export async function playActions(store: GameStore, farmId: string, count: number) {
	let farm = newFarm();
	const farms = [farm];
	for (let seq = 1; seq <= count; seq++) {
		const entry = makeEntry(farm, seq - 1, seq * 1_000);
		expect(await store.commit(farmId, entry)).toEqual({ kind: "committed", seq });
		farm = entry.next;
		farms.push(farm);
	}
	return farms;
}

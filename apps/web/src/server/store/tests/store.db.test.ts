import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createPlayer, readStack } from "../../db/tests/stack";
import { createStore, type GameStore, type StoreDeps } from "../index";
import { actions, snapshots } from "../schema";
import { makeEntry, newFarm, recordReplay, replay } from "./farms";

// B100 against the local stack (Vitest's db project; #373, ADR-0007 section 6). The store connects
// as game_api, over a client built as createDb builds it (the store's tests may import `db` only as a
// type, .fallowrc.jsonc); each test makes its own player, so tests share no farm and nothing is
// truncated ("Isolation by farm").
const db = drizzle(postgres(readStack().databaseUrl));

afterAll(async () => {
	await db.$client.end();
});

/** Builds a store with the stand-in rules, or with the `replay` a test hands in. */
type MakeStore = (rules?: Partial<Pick<StoreDeps, "replay">>) => GameStore;

const makeB100: MakeStore = (rules = {}) => createStore({ db, newFarm, replay, ...rules });

const checkViolation = { cause: { code: "23514" } };

/**
 * Commits `count` actions to `farmId` from seq 1, one a second, and returns the farm after each
 * (index 0 is the new farm), as the game loop computed it.
 */
async function play(store: GameStore, farmId: string, count: number) {
	const farms = [newFarm()];
	for (let seq = 1; seq <= count; seq++) {
		const entry = makeEntry(farms[seq - 1] ?? newFarm(), seq - 1, seq * 1_000);
		expect(await store.commit(farmId, entry)).toEqual({ kind: "committed", seq });
		farms.push(entry.next);
	}
	return farms;
}

// The store contract (ADR-0001, "Store interface"): written against `makeStore` so the cases move
// as they are into #383's `describeGameStore(makeStore)`, which also runs them on the in-memory
// store (#333's comment on #373).
function describeGameStore(name: string, makeStore: MakeStore) {
	describe(name, () => {
		it("loads a farm with no action as a new farm at seq 0", async () => {
			const farmId = await createPlayer();

			expect(await makeStore().load(farmId)).toEqual({ state: newFarm(), seq: 0, at: 0 });
		});

		it("loads a committed farm back as it was committed, types included", async () => {
			const farmId = await createPlayer();
			const store = makeStore();
			const entry = makeEntry(newFarm(), 0, 1_000);

			expect(await store.commit(farmId, entry)).toEqual({ kind: "committed", seq: 1 });
			expect(await store.load(farmId)).toStrictEqual({ state: entry.next, seq: 1, at: 1_000 });
		});

		it("gives each commit the next seq, with no gaps (MUST-13.1)", async () => {
			const farmId = await createPlayer();
			const store = makeStore();

			const farms = await play(store, farmId, 5);

			expect(await store.load(farmId)).toStrictEqual({ state: farms[5], seq: 5, at: 5_000 });
		});

		it("conflicts on a stale or skipped expectedSeq, and writes nothing (MUST-13.3)", async () => {
			const farmId = await createPlayer();
			const store = makeStore();
			const [, first] = await play(store, farmId, 1);
			const stale = makeEntry(newFarm(), 0, 2_000);
			const ahead = makeEntry(newFarm(), 2, 2_000);

			expect(await store.commit(farmId, stale)).toEqual({ kind: "conflict" });
			expect(await store.commit(farmId, ahead)).toEqual({ kind: "conflict" });
			expect(await store.load(farmId)).toStrictEqual({ state: first, seq: 1, at: 1_000 });
			expect(await store.processed(farmId, stale.idempotencyKey)).toBeNull();
			expect(await store.processed(farmId, ahead.idempotencyKey)).toBeNull();
		});

		it("answers a resent key with the first answer, and writes nothing (MUST-13.2)", async () => {
			const farmId = await createPlayer();
			const store = makeStore();
			const first = makeEntry(newFarm(), 0, 1_000);
			await store.commit(farmId, first);
			const resent = { ...makeEntry(first.next, 1, 2_000), idempotencyKey: first.idempotencyKey };

			expect(await store.processed(farmId, first.idempotencyKey)).toEqual(first.answer);
			expect(await store.commit(farmId, resent)).toEqual({
				kind: "duplicate",
				answer: first.answer,
			});
			expect(await store.load(farmId)).toStrictEqual({ state: first.next, seq: 1, at: 1_000 });
		});

		it("finds no answer for a key the farm never used, even one another farm used", async () => {
			const [farmId, otherId] = await Promise.all([createPlayer(), createPlayer()]);
			const store = makeStore();
			const entry = makeEntry(newFarm(), 0, 1_000);
			await store.commit(otherId, entry);

			expect(await store.processed(farmId, entry.idempotencyKey)).toBeNull();
			expect(await store.processed(farmId, crypto.randomUUID())).toBeNull();
		});

		it("commits one of two concurrent commits at the same expectedSeq; the other conflicts (MUST-13.3)", async () => {
			const farmId = await createPlayer();
			const store = makeStore();
			const [, , farm] = await play(store, farmId, 2);
			const left = makeEntry(farm ?? newFarm(), 2, 3_000);
			const right = makeEntry(farm ?? newFarm(), 2, 3_001);

			const results = await Promise.all([store.commit(farmId, left), store.commit(farmId, right)]);

			expect(results.map(({ kind }) => kind).sort()).toEqual(["committed", "conflict"]);
			const [winner, loser] = results[0].kind === "committed" ? [left, right] : [right, left];
			expect(await store.processed(farmId, loser.idempotencyKey)).toBeNull();
			expect(await store.load(farmId)).toStrictEqual({
				state: winner.next,
				seq: 3,
				at: winner.at,
			});
		});

		it("commits a key sent twice at once only once; the other gets the first answer", async () => {
			const farmId = await createPlayer();
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
			const farmId = await createPlayer();
			const farms = await play(makeStore(), farmId, 130);
			const recorded = recordReplay();

			const loaded = await makeStore({ replay: recorded.replay }).load(farmId);

			expect(loaded).toStrictEqual({ state: farms[130], seq: 130, at: 130_000 });
			expect(recorded.calls).toEqual([Array.from({ length: 30 }, (_, i) => 101 + i)]);
		});
	});
}

describeGameStore("createStore (B100)", makeB100);

// What only B100 over Postgres does: the rules-version tie-break between snapshots, and the
// database's own refusals.
describe("createStore (B100) over the game schema", () => {
	it("loads from the snapshot with the higher rules version at the same seq (ADR-0006, section 5)", async () => {
		const farmId = await createPlayer();
		await play(makeB100(), farmId, 100);
		// A base snapshot of a later version at seq 100, and one at an earlier seq that loses on seq.
		const base = { ...newFarm(), xp: 1_000 };
		await db.insert(snapshots).values([
			{ farmId, seq: 100, at: 100_000, state: base, rulesVersion: 2 },
			{ farmId, seq: 99, at: 99_000, state: newFarm(), rulesVersion: 3 },
		]);
		const recorded = recordReplay();

		const loaded = await makeB100({ replay: recorded.replay }).load(farmId);

		expect(loaded).toStrictEqual({ state: base, seq: 100, at: 100_000 });
		expect(recorded.calls).toEqual([]);
	});

	it("refuses an at above 2^53 - 1, and writes nothing", async () => {
		const farmId = await createPlayer();
		const store = makeB100();
		const entry = makeEntry(newFarm(), 0, 2 ** 53);

		await expect(store.commit(farmId, entry)).rejects.toMatchObject(checkViolation);
		expect(await store.load(farmId)).toEqual({ state: newFarm(), seq: 0, at: 0 });
		expect(await store.processed(farmId, entry.idempotencyKey)).toBeNull();
	});

	it("refuses a seq above 2^53 - 1", async () => {
		const farmId = await createPlayer();
		const last = Number.MAX_SAFE_INTEGER;
		// A log already at the largest seq the column holds, written straight into the table.
		await db.insert(actions).values({
			farmId,
			seq: last,
			at: 0,
			action: makeEntry(newFarm(), 0, 0).action,
			idempotencyKey: crypto.randomUUID(),
			answer: {},
			rulesVersion: 1,
		});

		await expect(
			makeB100().commit(farmId, makeEntry(newFarm(), last, 1_000)),
		).rejects.toMatchObject(checkViolation);
	});

	it("stamps every row and every 100th-action snapshot with rules version 1", async () => {
		const farmId = await createPlayer();
		await play(makeB100(), farmId, 100);

		const [rows, snapshotRows] = await Promise.all([
			db
				.selectDistinct({ rulesVersion: actions.rulesVersion })
				.from(actions)
				.where(eq(actions.farmId, farmId)),
			db
				.select({ seq: snapshots.seq, rulesVersion: snapshots.rulesVersion })
				.from(snapshots)
				.where(eq(snapshots.farmId, farmId)),
		]);

		expect(rows).toEqual([{ rulesVersion: 1 }]);
		expect(snapshotRows).toEqual([{ seq: 100, rulesVersion: 1 }]);
	});
});

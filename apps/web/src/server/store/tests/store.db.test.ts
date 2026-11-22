import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createPlayer, readStack } from "../../db/tests/stack";
import { createStore } from "../index";
import { actions, snapshots } from "../schema";
import { describeGameStore, playActions, type MakeStore } from "./contract";
import { makeEntry, newFarm, recordReplay, replay } from "./farms";

// B100 against the local stack (Vitest's db project; #373, ADR-0007 section 6): the store contract
// (./contract.ts, which memoryStore.test.ts runs on the fake too), then what only B100 does. The
// store connects as game_api, over a client built as createDb builds it (the store's tests may
// import `db` only as a type, .fallowrc.jsonc); each test makes its own player, so tests share no
// farm and nothing is truncated ("Isolation by farm").
const db = drizzle(postgres(readStack().databaseUrl));

afterAll(async () => {
	await db.$client.end();
});

const makeB100: MakeStore = (rules = {}) =>
	createStore({ db, newFarm, replay, rulesVersion: 1, ...rules });

const checkViolation = { cause: { code: "23514" } };

describe("createStore (B100)", () => {
	describeGameStore(makeB100, createPlayer);
});

// What only B100 over Postgres does: the rules-version tie-break between snapshots, and the
// database's own refusals.
describe("createStore (B100) over the game schema", () => {
	it("loads from the snapshot with the higher rules version at the same seq (ADR-0006, section 5)", async () => {
		const farmId = await createPlayer();
		await playActions(makeB100(), farmId, 100);
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
		await insertRow(farmId, last, 0);

		await expect(
			makeB100().commit(farmId, makeEntry(newFarm(), last, 1_000)),
		).rejects.toMatchObject(checkViolation);
	});

	it("stamps every row and every 100th-action snapshot with the rules version it was given", async () => {
		const farmId = await createPlayer();
		// Not 1, so a constant left in the store would fail this (#443).
		const store = createStore({ db, newFarm, replay, rulesVersion: 2 });
		await playActions(store, farmId, 100);

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

		expect(rows).toEqual([{ rulesVersion: 2 }]);
		expect(snapshotRows).toEqual([{ seq: 100, rulesVersion: 2 }]);
	});

	// `replay` checks the gaps between the rows it is handed, not the first row against the
	// snapshot's seq, which the farm doesn't carry: the store checks that boundary (#443).
	it("throws a store error when the first row after the snapshot isn't the snapshot's seq + 1", async () => {
		const farmId = await createPlayer();
		await playActions(makeB100(), farmId, 100);
		// The row for seq 101 is lost: seq 102 is written straight into the table.
		await insertRow(farmId, 102, 102_000);
		const recorded = recordReplay();

		await expect(makeB100({ replay: recorded.replay }).load(farmId)).rejects.toThrow(
			"Store error: the first log row after seq 100 is seq 102, not seq 101.",
		);
		expect(recorded.calls).toEqual([]);
	});

	it("throws a store error when a farm with no snapshot has no row at seq 1", async () => {
		const farmId = await createPlayer();
		await insertRow(farmId, 2, 2_000);

		await expect(makeB100().load(farmId)).rejects.toThrow(
			"Store error: the first log row after seq 0 is seq 2, not seq 1.",
		);
	});
});

/** A log row written straight into the table, past the store's gap-free append (ADR-0007 Q6). */
async function insertRow(farmId: string, seq: number, at: number): Promise<void> {
	await db.insert(actions).values({
		farmId,
		seq,
		at,
		action: makeEntry(newFarm(), 0, at).action,
		idempotencyKey: crypto.randomUUID(),
		answer: {},
		rulesVersion: 1,
	});
}

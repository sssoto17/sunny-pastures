import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlayer, readStack } from "@/server/tests/stack";

import { actions, snapshots } from "../schema";

// Against the local stack after `pnpm db:reset` (Vitest's db project; #372, #382, #331 decision
// 2): what the migrations let game_api, anon and authenticated do with the game schema. Each farm
// belongs to a player made with createPlayer, as the tests set up their own data (#331 decision 8),
// and the admin connection (postgres) takes on PostgREST's roles with `set local role`.
const stack = readStack();
const admin = postgres(stack.adminDatabaseUrl, { max: 1 });
const gameApi = drizzle(postgres(stack.databaseUrl, { max: 1 }));
const farmId = await createPlayer();

const action = {
	farmId,
	seq: 1,
	at: 0,
	action: { type: "plant" },
	idempotencyKey: randomUUID(),
	answer: { ok: true },
	rulesVersion: 1,
};
const snapshot = { farmId, seq: 1, at: 0, state: { coins: 3 }, rulesVersion: 1 };

const insufficientPrivilege = { cause: { code: "42501" } };
const checkViolation = { cause: { code: "23514" } };

beforeAll(async () => {
	await gameApi.insert(actions).values(action);
	await gameApi.insert(snapshots).values(snapshot);
});

afterAll(async () => {
	await admin`delete from auth.users where id = ${farmId}`;
	await Promise.all([admin.end(), gameApi.$client.end()]);
});

describe("game_api", () => {
	it("reads back the action it inserted", async () => {
		const rows = await gameApi.select().from(actions).where(eq(actions.farmId, farmId));

		expect(rows).toEqual([action]);
	});

	it("reads back the snapshot it inserted", async () => {
		const rows = await gameApi.select().from(snapshots).where(eq(snapshots.farmId, farmId));

		expect(rows).toEqual([snapshot]);
	});

	it("can't update or delete an action: the log is append-only by grant", async () => {
		await expect(
			gameApi.update(actions).set({ at: 1 }).where(eq(actions.farmId, farmId)),
		).rejects.toMatchObject(insufficientPrivilege);
		await expect(gameApi.delete(actions).where(eq(actions.farmId, farmId))).rejects.toMatchObject(
			insufficientPrivilege,
		);
	});

	it("can't update or delete a snapshot", async () => {
		await expect(
			gameApi.update(snapshots).set({ at: 1 }).where(eq(snapshots.farmId, farmId)),
		).rejects.toMatchObject(insufficientPrivilege);
		await expect(
			gameApi.delete(snapshots).where(eq(snapshots.farmId, farmId)),
		).rejects.toMatchObject(insufficientPrivilege);
	});

	it("can't reach Supabase's auth schema", async () => {
		await expect(gameApi.execute(sql`select id from auth.users limit 1`)).rejects.toMatchObject(
			insufficientPrivilege,
		);
	});
});

describe("PostgREST's roles", () => {
	it.each(["anon", "authenticated"])("%s can't read either table", async (role) => {
		for (const table of ["game.actions", "game.snapshots"]) {
			const read = admin.begin(async (tx) => {
				await tx.unsafe(`set local role ${role}`);
				return await tx.unsafe(`select 1 from ${table} limit 1`);
			});

			await expect(read).rejects.toMatchObject({ code: "42501" });
		}
	});
});

describe("the check constraints", () => {
	it.each([
		["seq 0", { seq: 0 }],
		["seq above 2^53 - 1", { seq: 2 ** 53 }],
		["a negative at", { seq: 2, at: -1 }],
		["at above 2^53 - 1", { seq: 2, at: 2 ** 53 }],
		["rules_version 0", { seq: 2, rulesVersion: 0 }],
	])("refuse an action with %s", async (_, change) => {
		const row = { ...action, idempotencyKey: randomUUID(), ...change };

		await expect(gameApi.insert(actions).values(row)).rejects.toMatchObject(checkViolation);
	});

	it("refuse a snapshot with rules_version 0", async () => {
		await expect(
			gameApi.insert(snapshots).values({ ...snapshot, seq: 2, rulesVersion: 0 }),
		).rejects.toMatchObject(checkViolation);
	});
});

describe("a farm's rows", () => {
	it("go when its user is deleted from auth.users", async () => {
		const goneId = await createPlayer();
		await gameApi.insert(actions).values({ ...action, farmId: goneId });
		await gameApi.insert(snapshots).values({ ...snapshot, farmId: goneId });

		await admin`delete from auth.users where id = ${goneId}`;

		const [left] = await admin`
			select (select count(*) from game.actions where farm_id = ${goneId})::int
				+ (select count(*) from game.snapshots where farm_id = ${goneId})::int as n`;
		expect(left).toEqual({ n: 0 });
	});
});

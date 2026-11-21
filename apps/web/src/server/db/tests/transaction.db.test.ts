import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "../index";
import { readStack } from "./stack";

// Against the local stack (Vitest's db project; #372, #382). Drizzle 0.45.4 on postgres.js 4.x is untested
// upstream (#331 decision 10), so this proves `db.transaction` (postgres.js `sql.begin`), run as
// game_api through createDb, commits what it wrote: the admin connection, another session, reads
// the row back after the transaction ends, which it can't see unless it was committed. A scratch
// table the admin creates (game_api may create none) keeps it out of the store's tables, which
// this module doesn't own.
const stack = readStack();
const admin = postgres(stack.adminDatabaseUrl, { max: 1 });
const db = createDb({ databaseUrl: stack.databaseUrl });
// Unique per run, so a run that stopped before its afterAll can't collide with the next.
const table = `round_trip_${randomUUID().replaceAll("-", "")}`;

beforeAll(async () => {
	await admin.unsafe(`create table public.${table} (id int primary key, note text not null)`);
	await admin.unsafe(`grant select, insert on public.${table} to game_api`);
});

afterAll(async () => {
	await admin.unsafe(`drop table if exists public.${table}`);
	await Promise.all([admin.end(), db.$client.end()]);
});

describe("createDb against the local stack", () => {
	it("commits a transaction: another session reads its row after it ends", async () => {
		const inside = await db.transaction(async (tx) => {
			await tx.execute(sql`insert into ${sql.identifier(table)} values (${1}, ${"sown"})`);
			return await tx.execute<{ n: number }>(
				sql`select count(*)::int as n from ${sql.identifier(table)}`,
			);
		});

		const after = await admin.unsafe(`select id, note from public.${table}`);
		expect([...inside]).toEqual([{ n: 1 }]);
		expect([...after]).toEqual([{ id: 1, note: "sown" }]);
	});

	it("rolls back a transaction that throws: another session reads nothing", async () => {
		const failing = db.transaction(async (tx) => {
			await tx.execute(sql`insert into ${sql.identifier(table)} values (${2}, ${"wilted"})`);
			throw new Error("Refused.");
		});

		await expect(failing).rejects.toThrow("Refused.");
		const after = await admin.unsafe(`select id from public.${table} where id = 2`);
		expect([...after]).toEqual([]);
	});
});

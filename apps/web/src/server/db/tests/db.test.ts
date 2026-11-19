import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../index";

// postgres.js connects on the first query, never when the client is built, so this needs no
// database (#329 decision 5). The round trip against the local stack is db.stack.ts (#372).
describe("createDb", () => {
	it("builds a Drizzle client over postgres.js without connecting", async () => {
		const db = createDb({ databaseUrl: "postgresql://game_api@127.0.0.1:1/postgres" });

		expect(db.$client.options.host).toEqual(["127.0.0.1"]);
		expect(db.$client.options.user).toBe("game_api");
		await db.$client.end();
	});

	it("connects to the URL it was given on the first query", async () => {
		// Nothing listens on port 1, so the first query is refused rather than hanging.
		const db = createDb({ databaseUrl: "postgresql://game_api@127.0.0.1:1/postgres" });

		await expect(db.execute(sql`select 1`)).rejects.toMatchObject({
			cause: { code: "ECONNREFUSED" },
		});
		await db.$client.end();
	});
});

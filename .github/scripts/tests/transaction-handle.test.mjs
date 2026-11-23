// The transaction-handle rule in eslint.config.mjs (#28): code inside `db.transaction` queries
// through the transaction handle, never the outer client. It lives here for the reason
// sim-purity.test.mjs does: it imports eslint, which an apps/web test can't.
import { describe, expect, it } from "vitest";

import { lintSnippet } from "./lint-snippet.mjs";

const RULES = new Set(["no-restricted-syntax"]);
const STORE = "apps/web/src/server/store/index.ts";

const findings = (code, filePath = STORE) => lintSnippet(code, filePath, RULES);
const inTransaction = (body) =>
	`export async function run(db) {\n\tawait db.transaction(async (tx) => {\n\t\t${body}\n\t});\n}`;

describe("the transaction-handle lint rule", () => {
	it("passes a transaction that queries only through its handle", async () => {
		expect(await findings(inTransaction("await tx.select().from(t);"))).toEqual([]);
	});

	it("reports a query on the outer client inside the transaction", async () => {
		expect(await findings(inTransaction("await db.select().from(t);"))).toEqual([
			"3 no-restricted-syntax",
		]);
	});

	it("reports the outer client when it is passed to a helper", async () => {
		expect(await findings(inTransaction("await find(db, id);"))).toEqual([
			"3 no-restricted-syntax",
		]);
	});

	it("reports the underlying postgres.js client", async () => {
		expect(await findings(inTransaction("await db.$client`select 1`;"))).toEqual([
			"3 no-restricted-syntax",
		]);
	});

	it("reports the outer client inside a nested function", async () => {
		expect(await findings(inTransaction("await Promise.all([1].map(() => db.select()));"))).toEqual(
			["3 no-restricted-syntax"],
		);
	});

	it("allows the outer client outside any transaction", async () => {
		expect(await findings("export const read = (db) => db.select().from(t);")).toEqual([]);
	});

	it("allows a property or key that is merely named db", async () => {
		expect(await findings(inTransaction("await tx.insert(t).values({ db: other.db });"))).toEqual(
			[],
		);
	});

	it("does not apply outside the server code", async () => {
		expect(await findings(inTransaction("await db.select();"), "apps/web/src/app/x.ts")).toEqual(
			[],
		);
	});
});

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inject, type ProvidedContext } from "vitest";

// What a `*.db.test.ts` file needs from the local stack (#382; ADR-0007 section 6): its settings,
// and a player of its own. Every value here is a secret in output: never print one.

/** The local stack's settings: two connection strings, the Supabase API's URL and its key. */
export type Stack = NonNullable<ProvidedContext["stack"]>;

/**
 * The local stack's settings, as the `db` project's global setup (./stackSetup.ts) found them. Throws
 * outside that project, since only it provides them: a stack test belongs in a `*.db.test.ts` file.
 */
export function readStack(): Stack {
	const stack = inject("stack");
	if (stack === undefined) {
		throw new Error(
			"Only Vitest's db project provides the stack: name the file *.db.test.ts, and run pnpm db:start, pnpm db:reset, then pnpm db:env.",
		);
	}

	return stack;
}

/**
 * Makes a new player, by inserting an `auth.users` row through the admin connection (postgres),
 * and returns its id. Each test makes its own, so tests share no farm and nothing is truncated
 * (ADR-0007 section 6, "Isolation by farm"). Not a real sign-up: those belong to the auth module's
 * tests and the acceptance tests.
 */
export async function createPlayer(): Promise<string> {
	const admin = postgres(readStack().adminDatabaseUrl, { max: 1 });
	const id = randomUUID();
	try {
		await admin`insert into auth.users (id) values (${id})`;
	} finally {
		await admin.end();
	}

	return id;
}

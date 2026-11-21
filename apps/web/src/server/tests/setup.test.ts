import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { findStack } from "./setup";

// The db project's global setup (ADR-0007 section 6, "No conditional skips"): without a stack it
// fails and says how to start one, and its message never holds a value from the environment. These
// run in the unit project, against a local TCP server standing in for the stack's Postgres port.
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

describe("findStack", () => {
	it("refuses a missing variable, naming pnpm db:start but no value", async () => {
		const env = withVariable(stackEnv(await listen()), "SUPABASE_PUBLISHABLE_KEY", undefined);

		const found = findStack(env);

		await expect(found).rejects.toThrow("SUPABASE_PUBLISHABLE_KEY");
		await expect(found).rejects.toThrow("pnpm db:start");
		await expect(found).rejects.not.toThrow("127.0.0.1");
	});

	it("refuses a stack whose database doesn't answer, naming pnpm db:start but no value", async () => {
		const port = await listen();
		await Promise.all(servers.splice(0).map(closeServer));

		const found = findStack(stackEnv(port));

		await expect(found).rejects.toThrow("pnpm db:start");
		await expect(found).rejects.not.toThrow("not-a-real-key");
	});

	it("refuses an admin URL it can't read, naming the variable but not its value", async () => {
		const env = withVariable(stackEnv(await listen()), "ADMIN_DATABASE_URL", "postgres-on-tuesday");

		const found = findStack(env);

		await expect(found).rejects.toThrow("ADMIN_DATABASE_URL");
		await expect(found).rejects.not.toThrow("postgres-on-tuesday");
	});

	it("gives the stack's settings once its database answers", async () => {
		const port = await listen();

		expect(await findStack(stackEnv(port))).toStrictEqual({
			databaseUrl: `postgresql://game_api@127.0.0.1:${String(port)}/postgres`,
			adminDatabaseUrl: `postgresql://postgres@127.0.0.1:${String(port)}/postgres`,
			supabaseUrl: "http://127.0.0.1:55321",
			supabasePublishableKey: "not-a-real-key",
		});
	});
});

type Env = Record<string, string | undefined>;

// The four variables `pnpm db:env` writes, with no password in either URL. Environment names are
// UPPER_SNAKE, a shape the naming rule doesn't allow as object keys, so they're built as pairs
// (as config/tests/env.ts does).
function stackEnv(port: number): Env {
	return Object.fromEntries([
		["DATABASE_URL", `postgresql://game_api@127.0.0.1:${String(port)}/postgres`],
		["ADMIN_DATABASE_URL", `postgresql://postgres@127.0.0.1:${String(port)}/postgres`],
		["SUPABASE_URL", "http://127.0.0.1:55321"],
		["SUPABASE_PUBLISHABLE_KEY", "not-a-real-key"],
	]);
}

function withVariable(env: Env, name: string, value: string | undefined): Env {
	return Object.fromEntries([...Object.entries(env), [name, value]]);
}

async function listen(): Promise<number> {
	const server = createServer((socket) => socket.end());
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("No TCP port.");

	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) =>
		server.close(() => {
			resolve();
		}),
	);
}

import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { ProvidedContext } from "vitest";
import type { TestProject } from "vitest/node";

// The global setup of Vitest's `db` project (vitest.config.mts; ADR-0007 section 6). It runs once,
// and only when a `*.db.test.ts` file is queued, so a run of the unit project needs no stack. With
// no stack it throws, which fails the run: a `db` test never skips (CONSTRAINTS.md, "Guarding the
// bar"). The values come from the environment, or else from `.env`, which `pnpm db:env` writes, and
// reach the tests through provide/inject (`readStack` in ./stack.ts). No message holds a value.

/** The environment the stack is read from: `process.env`, or a plain object in tests. */
type Env = Readonly<Record<string, string | undefined>>;

const startStack = "run pnpm db:start, then pnpm db:reset and pnpm db:env (supabase/README.md).";

// How long the database port may take to accept a connection before the stack counts as down.
const connectTimeoutMs = 2_000;

export async function setup(project: TestProject): Promise<void> {
	const env = { ...readEnvFile(join(project.config.root, ".env")), ...process.env };
	project.provide("stack", await findStack(env));
}

/**
 * Reads the local stack's settings from `env` and checks that its database accepts a TCP
 * connection. Throws, naming `pnpm db:start`, when a variable is missing or nothing answers.
 */
export async function findStack(env: Env): Promise<NonNullable<ProvidedStack>> {
	const stack = {
		databaseUrl: readVariable(env, "DATABASE_URL"),
		adminDatabaseUrl: readVariable(env, "ADMIN_DATABASE_URL"),
		supabaseUrl: readVariable(env, "SUPABASE_URL"),
		supabasePublishableKey: readVariable(env, "SUPABASE_PUBLISHABLE_KEY"),
	};
	if (!URL.canParse(stack.adminDatabaseUrl)) {
		throw new Error(`The db tests can't read ADMIN_DATABASE_URL as a URL: ${startStack}`);
	}

	const { hostname, port } = new URL(stack.adminDatabaseUrl);
	try {
		await probe(hostname.replace(/^\[|\]$/g, ""), Number(port || 5432));
	} catch (error) {
		throw new Error(
			`The db tests need the local Supabase stack, and its database doesn't answer: ${startStack}`,
			{
				cause: error,
			},
		);
	}

	return stack;
}

type ProvidedStack = ProvidedContext["stack"];

function readVariable(env: Env, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") {
		throw new Error(
			`The db tests need the local Supabase stack, and ${name} is missing: ${startStack}`,
		);
	}

	return value;
}

// `.env` is optional: CI and a shell may set the variables themselves. Any other read error throws.
function readEnvFile(path: string): Env {
	try {
		return parseEnv(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

// Resolves once something accepts a TCP connection at host:port; rejects on an error or timeout.
async function probe(host: string, port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = connect({ host, port, timeout: connectTimeoutMs });
		socket.once("connect", () => {
			socket.destroy();
			resolve();
		});
		socket.once("timeout", () => {
			socket.destroy();
			reject(new Error(`No answer within ${String(connectTimeoutMs)} ms.`));
		});
		socket.once("error", reject);
	});
}

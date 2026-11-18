import "server-only";

/** The server's settings, read from the environment once per process (#329, decision 2). */
export interface Config {
	/** The Postgres connection string. A secret: never logged, never sent to a client. */
	databaseUrl: string;
}

/** The environment the config is read from: `process.env` in a route, a plain object in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads the config from `env`. A missing or empty variable is a config error: the deployment is
 * broken, not the request, so it throws, and the message names the variable but never a value
 * (CLAUDE.md, secrets).
 */
export function readConfig(env: Env): Config {
	return { databaseUrl: readVariable(env, "DATABASE_URL") };
}

function readVariable(env: Env, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") {
		throw new Error(`Config error: the environment variable ${name} is missing.`);
	}

	return value;
}

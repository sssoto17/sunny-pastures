import "server-only";

import { readConfig } from "@/server/config";

import { once } from "./once";

/** What the routes call (#329, decision 2). Each game ticket adds its entry here. */
export interface Api {
	health(): Health;
}

/** The body of `GET /api/health`. */
export interface Health {
	status: "ok";
}

const getBuiltApi = once(() => createApi(process.env));

/**
 * The composition root (#329, decisions 2 and 5): the one place that wires the server modules
 * together, and the only module a `route.ts` imports. It builds on the first request and then
 * once per process, never at import, so `next build` needs no `DATABASE_URL`. Throws a config
 * error while the environment is incomplete. Tests call `createApi` instead.
 */
export function getApi(): Api {
	return getBuiltApi();
}

/** Builds the graph from an environment: config → db → rules → store, as each module lands. */
export function createApi(env: Readonly<Record<string, string | undefined>>): Api {
	// The config is the first link (`createDb(config)` takes it, #329 decision 2). Reading it now
	// makes a deployment with a missing variable fail its health check, not its first game request.
	readConfig(env);
	return { health: () => ({ status: "ok" }) };
}

import "server-only";

import { sliceContent } from "@sunny-pastures/sim";

import { createAuth, type Auth } from "@/server/auth";
import { readConfig, type Env } from "@/server/config";
import { createDb } from "@/server/db";
import { createRules } from "@/server/rules";

import { memoise } from "./memoise";

/** What the routes call (#329, decision 2). Each game ticket adds its entry here. */
export interface Api {
	health(): Health;
	/** The player behind a request, or `{ ok: false }` for a 401 (#332, decision 4). */
	readPlayer: Auth["readPlayer"];
}

/** The body of `GET /api/health`. */
export interface Health {
	status: "ok";
}

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
export function createApi(env: Env): Api {
	// The config is the first link (`createDb(config)` takes it, #329 decision 2). Reading it now
	// makes a deployment with a missing variable fail its health check, not its first game request.
	const config = readConfig(env);
	// Built here, so once per process with the graph: one Supabase client and one JWKS cache (#332
	// decision 4).
	const auth = createAuth(config);
	// Built here too, so once per process through getApi; postgres.js connects on the first query,
	// so building it touches no network (#372). The store takes it when it lands (#373).
	createDb(config);
	// Once per process with the graph; the store takes newFarm and replay when it lands (#373).
	createRules(sliceContent);
	return { health: () => ({ status: "ok" }), readPlayer: auth.readPlayer };
}

// Read only when getApi is first called, so it can sit below the interface.
const getBuiltApi = memoise(() => createApi(process.env));

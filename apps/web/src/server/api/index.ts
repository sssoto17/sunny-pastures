import "server-only";

import { sliceContent } from "@sunny-pastures/sim";

import { createAuth } from "@/server/auth";
import { readConfig, type Env } from "@/server/config";
import { createDb } from "@/server/db";
import { createRules, type Rules } from "@/server/rules";
import { createStore } from "@/server/store";

import { createFarmRoutes, type Connection, type FarmRoutes } from "./farmRoutes";
import { memoise } from "./memoise";

/**
 * What the routes call (#329, decision 2). Each game ticket adds its entry here. `getFarm` and
 * `postAction` take the request and return the whole response, so a `route.ts` calls one function
 * and holds no logic (#397).
 */
export interface Api extends FarmRoutes {
	health(): Health;
}

/** The body of `GET /api/health`. */
export interface Health {
	status: "ok";
}

/**
 * The composition root (#329, decisions 2 and 5): the one place that wires the server modules
 * together, and the only module a `route.ts` imports. Nothing that reads the environment is built
 * here: the graph is built on the first request and then once per process, never at import, so
 * `next build` needs no `DATABASE_URL`. While the environment is incomplete, the game routes answer
 * the contract's 500 and `health()` throws the config error (#470). Tests call `createApi` with
 * their own `Connector`, never `getApi` (ADR-0007, section 2).
 */
export function getApi(): Api {
	return getBuiltApi();
}

/**
 * Builds the parts that need the environment, from the rules the process's one sim and rules
 * version came from. `createApi` calls it on the first request that needs it (#543): the seam where
 * a test swaps the database-backed store and auth for an in-memory store and a fixed player.
 */
export type Connector = (rules: Rules) => Connection;

/**
 * The real chain, config → db → store → auth, read from `env` each time it is called, so a
 * variable set after a failed attempt is seen by the next one (#470).
 */
export function connectFromEnv(env: Env): Connector {
	return ({ newFarm, replay, rulesVersion }) => {
		// The config is the first link (`createDb(config)` takes it, #329 decision 2).
		const config = readConfig(env);
		// postgres.js connects on the first query, so building the client touches no network (#372).
		const db = createDb(config);
		const store = createStore({ db, newFarm, replay, rulesVersion });
		// One Supabase client and one JWKS cache per process (#332 decision 4).
		const { readPlayer } = createAuth(config);
		return { readPlayer, store };
	};
}

/**
 * Wires the graph: the rules and the routes, which read no environment, plus the connection that
 * `connect` builds on the first call that needs it and memoises.
 */
export function createApi(connect: Connector): Api {
	// Once per process with the graph (ADR-0007, section 2): one sim, one rules version.
	const rules = createRules(sliceContent);
	// A build that throws isn't kept, so a request after the variable is set connects (#470).
	const connection = memoise(() => connect(rules));
	const routes = createFarmRoutes({
		connect: connection,
		rules,
		// Server time is taken here and nowhere else (T1, MUST-11.1); `game/` reads it once per action.
		serverTime: () => Date.now(),
		logError: (error) => {
			// The server's log only (Vercel's function logs); a response never carries it.
			console.error("Game API error:", error);
		},
	});
	return {
		health: () => {
			// Connecting reads the config, so a deployment with a missing variable fails its health
			// check, not only its first game request.
			connection();
			return { status: "ok" };
		},
		...routes,
	};
}

// Read only when getApi is first called, so it can sit below the interface.
const getBuiltApi = memoise(() => createApi(connectFromEnv(process.env)));

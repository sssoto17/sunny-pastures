import "server-only";

import { sliceContent } from "@sunny-pastures/sim";

import { createAuth, type Auth } from "@/server/auth";
import { readConfig, type Env } from "@/server/config";
import { createDb } from "@/server/db";
import { createRules } from "@/server/rules";
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
	/** The player behind a request, or `{ ok: false }` for a 401 (#332, decision 4). */
	readPlayer: Auth["readPlayer"];
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
 * the contract's 500 and `health()` throws the config error (#470). Tests call `createApi`.
 */
export function getApi(): Api {
	return getBuiltApi();
}

/**
 * Wires the graph from an environment: config → db → store → auth, built by `connect` on the first
 * call that needs it and memoised, plus the rules and the routes, which read no environment.
 */
export function createApi(env: Env): Api {
	// Once per process with the graph (ADR-0007, section 2): one sim, one rules version.
	const rules = createRules(sliceContent);
	// A build that throws isn't kept, so a request after the variable is set connects (#470).
	const connect = memoise((): Connection => {
		// The config is the first link (`createDb(config)` takes it, #329 decision 2).
		const config = readConfig(env);
		// postgres.js connects on the first query, so building the client touches no network (#372).
		const db = createDb(config);
		const store = createStore({ db, newFarm: rules.newFarm, replay: rules.replay });
		// One Supabase client and one JWKS cache per process (#332 decision 4).
		const { readPlayer } = createAuth(config);
		return { readPlayer, store };
	});
	const routes = createFarmRoutes({
		connect,
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
			connect();
			return { status: "ok" };
		},
		readPlayer: async (request) => await connect().readPlayer(request),
		...routes,
	};
}

// Read only when getApi is first called, so it can sit below the interface.
const getBuiltApi = memoise(() => createApi(process.env));

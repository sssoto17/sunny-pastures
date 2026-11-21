import "server-only";

import { sliceContent } from "@sunny-pastures/sim";

import { createAuth, type Auth } from "@/server/auth";
import { readConfig, type Env } from "@/server/config";
import { createDb } from "@/server/db";
import { createRules } from "@/server/rules";
import { createStore } from "@/server/store";

import { createFarmRoutes, type FarmRoutes } from "./farmRoutes";
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
 * together, and the only module a `route.ts` imports. It builds on the first request and then
 * once per process, never at import, so `next build` needs no `DATABASE_URL`. Throws a config
 * error while the environment is incomplete. Tests call `createApi` instead.
 */
export function getApi(): Api {
	return getBuiltApi();
}

/** Builds the graph from an environment: config → db → rules → store → auth → the routes. */
export function createApi(env: Env): Api {
	// The config is the first link (`createDb(config)` takes it, #329 decision 2). Reading it now
	// makes a deployment with a missing variable fail its health check, not its first game request.
	const config = readConfig(env);
	// postgres.js connects on the first query, so building the client touches no network (#372).
	const db = createDb(config);
	// Once per process with the graph (ADR-0007, section 2): one sim, one rules version.
	const rules = createRules(sliceContent);
	const store = createStore({ db, newFarm: rules.newFarm, replay: rules.replay });
	// One Supabase client and one JWKS cache per process (#332 decision 4).
	const auth = createAuth(config);
	const routes = createFarmRoutes({
		readPlayer: auth.readPlayer,
		store,
		rules,
		// Server time is taken here and nowhere else (T1, MUST-11.1); `game/` reads it once per action.
		serverTime: () => Date.now(),
		logError: (error) => {
			// The server's log only (Vercel's function logs); a response never carries it.
			console.error("Game API error:", error);
		},
	});
	return { health: () => ({ status: "ok" }), readPlayer: auth.readPlayer, ...routes };
}

// Read only when getApi is first called, so it can sit below the interface.
const getBuiltApi = memoise(() => createApi(process.env));

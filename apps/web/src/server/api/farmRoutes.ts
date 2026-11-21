import type { Auth } from "@/server/auth";
import { loadFarm, submitAction, type Busy, type GameDeps } from "@/server/game";
import {
	buildErrorResponse,
	buildJsonResponse,
	readActionRequest,
	readFarmRequest,
	type Problem,
	type ResponseMeta,
} from "@/server/http";
import type { GameStore } from "@/server/store";
import { createTiming } from "@/server/timing";

/**
 * What the game routes are built from, once per process in `createApi`: `game/`'s deps but the
 * per-request `timing`, which each request makes for itself (#394), and the parts that need the
 * environment, which `connect` builds inside each request's handling (#470).
 */
export interface FarmRouteDeps extends Omit<GameDeps, "timing" | "store"> {
	/** The server's log, for a store error behind a 503 and a bug behind a 500. Never a body. */
	readonly logError: (error: unknown) => void;
	/**
	 * The parts of the graph that read the environment, built on the first request and memoised by
	 * `api/` (#329, decision 5). Throws a config error while a variable is missing (a deploy without
	 * it): each request calls it inside the same try as its response mapping, so that error is the
	 * contract's 500 with every header, not Next's bare 500 (#470).
	 */
	readonly connect: () => Connection;
}

/** What `connect` builds from the environment: one auth client and one store per process. */
export interface Connection {
	readonly readPlayer: Auth["readPlayer"];
	readonly store: GameStore;
}

/** The two game routes, each from a `Request` to its `Response` (ADR-0007, section 3). */
export interface FarmRoutes {
	/** `GET /api/farm`: 200 `{ farm }`. Never writes (MUST-11.5). */
	getFarm(request: Request): Promise<Response>;
	/** `POST /api/farm/actions`: 200 `{ answer, farm }`, or 422 with the sim's reason. */
	postAction(request: Request): Promise<Response>;
}

/**
 * The game routes' handlers (#397). Each runs in the order #332 (Q4) sets: `readPlayer` first, so
 * any failure is 401 and says nothing about the request; then `http/`'s checks (415 → 413 → 400);
 * then `game/`. No store call happens before the checks pass. The farm is the verified `PlayerId`
 * only: a query on either route is 400, and the body's exact keys leave no room for a `farmId` (T5).
 * Every response, errors included, is built by `http/`, so it carries `Rules-Version`,
 * `Cache-Control: no-store` and `Server-Timing`, rendered after `total` is recorded (MUST-19.1).
 */
export function createFarmRoutes(deps: FarmRouteDeps): FarmRoutes {
	return {
		getFarm: async (request) =>
			await respond(deps, async (readPlayer, game) => {
				const player = await readPlayer(request);
				if (!player.ok) return unauthorized;

				const checked = readFarmRequest(request);
				if (!checked.ok) return { ok: false, problem: checked.problem };

				const loaded = await loadFarm(game, player.playerId);
				if (loaded.kind === "busy") return answerBusy(deps, loaded);

				return { ok: true, body: { farm: loaded.farm } };
			}),

		postAction: async (request) =>
			await respond(deps, async (readPlayer, game) => {
				const player = await readPlayer(request);
				if (!player.ok) return unauthorized;

				const checked = await readActionRequest(request);
				if (!checked.ok) return { ok: false, problem: checked.problem };

				// After the body's checks, so 415 and 413 still come first: a query is a 400 (T5).
				const query = readFarmRequest(request);
				if (!query.ok) return { ok: false, problem: query.problem };

				const result = await submitAction(game, player.playerId, checked.value);
				switch (result.kind) {
					case "answered":
						return { ok: true, body: { answer: result.answer, farm: result.farm } };
					case "refused":
						return { ok: false, problem: { error: "refused", reason: result.reason } };
					case "busy":
						return answerBusy(deps, result);
				}
			}),
	};
}

/** A handler's result before it becomes a `Response`: a 200 body, or the problem to send. */
type Outcome =
	{ readonly ok: true; readonly body: object } | { readonly ok: false; readonly problem: Problem };

const unauthorized: Outcome = { ok: false, problem: { error: "unauthorized" } };

/**
 * Connects, runs one request's handler inside `total`, then builds its response, so the header
 * holds `total` (#394). A throw, a config error from `connect` included (#470), is logged and
 * answered with 500's fixed message, so no stack trace, SQL or variable name reaches the body
 * (ADR-0007, section 3, "Errors").
 */
async function respond(
	deps: FarmRouteDeps,
	handle: (readPlayer: Connection["readPlayer"], game: GameDeps) => Promise<Outcome>,
): Promise<Response> {
	// One recorder per request (#394): it accumulates this request's phases only.
	const timing = createTiming();
	// The rules need no environment, so even a config error's 500 carries their version.
	const meta: ResponseMeta = {
		rulesVersion: deps.rules.rulesVersion,
		serverTiming: () => timing.renderServerTiming(),
	};

	let outcome: Outcome;
	try {
		outcome = await timing.withTiming("total", async () => {
			const { readPlayer, store } = deps.connect();
			const game: GameDeps = { store, rules: deps.rules, timing, serverTime: deps.serverTime };
			return await handle(readPlayer, game);
		});
	} catch (error) {
		deps.logError(error);
		outcome = { ok: false, problem: { error: "internal" } };
	}

	return outcome.ok
		? buildJsonResponse(outcome.body, meta)
		: buildErrorResponse(outcome.problem, meta);
}

/** 503 `busy`; a store error goes to the server's log, never to the body (ADR-0006, section 8). */
function answerBusy(deps: FarmRouteDeps, busy: Busy): Outcome {
	if (busy.cause === "store") deps.logError(busy.error);

	return { ok: false, problem: { error: "busy" } };
}

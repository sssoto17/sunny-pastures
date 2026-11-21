import type { Auth } from "@/server/auth";
import { loadFarm, type Busy, type GameDeps } from "@/server/game";
import {
	buildErrorResponse,
	buildJsonResponse,
	readFarmRequest,
	type Problem,
	type ResponseMeta,
} from "@/server/http";
import { createTiming } from "@/server/timing";

/**
 * What the game routes are built from, once per process in `createApi`: `game/`'s deps but the
 * per-request `timing`, which each request makes for itself (#394).
 */
export interface FarmRouteDeps extends Omit<GameDeps, "timing"> {
	readonly readPlayer: Auth["readPlayer"];
	/** The server's log, for a store error behind a 503 and a bug behind a 500. Never a body. */
	readonly logError: (error: unknown) => void;
}

/** The game routes, each from a `Request` to its `Response` (ADR-0007, section 3). */
export interface FarmRoutes {
	/** `GET /api/farm`: 200 `{ farm }`. Never writes (MUST-11.5). */
	getFarm(request: Request): Promise<Response>;
}

/**
 * The game routes' handlers (#397). Each runs in the order #332 (Q4) sets: `readPlayer` first, so
 * any failure is 401 and says nothing about the request; then `http/`'s checks (415 → 413 → 400);
 * then `game/`. No store call happens before the checks pass. The farm is the verified `PlayerId`
 * only: a query naming a farm is 400 (T5).
 * Every response, errors included, is built by `http/`, so it carries `Rules-Version`,
 * `Cache-Control: no-store` and `Server-Timing`, rendered after `total` is recorded (MUST-19.1).
 */
export function createFarmRoutes(deps: FarmRouteDeps): FarmRoutes {
	return {
		getFarm: async (request) =>
			await respond(deps, async (game) => {
				const player = await deps.readPlayer(request);
				if (!player.ok) return unauthorized;

				const checked = readFarmRequest(request);
				if (!checked.ok) return { ok: false, problem: checked.problem };

				const loaded = await loadFarm(game, player.playerId);
				if (loaded.kind === "busy") return answerBusy(deps, loaded);

				return { ok: true, body: { farm: loaded.farm } };
			}),
	};
}

/** A handler's result before it becomes a `Response`: a 200 body, or the problem to send. */
type Outcome =
	{ readonly ok: true; readonly body: object } | { readonly ok: false; readonly problem: Problem };

const unauthorized: Outcome = { ok: false, problem: { error: "unauthorized" } };

/**
 * Runs one request's handler inside `total`, then builds its response, so the header holds
 * `total` (#394). A throw is a bug: it is logged and answered with 500's fixed message, so no
 * stack trace or SQL reaches the body (ADR-0007, section 3, "Errors").
 */
async function respond(
	deps: FarmRouteDeps,
	handle: (game: GameDeps) => Promise<Outcome>,
): Promise<Response> {
	// One recorder per request (#394): it accumulates this request's phases only.
	const timing = createTiming();
	const game: GameDeps = {
		store: deps.store,
		rules: deps.rules,
		timing,
		serverTime: deps.serverTime,
	};
	const meta: ResponseMeta = {
		rulesVersion: deps.rules.rulesVersion,
		serverTiming: () => timing.renderServerTiming(),
	};

	let outcome: Outcome;
	try {
		outcome = await timing.withTiming("total", async () => await handle(game));
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

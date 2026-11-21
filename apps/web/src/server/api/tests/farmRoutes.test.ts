import { describe, expect, it, vi } from "vitest";

import { sliceContent, stateHash, type Action } from "@sunny-pastures/sim";

import type { PlayerId, PlayerResult } from "@/server/auth";
import { createRules } from "@/server/rules";
import type { GameStore } from "@/server/store";

import { createMemoryStore } from "../../store/tests/memoryStore";
import { createFarmRoutes, type Connection, type FarmRouteDeps } from "../farmRoutes";

const rules = createRules(sliceContent);
const plantWheat: Action = { type: "plant", plot: 0, crop: "wheat" };
// The farm the routes' clock starts at: 1 s after the epoch, as in game/'s tests.
const serverTime = 1_000;

describe("GET /api/farm (getFarm)", () => {
	it("answers 200 with the player's farm and the headers every response carries", async () => {
		const { routes, playerId } = setUp();

		const response = await routes.getFarm(buildGetRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			farm: { seq: 0, at: 0, state: rules.newFarm(playerId), rulesVersion: 1 },
		});
		expectContractHeaders(response, ["load", "total"]);
	});

	it("answers 401 before any other check when the player can't be read (#332, Q4)", async () => {
		const { routes, store } = setUp({ player: { ok: false } });

		const response = await routes.getFarm(buildGetRequest("?farm=other"));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: "unauthorized",
			message: "The request has no valid session. Sign in again.",
		});
		expectContractHeaders(response, ["total"]);
		expectNoStoreCall(store);
	});

	it("answers 400 to a query naming a farm, and reads nothing (T5)", async () => {
		const { routes, store } = setUp();

		const response = await routes.getFarm(buildGetRequest(`?farm=${crypto.randomUUID()}`));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "bad_request" });
		expectContractHeaders(response, ["total"]);
		expectNoStoreCall(store);
	});

	it("answers 503 busy and logs the cause when the store throws (ADR-0006, section 8)", async () => {
		const error = new Error("Store error: rules version 2 is unknown.");
		const { routes, store, logged } = setUp();
		vi.spyOn(store, "load").mockRejectedValue(error);

		const response = await routes.getFarm(buildGetRequest());

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("1");
		expect(await response.json()).toEqual({
			error: "busy",
			message: "The farm is busy. Try again in a moment.",
		});
		expectContractHeaders(response, ["load", "total"]);
		expect(logged).toEqual([error]);
	});

	it("answers 500 with a fixed message, and logs the error, when something throws", async () => {
		const error = new Error("secret detail: SELECT * FROM actions");
		const { routes, logged } = setUp({ readPlayer: () => Promise.reject(error) });

		const response = await routes.getFarm(buildGetRequest());

		expect(response.status).toBe(500);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({
			error: "internal",
			message: "Something went wrong on the server. Try again.",
		});
		expect(body).not.toContain("secret");
		expectContractHeaders(response, ["total"]);
		expect(logged).toEqual([error]);
	});

	it("answers the contract's 500, and logs the error, when connecting throws a config error (#470)", async () => {
		const error = new Error("Config error: DATABASE_URL is missing.");
		const { routes, logged } = setUp({
			connect: () => {
				throw error;
			},
		});

		const response = await routes.getFarm(buildGetRequest());

		expect(response.status).toBe(500);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({
			error: "internal",
			message: "Something went wrong on the server. Try again.",
		});
		expect(body).not.toContain("DATABASE_URL");
		expectContractHeaders(response, ["total"]);
		expect(logged).toEqual([error]);
	});
});

describe("POST /api/farm/actions (postAction)", () => {
	it("answers 200 with the answer and the committed farm, timing every phase", async () => {
		const { routes, playerId } = setUp();

		const response = await routes.postAction(
			buildPostRequest({ action: plantWheat, expectedSeq: 0 }),
		);

		expect(response.status).toBe(200);
		const applied = rules.sim.apply(rules.newFarm(playerId), plantWheat, serverTime);
		if (!applied.ok) throw new Error("Expected the slice's rules to accept planting wheat.");

		expect(await response.json()).toEqual({
			answer: { seq: 1, hash: stateHash(applied.state), rebased: false, retries: 0 },
			farm: { seq: 1, at: serverTime, state: applied.state, rulesVersion: 1 },
		});
		expectContractHeaders(response, ["load", "sim", "commit", "total"]);
	});

	it("answers a resent key with its first answer unchanged (MUST-13.2)", async () => {
		const { routes } = setUp();
		const key = crypto.randomUUID();
		const first = await routes.postAction(
			buildPostRequest({ action: plantWheat, expectedSeq: 0 }, { key }),
		);

		const resent = await routes.postAction(
			buildPostRequest({ action: plantWheat, expectedSeq: 0 }, { key }),
		);

		expect(resent.status).toBe(200);
		const [firstBody, resentBody] = (await Promise.all([first.json(), resent.json()])) as [
			{ answer: unknown },
			{ answer: unknown },
		];
		expect(resentBody.answer).toEqual(firstBody.answer);
	});

	it("checks the player before the body: 401 even for a request that is wrong in every way", async () => {
		const { routes, store } = setUp({ player: { ok: false } });

		const response = await routes.postAction(
			buildPostRequest("x".repeat(5000), { contentType: "text/plain", key: "not-a-uuid" }),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: "unauthorized" });
		expectNoStoreCall(store);
	});

	it.each([
		{
			name: "a body that isn't JSON → 415",
			request: () => buildPostRequest("x".repeat(5000), { contentType: "text/plain" }),
			status: 415,
			error: "unsupported_media_type",
		},
		{
			name: "a body over 4 KiB → 413",
			request: () => buildPostRequest(`{"pad":"${"x".repeat(5000)}"}`, { key: "not-a-uuid" }),
			status: 413,
			error: "too_large",
		},
		{
			name: "a missing Idempotency-Key → 400",
			request: () => buildPostRequest({ action: plantWheat, expectedSeq: 0 }, { key: null }),
			status: 400,
			error: "bad_request",
		},
		{
			name: "a body naming a farm (farmId) → 400 (T5)",
			request: () =>
				buildPostRequest({ action: plantWheat, expectedSeq: 0, farmId: crypto.randomUUID() }),
			status: 400,
			error: "bad_request",
		},
		{
			name: "a query naming a farm (?farm=) → 400 (T5)",
			request: () =>
				buildPostRequest(
					{ action: plantWheat, expectedSeq: 0 },
					{ query: `?farm=${crypto.randomUUID()}` },
				),
			status: 400,
			error: "bad_request",
		},
		{
			name: "an action carrying a time → 400 (T1)",
			request: () => buildPostRequest({ action: { ...plantWheat, at: 0 }, expectedSeq: 0 }),
			status: 400,
			error: "bad_request",
		},
	])("refuses $name, with no store call", async ({ request, status, error }) => {
		const { routes, store } = setUp();

		const response = await routes.postAction(request());

		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ error });
		expectContractHeaders(response, ["total"]);
		expectNoStoreCall(store);
	});

	it("answers 422 with the sim's reason word for word when the rules refuse (MUST-12.3)", async () => {
		const { routes, playerId } = setUp();
		const offTheFarm: Action = { ...plantWheat, plot: 9999 };
		const refused = rules.sim.apply(rules.newFarm(playerId), offTheFarm, serverTime);
		if (refused.ok) throw new Error("Expected the slice's rules to refuse a plot off the farm.");

		const response = await routes.postAction(
			buildPostRequest({ action: offTheFarm, expectedSeq: 0 }),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ error: "refused", message: refused.reason });
		expectContractHeaders(response, ["load", "sim", "total"]);
	});

	it("answers 503 busy after the 4th conflict, with Retry-After (MUST-13.3)", async () => {
		// Exactly four scripted conflicts: a fifth commit would write, so a retry too many is a 200.
		const { routes, store, logged } = setUp({ conflicts: [true, true, true, true] });

		const response = await routes.postAction(
			buildPostRequest({ action: plantWheat, expectedSeq: 0 }),
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("1");
		expect(await response.json()).toMatchObject({ error: "busy" });
		expect(store.commit).toHaveBeenCalledTimes(4);
		expectContractHeaders(response, ["load", "sim", "commit", "total"]);
		expect(logged).toEqual([]);
	});

	it("answers 503 busy and logs the cause when the store throws", async () => {
		const error = new Error("Store error: connection lost.");
		const { routes, store, logged } = setUp();
		vi.spyOn(store, "load").mockRejectedValue(error);

		const response = await routes.postAction(
			buildPostRequest({ action: plantWheat, expectedSeq: 0 }),
		);

		expect(response.status).toBe(503);
		expect(logged).toEqual([error]);
	});

	it("answers 500 with a fixed message when the loop throws a bug", async () => {
		const error = new Error("a bug in apply");
		const { routes, logged } = setUp({
			rules: {
				...rules,
				sim: {
					...rules.sim,
					apply: () => {
						throw error;
					},
				},
			},
		});

		const response = await routes.postAction(
			buildPostRequest({ action: plantWheat, expectedSeq: 0 }),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "internal",
			message: "Something went wrong on the server. Try again.",
		});
		expectContractHeaders(response, ["load", "sim", "total"]);
		expect(logged).toEqual([error]);
	});
});

interface SetUpOptions {
	readonly player?: PlayerResult;
	readonly readPlayer?: Connection["readPlayer"];
	/** The in-memory store's script: entry i makes the i-th commit that would write a conflict. */
	readonly conflicts?: readonly boolean[];
	readonly rules?: FarmRouteDeps["rules"];
	readonly connect?: FarmRouteDeps["connect"];
}

/**
 * Routes over the in-memory store that the store contract holds to B100 (ADR-0007, section 6;
 * #470), with a spy on each store method, so a test can see which calls a route made.
 */
function setUp(options: SetUpOptions = {}): {
	routes: ReturnType<typeof createFarmRoutes>;
	store: GameStore;
	playerId: PlayerId;
	logged: unknown[];
} {
	const playerId = crypto.randomUUID() as PlayerId;
	const player = options.player ?? { ok: true, playerId };
	const store = createMemoryStore({
		newFarm: rules.newFarm,
		replay: rules.replay,
		conflicts: options.conflicts ?? [],
	});
	for (const method of ["load", "processed", "commit"] as const) vi.spyOn(store, method);
	const readPlayer = options.readPlayer ?? (() => Promise.resolve(player));
	const logged: unknown[] = [];
	const routes = createFarmRoutes({
		connect: options.connect ?? (() => ({ readPlayer, store })),
		rules: options.rules ?? rules,
		serverTime: () => serverTime,
		logError: (error) => {
			logged.push(error);
		},
	});
	return { routes, store, playerId, logged };
}

function buildGetRequest(query = ""): Request {
	return new Request(`http://app.test/api/farm${query}`, { headers: buildTokenHeaders() });
}

interface PostOptions {
	readonly contentType?: string;
	readonly key?: string | null;
	readonly query?: string;
}

function buildPostRequest(body: unknown, options: PostOptions = {}): Request {
	const headers = buildTokenHeaders();
	headers.set("Content-Type", options.contentType ?? "application/json");
	const key = options.key === undefined ? crypto.randomUUID() : options.key;
	if (key !== null) headers.set("Idempotency-Key", key);
	return new Request(`http://app.test/api/farm/actions${options.query ?? ""}`, {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

// The token is never read here: `readPlayer` is a stub, and auth/ has its own tests (#371).
function buildTokenHeaders(): Headers {
	const headers = new Headers();
	headers.set("Authorization", "Bearer token");
	return headers;
}

/** The route made no store call: `http/`'s checks and auth come first (#332, Q4). */
function expectNoStoreCall(store: GameStore): void {
	expect(store.load).not.toHaveBeenCalled();
	expect(store.processed).not.toHaveBeenCalled();
	expect(store.commit).not.toHaveBeenCalled();
}

/** `Server-Timing` lists exactly `phases`, in order (MUST-19.1), beside the contract's headers. */
function expectContractHeaders(response: Response, phases: readonly string[]): void {
	const timing = response.headers.get("Server-Timing") ?? "";
	expect(timing.split(", ").map((metric) => metric.split(";")[0])).toEqual(phases);
	expect(timing).toMatch(/^(\w+;dur=\d+(\.\d+)?)(, \w+;dur=\d+(\.\d+)?)*$/);
	expect(response.headers.get("Rules-Version")).toBe("1");
	expect(response.headers.get("Cache-Control")).toBe("no-store");
}

import { describe, expect, it } from "vitest";

import { sliceContent } from "@sunny-pastures/sim";

import type { PlayerId, PlayerResult } from "@/server/auth";
import { createRules } from "@/server/rules";

import { createFarmRoutes, type FarmRouteDeps } from "../farmRoutes";
import { createFakeStore, type FakeStore, type FakeStoreOptions } from "./fakeStore";

const rules = createRules(sliceContent);
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
		expect(store.calls).toEqual([]);
	});

	it("answers 400 to a query naming a farm, and reads nothing (T5)", async () => {
		const { routes, store } = setUp();

		const response = await routes.getFarm(buildGetRequest(`?farm=${crypto.randomUUID()}`));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "bad_request" });
		expectContractHeaders(response, ["total"]);
		expect(store.calls).toEqual([]);
	});

	it("answers 503 busy and logs the cause when the store throws (ADR-0006, section 8)", async () => {
		const error = new Error("Store error: rules version 2 is unknown.");
		const { routes, logged } = setUp({ store: { error } });

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
});

interface SetUpOptions {
	readonly player?: PlayerResult;
	readonly readPlayer?: FarmRouteDeps["readPlayer"];
	readonly store?: FakeStoreOptions;
	readonly rules?: FarmRouteDeps["rules"];
}

function setUp(options: SetUpOptions = {}): {
	routes: ReturnType<typeof createFarmRoutes>;
	store: FakeStore;
	playerId: PlayerId;
	logged: unknown[];
} {
	const playerId = crypto.randomUUID() as PlayerId;
	const player = options.player ?? { ok: true, playerId };
	const store = createFakeStore(rules, options.store);
	const logged: unknown[] = [];
	const routes = createFarmRoutes({
		readPlayer: options.readPlayer ?? (() => Promise.resolve(player)),
		store,
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

// The token is never read here: `readPlayer` is a stub, and auth/ has its own tests (#371).
function buildTokenHeaders(): Headers {
	const headers = new Headers();
	headers.set("Authorization", "Bearer token");
	return headers;
}

/** `Server-Timing` lists exactly `phases`, in order (MUST-19.1), beside the contract's headers. */
function expectContractHeaders(response: Response, phases: readonly string[]): void {
	const timing = response.headers.get("Server-Timing") ?? "";
	expect(timing.split(", ").map((metric) => metric.split(";")[0])).toEqual(phases);
	expect(timing).toMatch(/^(\w+;dur=\d+(\.\d+)?)(, \w+;dur=\d+(\.\d+)?)*$/);
	expect(response.headers.get("Rules-Version")).toBe("1");
	expect(response.headers.get("Cache-Control")).toBe("no-store");
}

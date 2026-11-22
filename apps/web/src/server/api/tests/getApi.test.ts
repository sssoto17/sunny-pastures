import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthModule from "@/server/auth";
import type * as StoreModule from "@/server/store";

import { makeEnv } from "../../config/tests/env";
import type * as ApiModule from "../index";

// What the mocked store and auth below share with the tests: an error for the store's `load` to
// reject with when a test sets one, and the rules versions getApi() handed `createStore`.
const fakes = vi.hoisted(() => ({
	storeError: null as Error | null,
	storeRulesVersions: [] as number[],
	playerId: "0b5d1e7a-3c4f-4a2b-9e8d-7f6a5b4c3d2e",
}));

// Every request is this player's: a real token needs the stack's JWKS, and auth has its own tests
// (#371). The rest of the graph, rules, game/ and http/, is the real one.
vi.mock("@/server/auth", async (importOriginal) => ({
	...(await importOriginal<typeof AuthModule>()),
	createAuth: (): AuthModule.Auth => ({
		readPlayer: () =>
			Promise.resolve({ ok: true, playerId: fakes.playerId as AuthModule.PlayerId }),
	}),
}));

// The in-memory store that the store contract holds to B100 (ADR-0007, section 6; #470), built
// from the `newFarm` and `replay` getApi() hands B100, so these tests see the wiring and not
// postgres.js. B100 itself is tested in the db project.
vi.mock("@/server/store", async (importOriginal) => {
	const { createMemoryStore } = await import("../../store/tests/memoryStore");
	return {
		...(await importOriginal<typeof StoreModule>()),
		createStore: ({
			newFarm,
			replay,
			rulesVersion,
		}: StoreModule.StoreDeps): StoreModule.GameStore => {
			fakes.storeRulesVersions.push(rulesVersion);
			const store = createMemoryStore({ newFarm, replay });
			const { storeError } = fakes;
			if (storeError !== null) vi.spyOn(store, "load").mockRejectedValue(storeError);
			return store;
		},
	};
});

// getApi() memoises per module, so each test imports a fresh copy (#329, decision 5).
async function importApi(): Promise<typeof ApiModule> {
	vi.resetModules();
	return await import("../index");
}

beforeEach(() => {
	fakes.storeError = null;
	fakes.storeRulesVersions = [];
	for (const [name, value] of Object.entries(makeEnv("postgresql://db.test/farm"))) {
		vi.stubEnv(name, value);
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("getApi", () => {
	it("builds the graph from the process environment on the first call, then reuses it", async () => {
		const { getApi } = await importApi();

		const api = getApi();

		expect(getApi()).toBe(api);
		expect(api.health()).toEqual({ status: "ok" });
	});

	it("answers the contract's 500 while a variable is missing, and connects once it is set (#470)", async () => {
		const logged: unknown[][] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args);
		});
		const { getApi } = await importApi();
		vi.stubEnv("DATABASE_URL", "");

		const responses = await Promise.all([
			getApi().getFarm(new Request("http://app.test/api/farm")),
			getApi().postAction(buildPlantRequest()),
		]);

		for (const response of responses) {
			expect(response.status).toBe(500);
			const body = await response.text();
			expect(JSON.parse(body)).toEqual({
				error: "internal",
				message: "Something went wrong on the server. Try again.",
			});
			expect(body).not.toContain("DATABASE_URL");
			expect(response.headers.get("Rules-Version")).toBe("1");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(response.headers.get("Server-Timing")).toMatch(/^total;dur=[\d.]+$/);
		}
		expect(logged.map(([label]) => label)).toEqual(["Game API error:", "Game API error:"]);
		expect(String(logged[0]?.[1])).toMatch(/DATABASE_URL/);
		expect(() => getApi().health()).toThrow(/DATABASE_URL/);

		vi.stubEnv("DATABASE_URL", "postgresql://db.test/farm");
		expect(getApi().health()).toEqual({ status: "ok" });
		expect((await getApi().getFarm(new Request("http://app.test/api/farm"))).status).toBe(200);
	});

	it("builds the store with the rules' version, the one each response carries (#443)", async () => {
		const { getApi } = await importApi();

		const response = await getApi().getFarm(new Request("http://app.test/api/farm"));

		expect(response.status).toBe(200);
		expect(fakes.storeRulesVersions).toEqual([Number(response.headers.get("Rules-Version"))]);
	});

	it("stamps an action with the server's Date.now(), in ms (T1, MUST-11.1)", async () => {
		const now = 1_790_000_000_000;
		vi.useFakeTimers({ toFake: ["Date"], now });
		const { getApi } = await importApi();

		const response = await getApi().postAction(buildPlantRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ farm: { seq: 1, at: now } });
		// The store logged the action at that time: a fresh load reads it back.
		const loaded = await getApi().getFarm(new Request("http://app.test/api/farm"));
		expect(await loaded.json()).toMatchObject({ farm: { seq: 1, at: now } });
	});

	it("sends a store error to the server's log and answers 503 busy (ADR-0006, section 8)", async () => {
		const error = new Error("Store error: connection refused.");
		fakes.storeError = error;
		const logged: unknown[][] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args);
		});
		const { getApi } = await importApi();

		const response = await getApi().getFarm(new Request("http://app.test/api/farm"));

		expect(response.status).toBe(503);
		expect(logged).toEqual([["Game API error:", error]]);
	});
});

function buildPlantRequest(): Request {
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Idempotency-Key", crypto.randomUUID());
	return new Request("http://app.test/api/farm/actions", {
		method: "POST",
		headers,
		body: JSON.stringify({ action: { type: "plant", plot: 0, crop: "wheat" }, expectedSeq: 0 }),
	});
}

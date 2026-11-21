import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthModule from "@/server/auth";
import type * as StoreModule from "@/server/store";

import { makeEnv } from "../../config/tests/env";
import type * as ApiModule from "../index";

// What the mocked store and auth below share with the tests: the commits the store saw, and an
// error for every store call to reject with when a test sets one.
const fakes = vi.hoisted(() => ({
	commits: [] as StoreModule.CommitEntry[],
	storeError: null as Error | null,
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

// A store with no database behind it, built from the `newFarm` getApi() hands B100, so these tests
// see the wiring and not postgres.js. The store itself is tested against B100 in the db project.
vi.mock("@/server/store", async (importOriginal) => ({
	...(await importOriginal<typeof StoreModule>()),
	createStore: ({ newFarm }: StoreModule.StoreDeps): StoreModule.GameStore => {
		const reachStore = (): Promise<void> =>
			fakes.storeError === null ? Promise.resolve() : Promise.reject(fakes.storeError);
		return {
			load: async (playerId) => {
				await reachStore();
				return { state: newFarm(playerId), seq: 0, at: 0 };
			},
			processed: async () => {
				await reachStore();
				return null;
			},
			commit: async (_playerId, entry) => {
				await reachStore();
				fakes.commits.push(entry);
				return { kind: "committed", seq: entry.expectedSeq + 1 };
			},
		};
	},
}));

// getApi() memoises per module, so each test imports a fresh copy (#329, decision 5).
async function importApi(): Promise<typeof ApiModule> {
	vi.resetModules();
	return await import("../index");
}

beforeEach(() => {
	fakes.commits.length = 0;
	fakes.storeError = null;
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

	it("throws a config error while a variable is missing, and builds once it is set", async () => {
		const { getApi } = await importApi();
		vi.stubEnv("DATABASE_URL", "");

		expect(() => getApi()).toThrow(/DATABASE_URL/);

		vi.stubEnv("DATABASE_URL", "postgresql://db.test/farm");
		expect(getApi().health()).toEqual({ status: "ok" });
	});

	it("stamps an action with the server's Date.now(), in ms (T1, MUST-11.1)", async () => {
		const now = 1_790_000_000_000;
		vi.useFakeTimers({ toFake: ["Date"], now });
		const { getApi } = await importApi();

		const response = await getApi().postAction(buildPlantRequest());

		expect(response.status).toBe(200);
		expect(fakes.commits.map((entry) => entry.at)).toEqual([now]);
		expect(await response.json()).toMatchObject({ farm: { seq: 1, at: now } });
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

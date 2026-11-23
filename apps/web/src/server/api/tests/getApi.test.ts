import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnv } from "../../config/tests/env";
import { connectFromEnv, createApi, getApi } from "../index";
import { buildGetRequest, buildPlantRequest, expectContract500, spyOnLog } from "./helpers";

beforeEach(() => {
	for (const [name, value] of Object.entries(makeEnv("postgresql://db.test/farm"))) {
		vi.stubEnv(name, value);
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// The one test that calls getApi: every other test builds its graph with `createApi` (ADR-0007,
// section 2).
describe("getApi", () => {
	it("builds the real wiring from the process environment on the first call, then reuses it", async () => {
		const api = getApi();

		expect(getApi()).toBe(api);
		expect(api.health()).toEqual({ status: "ok" });
		// Connected, a request without a token is 401 before any database call.
		expect((await api.getFarm(buildGetRequest())).status).toBe(401);
	});
});

describe("connectFromEnv", () => {
	it("wires the game routes so a request without a token is 401 before the database (#397)", async () => {
		// Nothing listens at db.test: a store call would reject, and the route would answer 503.
		const api = createApi(connectFromEnv(makeEnv("postgresql://db.test/farm")));
		const post = new Request("http://app.test/api/farm/actions", { method: "POST", body: "{}" });

		const responses = await Promise.all([api.getFarm(buildGetRequest()), api.postAction(post)]);

		expect(responses).toHaveLength(2);
		for (const response of responses) {
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ error: "unauthorized" });
			expect(response.headers.get("Retry-After")).toBeNull();
			expect(response.headers.get("Rules-Version")).toBe("1");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(response.headers.get("Server-Timing")).toMatch(/^total;dur=/);
		}
	});

	it("builds without reading the environment, and its health check throws the config error (#470)", async () => {
		const logged = spyOnLog();
		const api = createApi(connectFromEnv({}));

		expect(() => api.health()).toThrow(/DATABASE_URL/);
		expect((await api.getFarm(buildGetRequest())).status).toBe(500);
		expect(logged).toHaveLength(1);
	});

	it("answers the contract's 500 while a variable is missing, and connects once it is set (#470)", async () => {
		const logged = spyOnLog();
		const env: Record<string, string | undefined> = { ...makeEnv("") };
		const api = createApi(connectFromEnv(env));

		const responses = await Promise.all([
			api.getFarm(buildGetRequest()),
			api.postAction(buildPlantRequest()),
		]);

		for (const response of responses) {
			expect(response.status).toBe(500);
			await expectContract500(response, "DATABASE_URL");
			expect(response.headers.get("Retry-After")).toBeNull();
		}
		expect(logged.map(([label]) => label)).toEqual(["Game API error:", "Game API error:"]);
		expect(String(logged[0]?.[1])).toMatch(/DATABASE_URL/);
		expect(() => api.health()).toThrow(/DATABASE_URL/);

		env["DATABASE_URL"] = "postgresql://db.test/farm";
		expect(api.health()).toEqual({ status: "ok" });
		expect((await api.getFarm(buildGetRequest())).status).toBe(401);
	});
});

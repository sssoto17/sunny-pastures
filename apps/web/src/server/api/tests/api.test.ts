import type * as Supabase from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { makeEnv } from "../../config/tests/env";
import { createApi } from "../index";

const supabase = vi.hoisted(() => ({ clients: 0 }));

// Counts the Supabase clients built, so a test can see auth is built once with the graph (#371,
// #332 decision 4).
vi.mock("@supabase/supabase-js", async (importOriginal) => {
	const actual = await importOriginal<typeof Supabase>();
	return {
		...actual,
		createClient: (...args: Parameters<typeof actual.createClient>) => {
			supabase.clients += 1;
			return actual.createClient(...args);
		},
	};
});

// Tests build the graph from their own environment and never call getApi (#329, decision 5).
describe("createApi", () => {
	it("answers the health check once the graph is built", () => {
		expect(createApi(makeEnv("postgresql://db.test/farm")).health()).toEqual({ status: "ok" });
	});

	it("builds without reading the environment, and its health check throws the config error (#470)", () => {
		const api = createApi({});

		expect(() => api.health()).toThrow(/DATABASE_URL/);
	});

	it("builds auth once with the graph, not once per request (#371)", async () => {
		const before = supabase.clients;
		const api = createApi(makeEnv("postgresql://db.test/farm"));
		const request = new Request("http://app.test/api/farm");

		const results = await Promise.all([api.readPlayer(request), api.readPlayer(request)]);

		expect(results).toStrictEqual([{ ok: false }, { ok: false }]);
		expect(supabase.clients - before).toBe(1);
	});

	it("wires the game routes so a request without a token is 401 before the database (#397)", async () => {
		// Nothing listens at db.test: a store call would reject, and the route would answer 503.
		const api = createApi(makeEnv("postgresql://db.test/farm"));
		const post = new Request("http://app.test/api/farm/actions", {
			method: "POST",
			body: "{}",
		});

		const responses = await Promise.all([
			api.getFarm(new Request("http://app.test/api/farm")),
			api.postAction(post),
		]);

		for (const response of responses) {
			expect(response.status).toBe(401);
			expect(response.headers.get("Rules-Version")).toBe("1");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(response.headers.get("Server-Timing")).toMatch(/^total;dur=/);
		}
	});
});

import { describe, expect, it } from "vitest";

import { createApi } from "../index";

// Environment names are UPPER_SNAKE, an outside shape the naming rule doesn't allow as keys.
const env = Object.fromEntries([["DATABASE_URL", "postgresql://db.test/farm"]]);

// Tests build the graph from their own environment and never call getApi (#329, decision 5).
describe("createApi", () => {
	it("answers the health check once the graph is built", () => {
		expect(createApi(env).health()).toEqual({ status: "ok" });
	});

	it("fails to build when the config is incomplete", () => {
		expect(() => createApi({})).toThrow(/DATABASE_URL/);
	});
});

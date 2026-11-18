import { describe, expect, it } from "vitest";

import { makeEnv } from "../../config/tests/env";
import { createApi } from "../index";

// Tests build the graph from their own environment and never call getApi (#329, decision 5).
describe("createApi", () => {
	it("answers the health check once the graph is built", () => {
		expect(createApi(makeEnv("postgresql://db.test/farm")).health()).toEqual({ status: "ok" });
	});

	it("fails to build when the config is incomplete", () => {
		expect(() => createApi({})).toThrow(/DATABASE_URL/);
	});
});

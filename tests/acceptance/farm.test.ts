import { describe, expect, it } from "vitest";

import { callApi, expectContractHeaders, signUpPlayer } from "./harness";

// GET /api/farm (ADR-0007 section 3): the caller's own farm, never advanced, never written.
describe("GET /api/farm", () => {
	it("loads a new player's farm at seq 0 under rules version 1", async () => {
		const player = await signUpPlayer();

		const response = await callApi("/api/farm", { player });

		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ farm: { seq: 0, rulesVersion: 1 } });
		expectContractHeaders(response, ["load"]);
	});
});

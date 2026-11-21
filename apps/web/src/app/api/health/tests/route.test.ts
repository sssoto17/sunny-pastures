import { describe, expect, it, vi } from "vitest";

import { GET, runtime } from "../route";

// A Humble Object (#329, decisions 1 and 5): the route answers with what `getApi()` reports.
vi.mock("@/server/api", () => ({ getApi: () => ({ health: () => ({ status: "ok" }) }) }));

describe("GET /api/health's route file", () => {
	it("runs where the game routes run, on Node (ADR-0007, section 2, Q6)", () => {
		expect(runtime).toBe("nodejs");
	});

	it("answers 200 with getApi()'s health as JSON", async () => {
		const response = GET();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});

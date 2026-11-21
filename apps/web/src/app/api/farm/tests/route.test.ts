import { describe, expect, it, vi } from "vitest";

import type { Api } from "@/server/api";

import { GET, runtime } from "../route";

const api = vi.hoisted(() => ({ getFarm: vi.fn<Api["getFarm"]>() }));

// A Humble Object (#329, decisions 1 and 5): the route hands its request to `getApi()` and returns
// what comes back. The handler itself is tested in server/api.
vi.mock("@/server/api", () => ({ getApi: () => api }));

describe("GET /api/farm's route file", () => {
	it("runs on Node, for postgres.js's TCP connection (ADR-0007, section 2, Q6)", () => {
		expect(runtime).toBe("nodejs");
	});

	it("hands the request to getFarm and returns its response unchanged", async () => {
		const request = new Request("http://app.test/api/farm");
		const response = new Response("farm");
		api.getFarm.mockResolvedValue(response);

		expect(await GET(request)).toBe(response);
		expect(api.getFarm).toHaveBeenCalledExactlyOnceWith(request);
	});
});

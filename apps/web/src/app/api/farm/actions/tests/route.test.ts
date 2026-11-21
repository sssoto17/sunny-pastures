import { describe, expect, it, vi } from "vitest";

import type { Api } from "@/server/api";

import { POST, runtime } from "../route";

const api = vi.hoisted(() => ({ postAction: vi.fn<Api["postAction"]>() }));

// A Humble Object (#329, decisions 1 and 5): the route hands its request to `getApi()` and returns
// what comes back. The handler itself is tested in server/api.
vi.mock("@/server/api", () => ({ getApi: () => api }));

describe("POST /api/farm/actions's route file", () => {
	it("runs on Node, for postgres.js's TCP connection (ADR-0007, section 2, Q6)", () => {
		expect(runtime).toBe("nodejs");
	});

	it("hands the request to postAction and returns its response unchanged", async () => {
		const request = new Request("http://app.test/api/farm/actions", { method: "POST" });
		const response = new Response("answer");
		api.postAction.mockResolvedValue(response);

		expect(await POST(request)).toBe(response);
		expect(api.postAction).toHaveBeenCalledExactlyOnceWith(request);
	});
});

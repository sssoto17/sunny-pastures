import { afterEach, describe, expect, it, vi } from "vitest";

import { loadFarm, sendAction } from "../index";

const session = {
	getAccessToken: () => Promise.resolve("browser-token"),
	refreshAccessToken: () => Promise.resolve("browser-token"),
};
vi.mock("../../session", () => ({ getBrowserSession: () => session }));

const farm = { seq: 0, at: 0, state: {}, rulesVersion: 1 };

describe("the browser calls", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("loadFarm goes through the global fetch with the session's token", async () => {
		const fetchFake = vi.fn(() => Promise.resolve(Response.json({ farm })));
		vi.stubGlobal("fetch", fetchFake);
		expect(await loadFarm()).toEqual({ ok: true, farm });
		expect(fetchFake).toHaveBeenCalledWith("/api/farm", expect.objectContaining({ method: "GET" }));
	});

	it("sendAction goes through the global fetch", async () => {
		const answer = { seq: 1, hash: "h", rebased: false, retries: 0 };
		vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ answer, farm })));
		const request = {
			action: { type: "harvest", plot: 0 },
			expectedSeq: 0,
			idempotencyKey: "k",
		} as const;
		expect(await sendAction(request)).toEqual({ ok: true, answer, farm });
	});
});

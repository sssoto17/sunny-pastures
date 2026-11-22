import { describe, expect, it } from "vitest";

import { callApi, loadFarm, plantWheat, signUpPlayer } from "../harness";

// T1, a forged or skewed client clock (spec MUST-16; ADR-0007 section 6, "Attack tests"): server
// time decides, so nothing ripens early. The API reads no clock from the request: no clock header
// (ADR-0007 section 6, "Load"), and no time in the body (section 3, "Request"). Wheat grows for
// 120 s (M3's content, written out), so a plot planted in a test is never ready within it.

// HTTP dates (RFC 9110) an hour either side of now: one to plant "in the past", one to harvest
// "in the future". A server that took either would see the wheat ready.
const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
const anHourAhead = new Date(Date.now() + 60 * 60 * 1000).toUTCString();

const harvestPlot0 = { action: { type: "harvest", plot: 0 }, expectedSeq: 1 };

describe("T1: a forged client clock", () => {
	it("refuses a harvest right after planting, with forged Date headers, as not ripe (422)", async () => {
		const player = await signUpPlayer();
		const planted = await callApi("/api/farm/actions", {
			player,
			headers: { Date: anHourAgo },
			body: plantWheat,
		});
		expect(planted.status).toBe(200);

		const harvested = await callApi("/api/farm/actions", {
			player,
			headers: { Date: anHourAhead },
			body: harvestPlot0,
		});

		expect(harvested.status).toBe(422);
		expect(harvested.body).toStrictEqual({
			error: "refused",
			message: "Plot 1 isn't ready to harvest.",
		});
		const loaded = await loadFarm(player);
		expect(loaded.body).toMatchObject({ farm: { seq: 1, state: { xp: 0 } } });
		expect(loaded.body).toHaveProperty(["farm", "state", "plots", 0, "status"], "growing");
	});

	it.each([
		["the body", { ...plantWheat, at: Date.now() + 60 * 60 * 1000 }],
		["the action", { ...plantWheat, action: { ...plantWheat.action, at: 0 } }],
	])("refuses a time sent in %s with 400, and writes nothing", async (_where, body) => {
		const player = await signUpPlayer();
		const before = await loadFarm(player);

		const response = await callApi("/api/farm/actions", { player, body });

		expect(response.status).toBe(400);
		expect(response.body).toMatchObject({ error: "bad_request" });
		expect((await loadFarm(player)).text).toBe(before.text);
	});
});

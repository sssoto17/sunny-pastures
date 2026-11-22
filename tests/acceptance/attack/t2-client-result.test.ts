import { describe, expect, it } from "vitest";

import { callApi, loadFarm, plantWheat, signUpPlayer } from "../harness";

// T2, a client that sends a result or a quantity (spec MUST-16; ADR-0007 section 6, "Attack
// tests"): the request may carry neither, so it's refused with 400 and the server computes every
// outcome. Each body below is an action the farm would accept but for the extra field, so a server
// that dropped the field instead of refusing it would answer 200 and write.

// A farm one action in (wheat on plot 0, 48 coins), so the "unchanged" check has a state to keep.
const plantPlot1 = { action: { type: "plant", plot: 1, crop: "wheat" }, expectedSeq: 1 };

describe("T2: a result or a quantity from the client", () => {
	it.each([
		["a quantity in the action", { ...plantPlot1, action: { ...plantPlot1.action, quantity: 6 } }],
		["an amount in the action", { ...plantPlot1, action: { ...plantPlot1.action, amount: 99 } }],
		["a result beside the action", { ...plantPlot1, result: { coins: 1_000_000 } }],
		["a state beside the action", { ...plantPlot1, state: { coins: 1_000_000, xp: 10_000 } }],
		["an answer beside the action", { ...plantPlot1, answer: { seq: 2, hash: "0" } }],
	])("refuses %s with 400, and the farm is unchanged", async (_sent, body) => {
		const player = await signUpPlayer();
		expect((await callApi("/api/farm/actions", { player, body: plantWheat })).status).toBe(200);
		const before = await loadFarm(player);

		const response = await callApi("/api/farm/actions", { player, body });

		expect(response.status).toBe(400);
		expect(response.body).toMatchObject({ error: "bad_request" });
		expect((await loadFarm(player)).text).toBe(before.text);
	});
});

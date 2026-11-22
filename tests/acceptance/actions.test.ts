import { describe, expect, it } from "vitest";

import { callApi, expectContractHeaders, plantWheat, signUpPlayer } from "./harness";

// POST /api/farm/actions (ADR-0007 section 3; ADR-0001's loop). The values below are M3's content
// written out: a new farm has 50 coins, and wheat costs 2 coins and grows for 120 s, so planting it
// leaves 48 coins and a plot that can't be harvested within a test.

describe("POST /api/farm/actions", () => {
	it("commits an action, answers seq 1, and the next load reads the farm it returned", async () => {
		const player = await signUpPlayer();

		const posted = await callApi("/api/farm/actions", { player, body: plantWheat });

		expect(posted.status).toBe(200);
		expect(posted.body).toMatchObject({
			answer: { seq: 1, hash: expect.any(String) as unknown, rebased: false, retries: 0 },
			farm: { seq: 1, rulesVersion: 1, state: { coins: 48 } },
		});
		expect(posted.body).toHaveProperty(["farm", "state", "plots", 0], {
			status: "growing",
			crop: "wheat",
			readyAt: expect.any(Number) as unknown,
		});
		expectContractHeaders(posted, ["load", "sim", "commit"]);

		const loaded = await callApi("/api/farm", { player });

		expect(loaded.status).toBe(200);
		expect(loaded.body).toHaveProperty("farm", readField(posted.body, "farm"));
		expectContractHeaders(loaded, ["load"]);
	});

	it("answers a resent Idempotency-Key with the first answer and commits once", async () => {
		const player = await signUpPlayer();
		const headers = { "Idempotency-Key": crypto.randomUUID() };

		const first = await callApi("/api/farm/actions", { player, headers, body: plantWheat });
		const resent = await callApi("/api/farm/actions", { player, headers, body: plantWheat });

		expect(first.status).toBe(200);
		expect(resent.status).toBe(200);
		expect(readField(resent.body, "answer")).toStrictEqual(readField(first.body, "answer"));
		expect(resent.body).toMatchObject({ farm: { seq: 1, state: { coins: 48 } } });
		// The resend reads the stored answer and a fresh load; it runs neither the sim nor a commit.
		expectContractHeaders(resent, ["load"]);

		const loaded = await callApi("/api/farm", { player });

		expect(loaded.body).toMatchObject({ farm: { seq: 1, state: { coins: 48 } } });
	});

	it("refuses what the sim refuses with 422 and the sim's sentence, and writes nothing", async () => {
		const player = await signUpPlayer();

		const refused = await callApi("/api/farm/actions", {
			player,
			body: { action: { type: "harvest", plot: 0 }, expectedSeq: 0 },
		});

		expect(refused.status).toBe(422);
		expect(refused.body).toStrictEqual({
			error: "refused",
			message: "Plot 1 isn't ready to harvest.",
		});
		expectContractHeaders(refused, ["load", "sim"]);

		const loaded = await callApi("/api/farm", { player });

		expect(loaded.body).toMatchObject({ farm: { seq: 0 } });
	});
});

// One field of a response body, checked present, so a missing one fails here, not as undefined.
function readField(body: unknown, key: "answer" | "farm"): unknown {
	expect(body).toHaveProperty(key);

	return (body as Record<string, unknown>)[key];
}

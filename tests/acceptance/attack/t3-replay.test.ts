import { describe, expect, it } from "vitest";

import { callApi, loadFarm, plantPlot1, plantWheat, signUpPlayer, type Player } from "../harness";

// T3, a replayed or duplicated request (spec MUST-16; ADR-0007 section 6, "Attack tests"): a
// resent `Idempotency-Key` gets the first answer unchanged and nothing applies twice (MUST-13.2,
// ADR-0001). The body isn't compared (ADR-0007 section 3, "Request"), so a key can't carry a
// second action either. Each resent plant below would be refused (422) if the server ran it:
// plot 0 is already growing after the first plant.

describe("T3: a replayed Idempotency-Key", () => {
	it("returns the identical first answer to a resend, and seq advanced once", async () => {
		const player = await signUpPlayer();
		const key = { "Idempotency-Key": crypto.randomUUID() };
		const first = await callApi("/api/farm/actions", { player, headers: key, body: plantWheat });
		expect(first.status).toBe(200);

		const resent = await callApi("/api/farm/actions", { player, headers: key, body: plantWheat });

		expect(resent.status).toBe(200);
		expect(readAnswer(resent)).toStrictEqual(readAnswer(first));
		expect(readAnswer(first)).toMatchObject({ seq: 1 });
		await expectFarm(player, { seq: 1, coins: 48 });
	});

	it("returns the first answer even after the farm moved on, when the action would now be refused", async () => {
		const player = await signUpPlayer();
		const key = { "Idempotency-Key": crypto.randomUUID() };
		const first = await callApi("/api/farm/actions", { player, headers: key, body: plantWheat });
		const next = await callApi("/api/farm/actions", { player, body: plantPlot1 });
		expect([first.status, next.status]).toStrictEqual([200, 200]);

		const resent = await callApi("/api/farm/actions", { player, headers: key, body: plantWheat });

		expect(resent.status).toBe(200);
		expect(readAnswer(resent)).toStrictEqual(readAnswer(first));
		// The farm beside a resent answer is a fresh load: both plants, each once.
		expect(resent.body).toMatchObject({ farm: { seq: 2, state: { coins: 46 } } });
		await expectFarm(player, { seq: 2, coins: 46 });
	});

	it("returns the first answer to a resent key carrying another action, and runs none of it", async () => {
		const player = await signUpPlayer();
		const key = { "Idempotency-Key": crypto.randomUUID() };
		const first = await callApi("/api/farm/actions", { player, headers: key, body: plantWheat });
		expect(first.status).toBe(200);

		const resent = await callApi("/api/farm/actions", { player, headers: key, body: plantPlot1 });

		expect(resent.status).toBe(200);
		expect(readAnswer(resent)).toStrictEqual(readAnswer(first));
		await expectFarm(player, { seq: 1, coins: 48 });
	});

	it("commits 10 concurrent copies of one request once: every 200 is the identical answer", async () => {
		const player = await signUpPlayer();
		const key = { "Idempotency-Key": crypto.randomUUID() };

		const responses = await Promise.all(
			Array.from({ length: 10 }, () =>
				callApi("/api/farm/actions", { player, headers: key, body: plantWheat }),
			),
		);

		// A copy that raced the commit may be told to retry (503 busy, ADR-0007 section 3); none is
		// refused, and none gets an answer of its own.
		const answered = responses.filter((response) => response.status === 200);
		expect(responses.filter((response) => response.status !== 503)).toStrictEqual(answered);
		expect(answered.length).toBeGreaterThan(0);
		for (const response of answered) {
			expect(readAnswer(response)).toStrictEqual(readAnswer(answered[0]));
		}
		expect(readAnswer(answered[0])).toMatchObject({ seq: 1 });
		await expectFarm(player, { seq: 1, coins: 48 });
	});
});

// The farm as loaded now: its seq, and its coins (50 at the start, 2 per wheat seed).
async function expectFarm(player: Player, { seq, coins }: { seq: number; coins: number }) {
	const loaded = await loadFarm(player);
	expect(loaded.body).toMatchObject({ farm: { seq, state: { coins } } });
}

// The answer of a 200, checked present, so a missing one fails here, not as two undefineds.
function readAnswer(response: { readonly body: unknown } | undefined): unknown {
	expect(response?.body).toHaveProperty("answer");

	return (response?.body as Record<string, unknown>)["answer"];
}

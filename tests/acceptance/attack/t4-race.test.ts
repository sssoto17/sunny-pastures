import { describe, expect, it } from "vitest";

import { callApi, loadFarm, plantWheat, signUpPlayer } from "../harness";

// T4, concurrent requests racing on one farm (spec MUST-16; ADR-0007 section 6, "Attack tests"):
// no lost update and no double spend. 20 harvests of one ripe plot, each with its own key, so the
// store's seq guard is all that stands between them (ADR-0007 section 5, Q6), not idempotency.
//
// The API has no clock header and no test-only clock route (either would be a T1 hole), so the
// plot ripens in real time: wheat grows for 120 s (M3's content). The wait is read from the plant's
// own answer (`readyAt - at`, both server times), so a skew between this clock and the server's
// doesn't matter, plus a margin for the commit's own latency.
// Wheat's grow time in M3's content, written out; readGrowMs checks the plant agrees.
const wheatGrowMs = 120_000;
const ripeningMarginMs = 3_000;
const racers = 20;

describe("T4: concurrent harvests of one ripe plot", () => {
	it(
		"lands exactly one harvest; the rest get 422 or 503; seq is gap-free",
		async () => {
			const player = await signUpPlayer();
			const planted = await callApi("/api/farm/actions", { player, body: plantWheat });
			expect(planted.status).toBe(200);
			const waitMs = readGrowMs(planted.body) + ripeningMarginMs;
			await new Promise((resolve) => setTimeout(resolve, waitMs));

			const responses = await Promise.all(
				Array.from({ length: racers }, () =>
					callApi("/api/farm/actions", {
						player,
						body: { action: { type: "harvest", plot: 0 }, expectedSeq: 1 },
					}),
				),
			);

			const statuses = responses.map((response) => response.status);
			expect(statuses.filter((status) => status === 200)).toHaveLength(1);
			expect(statuses.filter((status) => status !== 422 && status !== 503)).toStrictEqual([200]);
			// The one that landed took seq 2, the next after the plant: no seq skipped or reused.
			const landed = responses.find((response) => response.status === 200);
			expect(landed?.body).toMatchObject({ answer: { seq: 2 }, farm: { seq: 2 } });

			// One harvest's worth: 1 XP, and wheat's base yield of 2 (3 with the bonus), once.
			const loaded = await loadFarm(player);
			expect(loaded.body).toMatchObject({ farm: { seq: 2, state: { xp: 1, coins: 48 } } });
			expect(loaded.body).toHaveProperty(["farm", "state", "plots", 0, "status"], "empty");
			const wheat: unknown = (loaded.body as { farm: { state: { silo: Record<string, unknown> } } })
				.farm.state.silo["wheat"];
			expect([2, 3]).toContain(wheat);
		},
		// The grow time, the margin, and a few round trips for sign-up, plant and the race.
		wheatGrowMs + ripeningMarginMs + 30_000,
	);
});

// How long the planted wheat takes to ripen, in ms, from the plant's answer: plot 0's `readyAt`
// less the farm's `at`, both the server's.
function readGrowMs(body: unknown): number {
	expect(body).toHaveProperty(["farm", "at"], expect.any(Number));
	expect(body).toHaveProperty(["farm", "state", "plots", 0, "readyAt"], expect.any(Number));
	const { farm } = body as { farm: { at: number; state: { plots: [{ readyAt: number }] } } };

	const growMs = farm.state.plots[0].readyAt - farm.at;
	// M3's wheat grows for 120 s; a different number means the content moved, not the attack.
	expect(growMs).toBe(wheatGrowMs);
	return growMs;
}

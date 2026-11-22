import { describe, expect, it } from "vitest";

import { callApi, loadFarm, plantWheat, signUpPlayer, type Player } from "../harness";

// T5, acting on or reading another player's farm (spec MUST-16; ADR-0007 section 3, "Routes"):
// the farm is the verified token's `sub`, and no farm id travels in the path, the query or the
// body. A request that names another farm is refused with 400, and reads or changes nothing.
// Player B's farm is one action in, so it has a state to leak or change; A names it by B's id.

// Builds A's request from B's farm id: a path, and a body for a POST (none for a GET).
type BuildAttack = (farmB: string) => { path: string; body?: unknown };

describe("T5: player A naming player B's farm", () => {
	it.each<[string, BuildAttack]>([
		["a farm read with ?farm=B", (farmB: string) => ({ path: `/api/farm?farm=${farmB}` })],
		[
			"an action with ?farm=B",
			(farmB: string) => ({ path: `/api/farm/actions?farm=${farmB}`, body: plantWheat }),
		],
		[
			"an action with a body farmId of B",
			(farmB: string) => ({ path: "/api/farm/actions", body: { ...plantWheat, farmId: farmB } }),
		],
		[
			"an action with a farmId of B inside the action",
			(farmB: string) => ({
				path: "/api/farm/actions",
				body: { ...plantWheat, action: { ...plantWheat.action, farmId: farmB } },
			}),
		],
	])("refuses %s with 400; B's farm reads byte-identical", async (_attack, buildRequest) => {
		const [playerA, playerB] = await Promise.all([signUpPlayer(), signUpPlayer()]);
		expect((await callApi("/api/farm/actions", { player: playerB, body: plantWheat })).status).toBe(
			200,
		);
		const [beforeA, beforeB] = await Promise.all([loadFarm(playerA), loadFarm(playerB)]);
		const { path, body } = buildRequest(readPlayerId(playerB));

		const response = await callApi(path, { player: playerA, body });

		expect(response.status).toBe(400);
		expect(response.body).toMatchObject({ error: "bad_request" });
		// Nothing of B's in the answer, and neither farm changed: B's isn't written, nor is A's.
		expect(response.text).not.toContain(readPlayerId(playerB));
		const [afterA, afterB] = await Promise.all([loadFarm(playerA), loadFarm(playerB)]);
		expect(afterB.text).toBe(beforeB.text);
		expect(afterA.text).toBe(beforeA.text);
	});
});

// The player's id, the `sub` of their access token: the id their farm has (ADR-0007 section 3).
// Read from the token's payload only, never printed.
function readPlayerId(player: Player): string {
	const [, payload = ""] = player.accessToken.split(".");
	const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
	expect(claims).toMatchObject({ sub: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown });

	return (claims as { sub: string }).sub;
}

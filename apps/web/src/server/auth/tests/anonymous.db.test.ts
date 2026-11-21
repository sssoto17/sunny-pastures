import { describe, expect, it } from "vitest";

import { readStack } from "@/server/tests/stack";

import { createAuth } from "../index";
import { signUpAnonymous } from "./anonymous";

// Against the local stack's Auth (Vitest's db project; #371, #382): real anonymous sign-ups belong
// to the auth module's tests (ADR-0007 section 6), so this file signs up rather than createPlayer.
const config = readStack();
const auth = createAuth(config);

function makeBearerRequest(token: string): Request {
	return new Request("http://app.test/api/farm", { headers: { authorization: `Bearer ${token}` } });
}

describe("readPlayer against the local stack", () => {
	it("accepts a real anonymous player's token and returns its sub", async () => {
		const player = await signUpAnonymous(config);

		expect(await auth.readPlayer(makeBearerRequest(player.accessToken))).toStrictEqual({
			ok: true,
			playerId: player.playerId,
		});
	});

	it("verifies locally: the stack signs with ES256 under a kid, so getClaims needs no getUser call", async () => {
		const player = await signUpAnonymous(config);
		const [header = ""] = player.accessToken.split(".");

		const { alg, kid } = JSON.parse(Buffer.from(header, "base64url").toString()) as {
			alg?: unknown;
			kid?: unknown;
		};

		expect(alg).toBe("ES256");
		expect(typeof kid).toBe("string");
	});
});

describe("signUpAnonymous", () => {
	it("gives each sign-up a player of its own", async () => {
		const [first, second] = await Promise.all([signUpAnonymous(config), signUpAnonymous(config)]);

		expect(first.playerId).not.toBe(second.playerId);
	});
});

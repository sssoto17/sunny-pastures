import { describe, expect, it } from "vitest";

import { callApi, expectContractHeaders, plantWheat, signUpPlayer } from "./harness";

// The game API's errors (ADR-0007 section 3, "Errors"): the status and code each case gets, a body
// of exactly `{ error, message }`, and the headers every response carries, errors included.
// The message is a fixed sentence the server chooses; only a refusal's is the contract's (422).
// Vitest types its matchers as `any`; held as `unknown`, one can't leak into a value.
const anyMessage: unknown = expect.any(String);

describe("the game API's errors", () => {
	it("answers a request with no token with 401 unauthorized", async () => {
		const response = await callApi("/api/farm");

		expect(response.status).toBe(401);
		expect(response.body).toStrictEqual({ error: "unauthorized", message: anyMessage });
		expectContractHeaders(response);
	});

	it("answers a token Auth never issued with 401 unauthorized, before checking the body", async () => {
		const response = await callApi("/api/farm/actions", {
			headers: { Authorization: "Bearer not-a-token", "Content-Type": "text/plain" },
			body: "{",
		});

		expect(response.status).toBe(401);
		expect(response.body).toStrictEqual({ error: "unauthorized", message: anyMessage });
		expectContractHeaders(response);
	});

	it("answers a body that isn't JSON with 400 bad_request", async () => {
		const player = await signUpPlayer();

		const response = await callApi("/api/farm/actions", { player, body: "{" });

		expect(response.status).toBe(400);
		expect(response.body).toStrictEqual({ error: "bad_request", message: anyMessage });
		expectContractHeaders(response);
	});

	it("answers a body with an extra key with 400 bad_request", async () => {
		const player = await signUpPlayer();

		const response = await callApi("/api/farm/actions", {
			player,
			body: { ...plantWheat, at: 0 },
		});

		expect(response.status).toBe(400);
		expect(response.body).toStrictEqual({ error: "bad_request", message: anyMessage });
		expectContractHeaders(response);
	});

	it("answers an action with no Idempotency-Key with 400 bad_request", async () => {
		const player = await signUpPlayer();

		const response = await callApi("/api/farm/actions", {
			player,
			headers: { "Idempotency-Key": null },
			body: plantWheat,
		});

		expect(response.status).toBe(400);
		expect(response.body).toStrictEqual({ error: "bad_request", message: anyMessage });
		expectContractHeaders(response);
	});

	it("answers a farm read with a query with 400 bad_request", async () => {
		const player = await signUpPlayer();

		const response = await callApi("/api/farm?farm=another", { player });

		expect(response.status).toBe(400);
		expect(response.body).toStrictEqual({ error: "bad_request", message: anyMessage });
		expectContractHeaders(response);
	});

	it("answers a body over 4 KiB with 413 too_large", async () => {
		const player = await signUpPlayer();

		const response = await callApi("/api/farm/actions", {
			player,
			body: { ...plantWheat, padding: "x".repeat(5 * 1024) },
		});

		expect(response.status).toBe(413);
		expect(response.body).toStrictEqual({ error: "too_large", message: anyMessage });
		expectContractHeaders(response);
	});

	it("answers a body that isn't application/json with 415 unsupported_media_type", async () => {
		const player = await signUpPlayer();

		const response = await callApi("/api/farm/actions", {
			player,
			headers: { "Content-Type": "text/plain" },
			body: JSON.stringify(plantWheat),
		});

		expect(response.status).toBe(415);
		expect(response.body).toStrictEqual({ error: "unsupported_media_type", message: anyMessage });
		expectContractHeaders(response);
	});
});

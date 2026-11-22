import { describe, expect, it } from "vitest";

import { callApi, loadFarm, plantWheat, signUpPlayer, type ApiRequest } from "../harness";

// T8, malformed or oversized input (spec MUST-16; ADR-0007 section 6, "Attack tests"): 400, 413 or
// 415 with the contract's error code, never a 500, and no write. The checks run before any
// database call, in ADR-0007 section 3's order: a `Content-Type` other than JSON is 415; a body over
// 4 KiB is 413, from `Content-Length` and by capping the bytes read, so a chunked body can't get
// past it; bad JSON, a bad shape, an extra key or a bad `Idempotency-Key` is 400.
//
// Where it can be, each request is the valid plant but for its one fault, so a server that let the
// fault through would answer 200 and write, and the test fails on both counts.

// The valid plant padded with whitespace to 5 KiB: still valid JSON of the right shape, so only the
// size is wrong.
const plantPadded = JSON.stringify(plantWheat) + " ".repeat(5 * 1024);

// The padded plant as a stream of 1 KiB chunks: `fetch` sends a stream with no `Content-Length`,
// chunked, so only the cap on the bytes read can stop it.
function streamPlantPadded(): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(plantPadded);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}

			controller.enqueue(bytes.slice(offset, offset + 1024));
			offset += 1024;
		},
	});
}

const plantOn = (action: Record<string, unknown>) => ({
	...plantWheat,
	action: { ...plantWheat.action, ...action },
});

type Case = [attack: string, status: 400 | 413 | 415, error: string, request: () => ApiRequest];

const cases: Case[] = [
	["bad JSON", 400, "bad_request", () => ({ body: JSON.stringify(plantWheat).slice(0, -1) })],
	["an extra key in the body", 400, "bad_request", () => ({ body: { ...plantWheat, extra: 1 } })],
	["an extra key in the action", 400, "bad_request", () => ({ body: plantOn({ extra: 1 }) })],
	["a JSON array", 400, "bad_request", () => ({ body: [plantWheat] })],
	["JSON null", 400, "bad_request", () => ({ body: "null" })],
	["an empty body", 400, "bad_request", () => ({ body: "" })],
	["a fractional plot", 400, "bad_request", () => ({ body: plantOn({ plot: 0.5 }) })],
	["a negative plot", 400, "bad_request", () => ({ body: plantOn({ plot: -1 }) })],
	["a plot as a string", 400, "bad_request", () => ({ body: plantOn({ plot: "0" }) })],
	[
		"a crop id of 65 characters",
		400,
		"bad_request",
		() => ({ body: plantOn({ crop: "w".repeat(65) }) }),
	],
	["a NUL in the crop id", 400, "bad_request", () => ({ body: plantOn({ crop: "wheat\u0000" }) })],
	[
		"a negative expectedSeq",
		400,
		"bad_request",
		() => ({ body: { ...plantWheat, expectedSeq: -1 } }),
	],
	[
		"an Idempotency-Key that isn't a UUID",
		400,
		"bad_request",
		() => ({ headers: { "Idempotency-Key": "not-a-uuid" }, body: plantWheat }),
	],
	[
		"an Idempotency-Key a character short of a UUID",
		400,
		"bad_request",
		() => ({ headers: { "Idempotency-Key": crypto.randomUUID().slice(0, -1) }, body: plantWheat }),
	],
	["a 5 KiB body with a Content-Length", 413, "too_large", () => ({ body: plantPadded })],
	[
		"a 5 KiB body sent chunked, with no Content-Length",
		413,
		"too_large",
		() => ({ body: streamPlantPadded() }),
	],
	[
		"a text/plain content type",
		415,
		"unsupported_media_type",
		() => ({ headers: { "Content-Type": "text/plain" }, body: JSON.stringify(plantWheat) }),
	],
	[
		"a form content type",
		415,
		"unsupported_media_type",
		() => ({
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: JSON.stringify(plantWheat),
		}),
	],
];

describe("T8: malformed or oversized input", () => {
	it.each(cases)(
		"answers %s with %i, never 500, and writes nothing",
		async (_a, status, error, build) => {
			const player = await signUpPlayer();
			const before = await loadFarm(player);

			const response = await callApi("/api/farm/actions", { player, ...build() });

			expect(response.status).toBe(status);
			expect(response.body).toStrictEqual({ error, message: expect.any(String) as unknown });
			expect((await loadFarm(player)).text).toBe(before.text);
		},
	);
});

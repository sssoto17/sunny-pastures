import { describe, expect, it } from "vitest";

import { readActionRequest, readFarmRequest } from "../index";

const goodKey = "0b5d1e7a-3c4f-4a2b-9e8d-7f6a5b4c3d2e";
const plant = { type: "plant", plot: 0, crop: "wheat" };

interface PostOptions {
	readonly contentType?: string | null;
	readonly key?: string | null;
	readonly headers?: Readonly<Record<string, string>>;
}

function post(body: BodyInit | null, options: PostOptions = {}): Request {
	const headers = new Headers(options.headers);
	const contentType = options.contentType === undefined ? "application/json" : options.contentType;
	if (contentType !== null) headers.set("Content-Type", contentType);
	const key = options.key === undefined ? goodKey : options.key;
	if (key !== null) headers.set("Idempotency-Key", key);
	return new Request("http://app.test/api/farm/actions", { method: "POST", headers, body });
}

function postJson(value: unknown, options: PostOptions = {}): Request {
	return post(JSON.stringify(value), options);
}

// A body sent in chunks with no Content-Length, as a chunked upload arrives.
function chunked(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function postStream(body: ReadableStream<Uint8Array>): Request {
	// Node needs `duplex` for a streamed body; the DOM types don't name it yet.
	const init: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: { "Content-Type": "application/json", "Idempotency-Key": goodKey },
		body,
		duplex: "half",
	};
	return new Request("http://app.test/api/farm/actions", init);
}

async function refusal(request: Request): Promise<string> {
	const result = await readActionRequest(request);
	if (result.ok) throw new Error("expected the request to be refused");
	return result.problem.error;
}

describe("readActionRequest", () => {
	it("reads the action, the expected seq and the key from a good request", async () => {
		await expect(
			readActionRequest(postJson({ action: plant, expectedSeq: 7 })),
		).resolves.toStrictEqual({
			ok: true,
			value: { action: plant, expectedSeq: 7, idempotencyKey: goodKey },
		});
	});

	it("accepts a JSON content type with a UTF-8 charset", async () => {
		const request = postJson(
			{ action: plant, expectedSeq: 0 },
			{ contentType: "application/json; charset=UTF-8" },
		);

		await expect(readActionRequest(request)).resolves.toMatchObject({ ok: true });
	});

	it.each([
		["text/plain"],
		["application/x-www-form-urlencoded"],
		["application/jsonp"],
		["application/json; charset=latin1"],
	])("refuses the content type %s with 415", async (contentType) => {
		expect(await refusal(postJson({ action: plant, expectedSeq: 0 }, { contentType }))).toBe(
			"unsupported_media_type",
		);
	});

	it("refuses a request with no content type with 415", async () => {
		expect(await refusal(postJson({ action: plant, expectedSeq: 0 }, { contentType: null }))).toBe(
			"unsupported_media_type",
		);
	});

	it("checks the content type before the size", async () => {
		const request = post("x".repeat(5000), { contentType: "text/plain" });

		expect(await refusal(request)).toBe("unsupported_media_type");
	});

	it("refuses a Content-Length over 4 KiB with 413 before reading the body", async () => {
		const request = post("{}", { headers: { "Content-Length": "4097" } });

		expect(await refusal(request)).toBe("too_large");
		expect(request.bodyUsed).toBe(false);
	});

	it("refuses a body over 4 KiB with 413 when it has a Content-Length", async () => {
		const padding = "x".repeat(4096);

		expect(await refusal(postJson({ action: plant, expectedSeq: 0, padding }))).toBe("too_large");
	});

	it("refuses a chunked body that grows past 4 KiB with 413", async () => {
		const request = postStream(
			chunked([
				'{"action":',
				" ".repeat(3000),
				" ".repeat(3000),
				'{"type":"harvest","plot":0},"expectedSeq":0}',
			]),
		);

		expect(await refusal(request)).toBe("too_large");
	});

	it("reads a chunked body of 4 KiB exactly", async () => {
		const json = JSON.stringify({ action: plant, expectedSeq: 0 });
		const request = postStream(chunked([json, " ".repeat(4096 - json.length)]));

		await expect(readActionRequest(request)).resolves.toMatchObject({ ok: true });
	});

	it("passes on a fault in the body stream rather than calling it a bad request", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new RangeError("connection reset"));
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": goodKey },
			body,
			duplex: "half",
		};

		await expect(readActionRequest(new Request("http://app.test/", init))).rejects.toThrow(
			RangeError,
		);
	});

	it("checks the size before the JSON", async () => {
		expect(await refusal(post("{".repeat(5000)))).toBe("too_large");
	});

	it.each([["-1"], ["12a"], ["1.5"]])(
		"refuses a malformed Content-Length %s with 400",
		async (length) => {
			expect(await refusal(post("{}", { headers: { "Content-Length": length } }))).toBe(
				"bad_request",
			);
		},
	);

	it.each([
		["an empty body", null],
		["bad JSON", "{"],
		["bytes that are not UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
		["an array", "[]"],
		["null", "null"],
	])("refuses %s with 400", async (_, body) => {
		expect(await refusal(post(body))).toBe("bad_request");
	});

	it.each([
		["no action", { expectedSeq: 0 }],
		["no expected seq", { action: plant }],
		["an extra key", { action: plant, expectedSeq: 0, farmId: "b" }],
		["a time", { action: plant, expectedSeq: 0, at: 1_700_000_000_000 }],
		["a result", { action: plant, expectedSeq: 0, result: { coins: 9999 } }],
		["a negative expected seq", { action: plant, expectedSeq: -1 }],
		["a fractional expected seq", { action: plant, expectedSeq: 1.5 }],
		["an unsafe expected seq", { action: plant, expectedSeq: 2 ** 53 }],
		["an expected seq as a string", { action: plant, expectedSeq: "1" }],
		["an action that is not an object", { action: "plant", expectedSeq: 0 }],
	])("refuses a body with %s with 400", async (_, body) => {
		expect(await refusal(postJson(body))).toBe("bad_request");
	});

	it("refuses an expected seq of -0 with 400", async () => {
		expect(await refusal(post(`{"action":${JSON.stringify(plant)},"expectedSeq":-0}`))).toBe(
			"bad_request",
		);
	});

	it.each([
		["a missing key", null],
		["an empty key", ""],
		["a key that is not a UUID", "retry-1"],
		["a UUID with braces", `{${goodKey}}`],
		["a UUID without hyphens", goodKey.replaceAll("-", "")],
		["a UUID with a trailing character", `${goodKey}0`],
	])("refuses %s with 400", async (_, key) => {
		expect(await refusal(postJson({ action: plant, expectedSeq: 0 }, { key }))).toBe("bad_request");
	});

	it("reads an upper-case key as the same key in lower case", async () => {
		const result = await readActionRequest(
			postJson({ action: plant, expectedSeq: 0 }, { key: goodKey.toUpperCase() }),
		);

		expect(result).toMatchObject({ ok: true, value: { idempotencyKey: goodKey } });
	});

	it("gives a refusal a fixed sentence, never the parser's own words", async () => {
		const result = await readActionRequest(post("{"));

		expect(result).toStrictEqual({
			ok: false,
			problem: { error: "bad_request", message: "The request body is not valid JSON." },
		});
	});
});

describe("readFarmRequest", () => {
	it("accepts a read with no query", () => {
		expect(readFarmRequest(new Request("http://app.test/api/farm"))).toStrictEqual({
			ok: true,
			value: null,
		});
	});

	it.each([["?farm=b"], ["?x"], ["?="]])("refuses the query %s with 400", (query) => {
		expect(readFarmRequest(new Request(`http://app.test/api/farm${query}`))).toMatchObject({
			ok: false,
			problem: { error: "bad_request" },
		});
	});
});

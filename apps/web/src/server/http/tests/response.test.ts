import { describe, expect, it } from "vitest";

import {
	buildErrorResponse,
	buildJsonResponse,
	readActionRequest,
	type ResponseMeta,
} from "../index";

const meta: ResponseMeta = { rulesVersion: 3, serverTiming: () => "load;dur=4, total;dur=9" };

describe("buildErrorResponse", () => {
	it("answers a refusal with 422 and the sim's reason word for word", async () => {
		const response = buildErrorResponse({ error: "refused", reason: "Plot 2 is not free." }, meta);

		expect(response.status).toBe(422);
		expect(await response.json()).toStrictEqual({
			error: "refused",
			message: "Plot 2 is not free.",
		});
	});

	it.each([
		["unauthorized", 401, "The request has no valid session. Sign in again."],
		["rate_limited", 429, "Too many requests. Wait a moment, then try again."],
		["busy", 503, "The farm is busy. Try again in a moment."],
		["internal", 500, "Something went wrong on the server. Try again."],
	] as const)("answers %s with %i and a fixed message", async (error, status, message) => {
		const response = buildErrorResponse({ error }, meta);

		expect(response.status).toBe(status);
		expect(await response.json()).toStrictEqual({ error, message });
	});

	it.each([
		["text/plain", "{}", 415, "unsupported_media_type"],
		["application/json", "x".repeat(4097), 413, "too_large"],
		["application/json", "{", 400, "bad_request"],
	] as const)(
		"sends a %s body of the checks' refusal with %i",
		async (type, body, status, error) => {
			const request = new Request("http://app.test/api/farm/actions", {
				method: "POST",
				headers: { "Content-Type": type },
				body,
			});
			const checked = await readActionRequest(request);
			if (checked.ok) throw new Error("expected the checks to refuse the request");

			const response = buildErrorResponse(checked.problem, meta);

			expect(response.status).toBe(status);
			expect(await response.json()).toStrictEqual(checked.problem);
			expect(checked.problem.error).toBe(error);
		},
	);

	it("carries the rules version, no-store and the timing on an error", () => {
		const response = buildErrorResponse({ error: "busy" }, meta);

		expect(Object.fromEntries(response.headers)).toStrictEqual({
			"cache-control": "no-store",
			"content-type": "application/json",
			"retry-after": "1",
			"rules-version": "3",
			"server-timing": "load;dur=4, total;dur=9",
		});
	});

	it("sends no Server-Timing when the timing renders nothing", () => {
		const response = buildErrorResponse(
			{ error: "internal" },
			{ ...meta, serverTiming: () => null },
		);

		expect(response.headers.has("Server-Timing")).toBe(false);
		expect(response.headers.get("Rules-Version")).toBe("3");
	});

	it("asks a client to retry after a second only when the farm is busy", () => {
		expect(buildErrorResponse({ error: "busy" }, meta).headers.get("Retry-After")).toBe("1");
		expect(buildErrorResponse({ error: "internal" }, meta).headers.get("Retry-After")).toBeNull();
	});
});

describe("buildJsonResponse", () => {
	it("answers 200 with the body and the same headers as an error", async () => {
		const response = buildJsonResponse({ farm: { seq: 0 } }, meta);

		expect(response.status).toBe(200);
		expect(await response.json()).toStrictEqual({ farm: { seq: 0 } });
		expect(Object.fromEntries(response.headers)).toStrictEqual({
			"cache-control": "no-store",
			"content-type": "application/json",
			"rules-version": "3",
			"server-timing": "load;dur=4, total;dur=9",
		});
	});
});

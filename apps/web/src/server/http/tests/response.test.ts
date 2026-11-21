import { describe, expect, it } from "vitest";

import { buildErrorResponse, buildJsonResponse, type ResponseMeta } from "../index";

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

import { describe, expect, it, vi } from "vitest";

import type { Action } from "@sunny-pastures/sim";

import type { ErrorCode } from "@/contract";

import type { Session } from "../../session";
import { createApi, type Api } from "../index";

const farm = { seq: 3, at: 1000, state: {}, rulesVersion: 1 };
const answer = { seq: 3, hash: "abc", rebased: false, retries: 0 };
const action: Action = { type: "harvest", plot: 0 };
const request = { action, expectedSeq: 2, idempotencyKey: "00000000-0000-4000-8000-000000000001" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function setup(responses: (Response | Error)[]) {
	const queue = [...responses];
	const calls: { input: string; init: RequestInit; headers: Headers }[] = [];
	const fetchFake = (input: string, init: RequestInit = {}): Promise<Response> => {
		calls.push({ input, init, headers: new Headers(init.headers) });
		const next = queue.shift();
		if (next === undefined) return Promise.reject(new Error("No response queued."));
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	};
	const session = {
		getAccessToken: vi.fn((): Promise<string | null> => Promise.resolve("token-1")),
		refreshAccessToken: vi.fn((): Promise<string | null> => Promise.resolve("token-2")),
	} satisfies Session;
	const api: Api = createApi({ fetch: fetchFake, session });
	return { api, calls, session };
}

describe("loadFarm", () => {
	it("sends a GET with the bearer token and returns the farm", async () => {
		const { api, calls } = setup([json({ farm })]);
		expect(await api.loadFarm()).toEqual({ ok: true, farm });
		expect(calls[0]?.input).toBe("/api/farm");
		expect(calls[0]?.init.method).toBe("GET");
		expect(calls[0]?.headers.get("Authorization")).toBe("Bearer token-1");
	});

	it("answers a network failure as a result", async () => {
		const { api } = setup([new TypeError("offline")]);
		expect(await api.loadFarm()).toMatchObject({ ok: false, error: "network", retryAfterMs: null });
	});

	it("answers a success body it does not understand as internal", async () => {
		const { api } = setup([json({ nope: true }), json("text")]);
		expect(await api.loadFarm()).toMatchObject({ ok: false, error: "internal" });
		expect(await api.loadFarm()).toMatchObject({ ok: false, error: "internal" });
	});

	it("answers unauthorized when no token can be had", async () => {
		const { api, session } = setup([]);
		session.getAccessToken.mockResolvedValue(null);
		session.refreshAccessToken.mockResolvedValue(null);
		expect(await api.loadFarm()).toMatchObject({ ok: false, error: "unauthorized" });
	});
});

describe("sendAction", () => {
	it("posts the body and headers and returns the answer and farm", async () => {
		const { api, calls } = setup([json({ answer, farm })]);
		expect(await api.sendAction(request)).toEqual({ ok: true, answer, farm });
		const call = calls[0];
		expect(call?.input).toBe("/api/farm/actions");
		expect(call?.init.method).toBe("POST");
		expect(JSON.parse(call?.init.body as string)).toEqual({ action, expectedSeq: 2 });
		expect(Object.fromEntries(call?.headers ?? [])).toEqual({
			"content-type": "application/json",
			"idempotency-key": request.idempotencyKey,
			authorization: "Bearer token-1",
		});
	});

	// A Record keyed by ErrorCode: tsc fails here when the contract adds a code.
	const codes = {
		bad_request: 400,
		unauthorized: 403,
		too_large: 413,
		unsupported_media_type: 415,
		refused: 422,
		rate_limited: 429,
		busy: 503,
		internal: 500,
	} satisfies Record<ErrorCode, number>;

	it.each(Object.entries(codes) as [ErrorCode, number][])(
		"maps the %s error",
		async (error, status) => {
			const { api } = setup([json({ error, message: "Said so." }, status)]);
			expect(await api.sendAction(request)).toEqual({
				ok: false,
				error,
				message: "Said so.",
				retryAfterMs: null,
			});
		},
	);

	it("reads Retry-After into milliseconds", async () => {
		const { api } = setup([json({ error: "busy", message: "Busy." }, 503, { "Retry-After": "1" })]);
		expect(await api.sendAction(request)).toMatchObject({ error: "busy", retryAfterMs: 1000 });
	});

	it("ignores a Retry-After it cannot read", async () => {
		const { api } = setup([
			json({ error: "busy", message: "Busy." }, 503, { "Retry-After": "soon" }),
		]);
		expect(await api.sendAction(request)).toMatchObject({ retryAfterMs: null });
	});

	it("maps an unknown or missing error body to internal", async () => {
		const { api } = setup([
			json({ error: "teapot" }, 418),
			new Response("<html>", { status: 502 }),
		]);
		expect(await api.sendAction(request)).toMatchObject({ ok: false, error: "internal" });
		expect(await api.sendAction(request)).toMatchObject({ ok: false, error: "internal" });
	});

	it("refreshes the token once on a 401 and sends the same request again", async () => {
		const unauthorized = json({ error: "unauthorized", message: "No." }, 401);
		const { api, calls, session } = setup([unauthorized, json({ answer, farm })]);
		expect(await api.sendAction(request)).toEqual({ ok: true, answer, farm });
		expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
		expect(calls[1]?.headers.get("Authorization")).toBe("Bearer token-2");
		expect(calls[1]?.headers.get("Idempotency-Key")).toBe(request.idempotencyKey);
		expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
	});

	it("returns a second 401 without a third try", async () => {
		const unauthorized = () => json({ error: "unauthorized", message: "No." }, 401);
		const { api, calls, session } = setup([unauthorized(), unauthorized()]);
		expect(await api.sendAction(request)).toMatchObject({ ok: false, error: "unauthorized" });
		expect(calls).toHaveLength(2);
		expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
	});

	it("does not refresh on other errors", async () => {
		const { api, session } = setup([json({ error: "refused", message: "No." }, 422)]);
		await api.sendAction(request);
		expect(session.refreshAccessToken).not.toHaveBeenCalled();
	});

	it("answers a network failure as a result", async () => {
		const { api } = setup([new TypeError("offline")]);
		expect(await api.sendAction(request)).toMatchObject({ ok: false, error: "network" });
	});

	it("answers a success body without an answer as internal", async () => {
		const { api } = setup([json({ farm })]);
		expect(await api.sendAction(request)).toMatchObject({ ok: false, error: "internal" });
	});
});

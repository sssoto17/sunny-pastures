import { expect, inject } from "vitest";

// The acceptance suite's helpers (ADR-0007 section 6, "Acceptance tests"; #386). They reach the app
// and Supabase Auth over HTTP only, with `fetch`, and import nothing from apps/ or packages/
// (Fallow's `acceptance` zone): a refactor of the server can't reshape what these tests expect.

/**
 * An action a new farm accepts: plant wheat on the first plot. M3's content written out, never
 * imported: a new farm has 50 coins and empty plots, and wheat's seed costs 2 coins.
 */
export const plantWheat = { action: { type: "plant", plot: 0, crop: "wheat" }, expectedSeq: 0 };

/** A fresh anonymous player. The token is a secret: never print or log it. */
export interface Player {
	readonly accessToken: string;
}

/** What a test sends to the game API besides the path. Every field is optional. */
export interface ApiRequest {
	/** The bearer token; leave it out to send no `Authorization` header. */
	readonly player?: Player;
	/** Sent as is, after the defaults, so a test can replace or remove one (`null` removes). */
	readonly headers?: Readonly<Record<string, string | null>>;
	/**
	 * A string is sent as is, and a stream as is with no `Content-Length`, so it goes out chunked
	 * (T8); anything else is sent as JSON.
	 */
	readonly body?: unknown;
}

/** A response, its body already read: parsed JSON, or the raw text when it isn't JSON. */
export interface ApiResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: unknown;
	/** The body as received, for a byte-for-byte comparison ("the farm reads byte-identical"). */
	readonly text: string;
}

/**
 * Signs up a new anonymous player over Supabase Auth's HTTP API, `POST /auth/v1/signup` with no
 * email or phone and the publishable key (ADR-0007 section 4, Q3), so each test has its own player
 * and farm, isolated by key, with nothing to clean up (#333, "Patterns"). A failure names Auth's
 * status and error code only, never the key or a token.
 */
export async function signUpPlayer(): Promise<Player> {
	const { supabaseUrl, supabasePublishableKey } = inject("target");
	const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
		method: "POST",
		headers: { apikey: supabasePublishableKey, "Content-Type": "application/json" },
		body: "{}",
	});
	const body = (await response.json()) as unknown;
	if (!response.ok || !hasAccessToken(body)) {
		throw new Error(
			`Anonymous sign-up failed (status ${String(response.status)}, code ${readErrorCode(body)}). Is the stack running with anonymous sign-ins on?`,
		);
	}

	return { accessToken: body.access_token };
}

/**
 * Sends one request to the app under test: a GET with no body, a POST with one. A POST defaults to
 * `Content-Type: application/json` and a fresh `Idempotency-Key`, as the M4 client sends them
 * (ADR-0007 section 3, "Request").
 */
export async function callApi(path: string, request: ApiRequest = {}): Promise<ApiResponse> {
	const method = request.body === undefined ? "GET" : "POST";
	const headers = new Headers();
	if (method === "POST") {
		headers.set("Content-Type", "application/json");
		headers.set("Idempotency-Key", crypto.randomUUID());
	}
	if (request.player !== undefined) {
		headers.set("Authorization", `Bearer ${request.player.accessToken}`);
	}
	for (const [name, value] of Object.entries(request.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}

	const body = encodeBody(request.body);
	// Node's fetch sends a stream body only with `duplex: "half"`, which the DOM types don't know.
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
		...(body === null ? {} : { body }),
		...(body instanceof ReadableStream ? { duplex: "half" } : {}),
	};
	const response = await fetch(`${inject("target").baseUrl}${path}`, init);
	const text = await response.text();
	return { status: response.status, headers: response.headers, body: parseBody(text), text };
}

/**
 * Loads the player's farm with `GET /api/farm`, checked 200. The attack tests compare its `text`
 * before and after an attack: "nothing is written" means the farm reads byte-identical (#387).
 */
export async function loadFarm(player: Player): Promise<ApiResponse> {
	const response = await callApi("/api/farm", { player });
	expect(response.status).toBe(200);

	return response;
}

/** A phase the game API times (ADR-0007 section 3, "Headers"); `total` is always sent. */
export type Phase = "load" | "sim" | "commit";

/**
 * Checks the headers every game API response carries, errors included (ADR-0007 section 3,
 * "Headers"): `Rules-Version: 1` (M3's one rules version, ADR-0006), `Cache-Control: no-store`, and
 * a `Server-Timing` of exactly `phases` and `total`, each with a duration. A phase that never ran
 * is left out, so a GET that timed `sim` or `commit`, or a refused request that timed a phase it
 * never reached, fails here.
 */
export function expectContractHeaders(response: ApiResponse, phases: readonly Phase[] = []): void {
	expect(response.headers.get("Rules-Version")).toBe("1");
	expect(response.headers.get("Cache-Control")).toBe("no-store");

	const timing = response.headers.get("Server-Timing") ?? "";
	const metrics = timing.split(",").map((metric) => metric.trim().split(";"));
	const names = metrics.map(([name]) => name);
	expect(names.sort()).toStrictEqual([...phases, "total"].sort());
	for (const [, duration] of metrics) expect(duration).toMatch(/^dur=\d+(\.\d+)?$/);
}

function encodeBody(body: unknown): string | ReadableStream<Uint8Array> | null {
	if (body === undefined) return null;
	if (typeof body === "string" || body instanceof ReadableStream) return body;

	return JSON.stringify(body);
}

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function hasAccessToken(body: unknown): body is { access_token: string } {
	return (
		typeof body === "object" &&
		body !== null &&
		"access_token" in body &&
		typeof body.access_token === "string"
	);
}

// Auth's error body carries `error_code` (or the older `code`); neither holds a secret.
function readErrorCode(body: unknown): string {
	if (typeof body !== "object" || body === null) return "none";

	const code = "error_code" in body ? body.error_code : "code" in body ? body.code : undefined;
	return typeof code === "string" || typeof code === "number" ? String(code) : "none";
}

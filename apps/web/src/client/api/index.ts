import type { Action } from "@sunny-pastures/sim";

import type { Answer, ErrorCode, FarmEnvelope } from "@/contract";

import { getBrowserSession, type Session } from "../session";

// The game API calls (ADR-0010, "Sync module"; ADR-0007, sections 3 and 4): native `fetch`, a
// result union instead of exceptions (ADR-0003, section 4), and one refresh-and-retry on a 401.

/** A failed call: the API's error code, or `"network"` when no answer came back. */
export interface ApiFailure {
	readonly ok: false;
	readonly error: ErrorCode | "network";
	readonly message: string;
	/** From `Retry-After`, in ms; `null` when the response had none. */
	readonly retryAfterMs: number | null;
}

export type LoadResult = { readonly ok: true; readonly farm: FarmEnvelope } | ApiFailure;

export type ActionResult =
	{ readonly ok: true; readonly answer: Answer; readonly farm: FarmEnvelope } | ApiFailure;

export interface ActionRequest {
	readonly action: Action;
	readonly expectedSeq: number;
	readonly idempotencyKey: string;
}

/** What the calls need from outside, so a test passes a fake `fetch` and a fake session. */
export interface ApiDeps {
	readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
	readonly session: Session;
}

export interface Api {
	loadFarm(): Promise<LoadResult>;
	sendAction(request: ActionRequest): Promise<ActionResult>;
}

// A table, not a switch over strings: `satisfies Record<ErrorCode, true>` fails tsc when the
// contract adds a code the client doesn't know.
const knownErrors = {
	bad_request: true,
	unauthorized: true,
	too_large: true,
	unsupported_media_type: true,
	refused: true,
	rate_limited: true,
	busy: true,
	internal: true,
} as const satisfies Record<ErrorCode, true>;

export function createApi(deps: ApiDeps): Api {
	return {
		loadFarm: async () => {
			const outcome = await callWithRetry(deps, "/api/farm", { method: "GET" });
			if (outcome.kind === "failed") return outcome.failure;
			const farm = readFarm(outcome.body);
			return farm === null ? badResponse() : { ok: true, farm };
		},
		sendAction: async ({ action, expectedSeq, idempotencyKey }) => {
			const outcome = await callWithRetry(deps, "/api/farm/actions", {
				method: "POST",
				body: JSON.stringify({ action, expectedSeq }),
				headers: new Headers({
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
				}),
			});
			if (outcome.kind === "failed") return outcome.failure;
			const farm = readFarm(outcome.body);
			const answer = readAnswer(outcome.body);
			return farm === null || answer === null ? badResponse() : { ok: true, answer, farm };
		},
	};
}

/** The two calls over the browser's `fetch` and session, as the UI uses them. */
export function loadFarm(): Promise<LoadResult> {
	return browserApi().loadFarm();
}

export function sendAction(request: ActionRequest): Promise<ActionResult> {
	return browserApi().sendAction(request);
}

function browserApi(): Api {
	return createApi({
		fetch: (path, init) => globalThis.fetch(path, init),
		session: getBrowserSession(),
	});
}

type Outcome =
	| { readonly kind: "ok"; readonly body: unknown }
	| { readonly kind: "failed"; readonly status: number; readonly failure: ApiFailure };

/** Sends the request; a 401 refreshes the token once and sends it once more (ADR-0007, section 4). */
async function callWithRetry(deps: ApiDeps, path: string, init: RequestInit): Promise<Outcome> {
	const first = await callOnce(deps, path, init, () => deps.session.getAccessToken());
	if (first.kind === "failed" && first.status === 401) {
		return await callOnce(deps, path, init, () => deps.session.refreshAccessToken());
	}
	return first;
}

async function callOnce(
	deps: ApiDeps,
	path: string,
	init: RequestInit,
	getToken: () => Promise<string | null>,
): Promise<Outcome> {
	const token = await getToken();
	if (token === null) {
		return fail(401, "unauthorized", "The player could not be signed in.", null);
	}

	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);

	let response: Response;
	try {
		response = await deps.fetch(path, { ...init, headers });
	} catch {
		return fail(0, "network", "The game server could not be reached.", null);
	}

	const body = await readJson(response);
	if (response.ok) return { kind: "ok", body };
	return {
		kind: "failed",
		status: response.status,
		failure: {
			ok: false,
			error: readErrorCode(body),
			message: readMessage(body),
			retryAfterMs: readRetryAfter(response),
		},
	};
}

function fail(
	status: number,
	error: ApiFailure["error"],
	message: string,
	retryAfterMs: number | null,
): Outcome {
	return { kind: "failed", status, failure: { ok: false, error, message, retryAfterMs } };
}

function badResponse(): ApiFailure {
	return {
		ok: false,
		error: "internal",
		message: "The game server's answer was not understood.",
		retryAfterMs: null,
	};
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readErrorCode(body: unknown): ErrorCode {
	const code = isRecord(body) ? body["error"] : null;
	return typeof code === "string" && Object.hasOwn(knownErrors, code)
		? (code as ErrorCode)
		: "internal";
}

function readMessage(body: unknown): string {
	const message = isRecord(body) ? body["message"] : null;
	return typeof message === "string" ? message : "The game server could not do that.";
}

/** `Retry-After` in whole seconds (the only form the server sends) as ms; anything else is `null`. */
function readRetryAfter(response: Response): number | null {
	const seconds = Number(response.headers.get("Retry-After"));
	return response.headers.has("Retry-After") && Number.isFinite(seconds) && seconds >= 0
		? seconds * 1000
		: null;
}

// The server is ours and the contract is shared, so a success body is checked only for its shape.
function readFarm(body: unknown): FarmEnvelope | null {
	const farm = isRecord(body) ? body["farm"] : null;
	return isRecord(farm) ? (farm as unknown as FarmEnvelope) : null;
}

function readAnswer(body: unknown): Answer | null {
	const answer = isRecord(body) ? body["answer"] : null;
	return isRecord(answer) ? (answer as unknown as Answer) : null;
}

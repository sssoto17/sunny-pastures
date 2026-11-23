import "server-only";

import type { Action } from "@sunny-pastures/sim";

import type { ErrorBody, ErrorCode } from "@/contract";

import { hasExactKeys, isJsonObject, isWholeNumber, readAction } from "./actions";
import { readBodyText } from "./body";

/** A checked request, or the error that refuses it. */
export type Checked<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly problem: RequestProblem };

/** One action to run, read from `POST /api/farm/actions` (#330, "Request"). */
export interface ActionRequest {
	readonly action: Action;
	/** The seq the client last saw; it only sets `answer.rebased` (ADR-0001). */
	readonly expectedSeq: number;
	/** A UUID, in lower case, so one key has one spelling in the store. */
	readonly idempotencyKey: string;
}

/** Why the request checks refused a request: a code and a sentence fixed in this module. */
export type RequestProblem = (typeof requestProblems)[keyof typeof requestProblems];

/**
 * An error to send. Only a refusal carries text from outside this module, the sim's reason, a
 * sentence a player reads (ADR-0003, section 4); every other message is fixed here, so no stack
 * trace or SQL can reach a body.
 */
export type Problem =
	| RequestProblem
	| { readonly error: "refused"; readonly reason: string }
	| { readonly error: keyof typeof fixedMessages };

/**
 * What every game API response carries besides its body (#330, "Headers"). `rulesVersion` is the
 * rules the server checked the request under. `serverTiming` renders the `Server-Timing` value
 * when the response is built, so the caller renders it after `total` is recorded; `null` sends no
 * header (the shape of #394's renderer).
 */
export interface ResponseMeta {
	readonly rulesVersion: number;
	readonly serverTiming: () => string | null;
}

/**
 * Checks `POST /api/farm/actions` before anything else reads it, in the order the contract sets
 * (#330, "Request"): a `Content-Type` other than JSON is 415; a body over 4 KiB is 413, from
 * `Content-Length` first and then by capping the bytes read; bad JSON, a bad shape, an extra key
 * or a bad `Idempotency-Key` is 400. It reads the body, so it runs once per request.
 */
export async function readActionRequest(request: Request): Promise<Checked<ActionRequest>> {
	if (!isJson(request.headers.get("Content-Type"))) return refuse("notJson");

	const length = request.headers.get("Content-Length");
	if (length !== null && !/^\d+$/.test(length)) return refuse("badLength");
	if (length !== null && Number(length) > maxBodyBytes) return refuse("tooLarge");

	const read = await readBodyText(request.body, maxBodyBytes);
	if (!read.ok) return refuse(read.reason === "too_large" ? "tooLarge" : "notUtf8");

	const parsed = parseJson(read.text);
	if (!parsed.ok) return refuse("badJson");

	const body = parsed.value;
	if (!isJsonObject(body) || !hasExactKeys(body, ["action", "expectedSeq"])) {
		return refuse("badBody");
	}
	if (!isWholeNumber(body["expectedSeq"])) return refuse("badSeq");

	const action = readAction(body["action"]);
	if (action === null) return refuse("badAction");

	const key = request.headers.get("Idempotency-Key");
	if (key === null || !uuidPattern.test(key)) return refuse("badKey");

	return {
		ok: true,
		value: { action, expectedSeq: body["expectedSeq"], idempotencyKey: key.toLowerCase() },
	};
}

/**
 * Checks `GET /api/farm`: any query parameter is 400, so another farm can't even be named (T5;
 * ADR-0007, section 3).
 */
export function readFarmRequest(request: Request): Checked<null> {
	return new URL(request.url).search === "" ? { ok: true, value: null } : refuse("query");
}

/** Builds every game API error response: the one place an error body is made (#330, "Errors"). */
export function buildErrorResponse(problem: Problem, meta: ResponseMeta): Response {
	const body: ErrorBody = {
		error: problem.error,
		message: readMessage(problem),
	};
	const response = Response.json(body, {
		status: statuses[problem.error],
		headers: buildHeaders(meta),
	});
	// MUST-13.3: still conflicting after 3 retries; the client resends with the same key.
	if (problem.error === "busy") response.headers.set("Retry-After", "1");
	return response;
}

/** Builds a 200 response with the headers every game API response carries. */
export function buildJsonResponse(body: object, meta: ResponseMeta): Response {
	return Response.json(body, { headers: buildHeaders(meta) });
}

// T8: the largest action is well under 200 bytes; 4 KiB leaves room without letting a client make
// the server hold much (#330).
const maxBodyBytes = 4096;

// RFC 9562's text form, any version, either case (the client sends crypto.randomUUID()).
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Each refusal's code and sentence, fixed here so a parser's own error text never reaches a body.
const requestProblems = {
	notJson: {
		error: "unsupported_media_type",
		message: "The request body must be JSON, sent as application/json.",
	},
	tooLarge: { error: "too_large", message: "The request body is larger than 4 KiB." },
	badLength: { error: "bad_request", message: "The Content-Length header is not a whole number." },
	notUtf8: { error: "bad_request", message: "The request body is not UTF-8 text." },
	badJson: { error: "bad_request", message: "The request body is not valid JSON." },
	badBody: {
		error: "bad_request",
		message: "The request body must hold action and expectedSeq, and nothing else.",
	},
	badSeq: { error: "bad_request", message: "The expectedSeq must be a whole number of 0 or more." },
	badAction: { error: "bad_request", message: "The action matches no action the game knows." },
	badKey: { error: "bad_request", message: "The Idempotency-Key header must be a UUID." },
	query: { error: "bad_request", message: "This route takes no query parameters." },
} as const satisfies Record<string, { error: ErrorCode; message: string }>;

const statuses = {
	bad_request: 400,
	unauthorized: 401,
	too_large: 413,
	unsupported_media_type: 415,
	refused: 422,
	rate_limited: 429,
	busy: 503,
	internal: 500,
} as const satisfies Record<ErrorCode, number>;

const fixedMessages = {
	unauthorized: "The request has no valid session. Sign in again.",
	rate_limited: "Too many requests. Wait a moment, then try again.",
	busy: "The farm is busy. Try again in a moment.",
	internal: "Something went wrong on the server. Try again.",
} as const satisfies Partial<Record<ErrorCode, string>>;

// #330, "Headers": on every response, errors included. The client compares `Rules-Version` with
// its own rules to tell a stale client from a refusal (ADR-0006, "The client").
function buildHeaders(meta: ResponseMeta): Headers {
	const headers = new Headers({
		"Rules-Version": String(meta.rulesVersion),
		"Cache-Control": "no-store",
	});
	const timing = meta.serverTiming();
	if (timing !== null) headers.set("Server-Timing", timing);
	return headers;
}

function refuse(problem: keyof typeof requestProblems): { ok: false; problem: RequestProblem } {
	return { ok: false, problem: requestProblems[problem] };
}

// `application/json`, alone or with a UTF-8 charset (RFC 8259 makes JSON UTF-8), in any case.
function isJson(contentType: string | null): boolean {
	return (
		contentType !== null &&
		/^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(contentType)
	);
}

// A result, not a sentinel: `null` is valid JSON, so it can't stand for "not JSON".
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function readMessage(problem: Problem): string {
	if ("message" in problem) return problem.message;
	if ("reason" in problem) return problem.reason;

	return fixedMessages[problem.error];
}

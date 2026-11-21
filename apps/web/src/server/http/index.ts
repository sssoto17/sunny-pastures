import "server-only";

/**
 * The closed set of error codes a game API error body carries (#330, "Errors"; ADR-0007, section
 * 3). Exported so the M4 client can switch on it exhaustively.
 */
export type ErrorCode =
	| "bad_request"
	| "unauthorized"
	| "too_large"
	| "unsupported_media_type"
	| "refused"
	| "rate_limited"
	| "busy"
	| "internal";

/** The body of every game API error. */
export interface ErrorBody {
	readonly error: ErrorCode;
	readonly message: string;
}

/**
 * An error to send. Only a refusal carries text from outside this module, the sim's reason, a
 * sentence a player reads (ADR-0003, section 4); every other message is fixed here, so no stack
 * trace or SQL can reach a body.
 */
export type Problem =
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

function readMessage(problem: Problem): string {
	if ("reason" in problem) return problem.reason;

	return fixedMessages[problem.error];
}

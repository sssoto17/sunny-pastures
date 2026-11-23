import type { FarmState } from "@sunny-pastures/sim";

// The game API's response types (ADR-0007, section 3), shared by the server and the browser
// (ADR-0010, section 5), so the client never imports server code. Types only: this module has no
// runtime code, and its zone sees the sim's types, never its values (.fallowrc.jsonc).

/**
 * The closed set of error codes a game API error body carries (#330, "Errors"; ADR-0007, section
 * 3), so the client can switch on it exhaustively.
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
 * The farm both routes return (ADR-0007, section 3, "Response"): the state after action `seq`,
 * which took effect at `at` (ms), not advanced past it, under rules version `rulesVersion`.
 */
export interface FarmEnvelope {
	readonly seq: number;
	readonly at: number;
	readonly state: FarmState;
	readonly rulesVersion: number;
}

/** What `POST /api/farm/actions` answers for an accepted action, stored with its key (ADR-0001). */
export interface Answer {
	readonly seq: number;
	readonly hash: string;
	readonly rebased: boolean;
	readonly retries: number;
}

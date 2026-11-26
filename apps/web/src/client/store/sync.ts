import type { ErrorCode, FarmEnvelope } from "@/contract";

import type { ActionResult, Api, ApiFailure } from "../api";
import { withoutAction, type PendingAction } from "./pending";

// The send loop (ADR-0010, section 5; ADR-0007, section 3, "Errors"): one action in flight at a
// time, in the order the player acted, so the server applies them in the order they were predicted
// and each is sent with the seq its predecessor confirmed.

export interface SyncDeps {
	readonly api: Pick<Api, "sendAction">;
	/** The part of the store's state the loop reads, so this module needs no `FarmStore`. */
	readonly get: () => {
		readonly pending: readonly PendingAction[];
		readonly confirmed: FarmEnvelope | null;
	};
	/** Takes the server's farm with `pending` still to apply; false when the store stopped. */
	readonly confirm: (farm: FarmEnvelope, pending: readonly PendingAction[]) => boolean;
	/** Drops the pending action with `key` and shows `reason`. */
	readonly undo: (key: string, reason: string) => void;
}

/** At most 3 retries after the first send (MUST-12.5). */
const maxRetries = 3;
const defaultRetryMs = 1000;
const givenUp = "The game server did not answer, so the action was undone. Please try again.";

// ADR-0007's errors table: these are retried with the same key; every other error is final.
const retried: ReadonlySet<ApiFailure["error"]> = new Set<ErrorCode | "network">([
	"busy",
	"internal",
	"rate_limited",
	"network",
]);

/** Sends the pending actions one at a time until none is left or the store stops. */
export async function sendPending(deps: SyncDeps): Promise<void> {
	for (let next = deps.get().pending[0]; next !== undefined; next = deps.get().pending[0]) {
		const isRunning = await sendWithRetries(deps, next);
		if (!isRunning) return;
	}
}

/** Sends one action until it is answered; false when the store stopped (a rules version change). */
async function sendWithRetries(deps: SyncDeps, entry: PendingAction): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		const result = await send(deps, entry);
		if (result.ok) return settle(deps, entry, result.farm);

		if (!retried.has(result.error)) {
			deps.undo(entry.idempotencyKey, result.message);
			return true;
		}

		if (attempt === maxRetries) {
			deps.undo(entry.idempotencyKey, givenUp);
			return true;
		}

		await wait(result.retryAfterMs ?? defaultRetryMs);
	}
}

function send(deps: SyncDeps, entry: PendingAction): Promise<ActionResult> {
	return deps.api.sendAction({
		action: entry.action,
		expectedSeq: deps.get().confirmed?.seq ?? 0,
		idempotencyKey: entry.idempotencyKey,
	});
}

function settle(deps: SyncDeps, entry: PendingAction, farm: FarmEnvelope): boolean {
	const rest = withoutAction(deps.get().pending, entry.idempotencyKey);
	return deps.confirm(farm, rest);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

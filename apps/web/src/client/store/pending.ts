import type { Action } from "@sunny-pastures/sim";

/** An action sent to the server and not yet answered. */
export interface PendingAction {
	readonly action: Action;
	/** From `crypto.randomUUID()`; every retry of this action sends the same one (MUST-12.5). */
	readonly idempotencyKey: string;
	/** The time the prediction applied it at, in ms. */
	readonly at: number;
}

/** The pending actions without the one sent with `key`: answered, refused or given up on. */
export function withoutAction(
	pending: readonly PendingAction[],
	key: string,
): readonly PendingAction[] {
	return pending.filter((entry) => entry.idempotencyKey !== key);
}

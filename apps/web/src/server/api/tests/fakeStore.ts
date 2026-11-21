import type { Rules } from "@/server/rules";
import type { Answer, CommitEntry, CommitResult, GameStore } from "@/server/store";

/** What the fake store does on each call, so a test can see which calls a route made. */
export interface FakeStore extends GameStore {
	/** Every store call, in order, by method name. */
	readonly calls: readonly string[];
}

export interface FakeStoreOptions {
	/** Every commit answers `conflict` and writes nothing, as when other commits keep winning. */
	readonly isAlwaysConflicting?: boolean;
	/** Every call rejects with this, as B100 does on an unknown rules version (ADR-0006, s. 8). */
	readonly error?: Error;
}

/**
 * A `GameStore` with one log per farm, for the route tests (a Fake object). `api/` may not import
 * the contract-held in-memory store in `store/tests/` (`.fallowrc.jsonc`: that allowance is
 * `game/`'s tests' only), and the loop itself is `game/`'s, tested there on that store. Here the
 * store only has to keep a log, answer a resend and count its calls.
 */
export function createFakeStore(
	rules: Pick<Rules, "newFarm" | "replay">,
	{ isAlwaysConflicting = false, error }: FakeStoreOptions = {},
): FakeStore {
	const calls: string[] = [];
	const logs = new Map<string, CommitEntry[]>();

	function record(call: string): void {
		calls.push(call);
		if (error !== undefined) throw error;
	}

	return {
		calls,
		async load(playerId) {
			await Promise.resolve();
			record("load");
			const log = logs.get(playerId) ?? [];
			const last = log.at(-1);
			const state = rules.newFarm(playerId);
			if (last === undefined) return { state, seq: 0, at: 0 };

			const rows = log.map(({ action, at }, i) => ({ seq: i + 1, at, action }));
			return { state: rules.replay(state, rows, last.at), seq: log.length, at: last.at };
		},
		async processed(playerId, idempotencyKey) {
			await Promise.resolve();
			record("processed");
			return findAnswer(logs.get(playerId) ?? [], idempotencyKey);
		},
		async commit(playerId, entry): Promise<CommitResult> {
			await Promise.resolve();
			record("commit");
			const log = logs.get(playerId) ?? [];
			const answer = findAnswer(log, entry.idempotencyKey);
			if (answer !== null) return { kind: "duplicate", answer };
			if (isAlwaysConflicting || log.length !== entry.expectedSeq) return { kind: "conflict" };

			logs.set(playerId, [...log, entry]);
			return { kind: "committed", seq: log.length + 1 };
		},
	};
}

function findAnswer(log: readonly CommitEntry[], idempotencyKey: string): Answer | null {
	return log.find((entry) => entry.idempotencyKey === idempotencyKey)?.answer ?? null;
}

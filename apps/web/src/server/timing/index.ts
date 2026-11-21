import "server-only";

// The phases MUST-19.1 reports, in the order the header lists them (ADR-0007, section 3).
const phases = ["load", "sim", "commit", "total"] as const;

/** A phase of a game request: `load` (store reads), `sim`, `commit` (store writes) or `total`. */
export type Phase = (typeof phases)[number];

/** A monotonic clock in milliseconds. `performance.now` in a route, a fake in tests (#394). */
export type Clock = () => number;

/**
 * One request's timings (#329 decision 2, the Decorator). Create one per request: it accumulates,
 * and is never shared between requests.
 */
export interface Timing {
	/**
	 * Runs `fn` and adds its duration to `phase`, then returns what `fn` returns. A promise, or any
	 * thenable, is timed until it settles and comes back as a native promise. A phase that throws
	 * or rejects is still recorded, and its error is rethrown unchanged. A phase run more than once
	 * (a retry) is summed under one name.
	 */
	withTiming<T>(phase: Phase, fn: () => T): T;
	/**
	 * The `Server-Timing` header value for the phases recorded so far, as `name;dur=<ms>` in the
	 * order load, sim, commit, total, each rounded to the microsecond. A phase that never ran is
	 * left out, never sent as 0; `null` when none ran, so the caller sends no header.
	 */
	renderServerTiming(): string | null;
}

/** Starts one request's timings. Durations come from `clock`, never from the sim or `Date.now`. */
export function createTiming(clock: Clock = () => performance.now()): Timing {
	// Retries are summed (ADR-0007, section 3) unrounded: rounding each one before adding would let
	// the error grow with the retries.
	const durations = new Map<Phase, number>();
	const record = (phase: Phase, start: number): void => {
		durations.set(phase, (durations.get(phase) ?? 0) + clock() - start);
	};

	return {
		withTiming<T>(phase: Phase, fn: () => T): T {
			const start = clock();
			let value: T;
			try {
				value = fn();
			} catch (error) {
				record(phase, start);
				throw error;
			}

			if (!isThenable(value)) {
				record(phase, start);
				return value;
			}

			// Any thenable, not only a native promise: Drizzle's query builders are lazy thenables,
			// and an `instanceof Promise` check would time them at 0 ms while the query ran later,
			// outside `load` (MUST-13.9). The caller awaits what it gets back, so a native promise
			// that settles the same way, after recording, stands in for `T`.
			return settle(value, () => {
				record(phase, start);
			}) as T;
		},
		renderServerTiming() {
			const metrics = phases.flatMap((phase) => {
				const ms = durations.get(phase);
				return ms === undefined ? [] : [`${phase};dur=${String(roundToMicroseconds(ms))}`];
			});
			return metrics.length === 0 ? null : metrics.join(", ");
		},
	};
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

async function settle<T>(promise: PromiseLike<T>, onSettled: () => void): Promise<T> {
	try {
		return await promise;
	} finally {
		onSettled();
	}
}

// Microseconds, as the spike's timings (`prototypes/persistence/src/timing.ts`, on the unmerged
// branch `prototype/persistence`): the load run (#388) compares this header with the spike's B100
// baseline (MUST-13.10), and 0.001 ms is far below the 28 ms budget (MUST-13.8).
function roundToMicroseconds(ms: number): number {
	return Math.round(ms * 1000) / 1000;
}

// The next-event loop (ADR-0003, section 2, D6): repeatedly run the earliest automated step at or
// before `to`, in MUST-10.6's order, until none is left. The order is defined here and nowhere else.

/**
 * The kinds of automated step, in the order they run when they fall at the same time
 * (MUST-10.6). A kind's rank is its position here; each new kind is placed deliberately.
 */
const stepKinds = ["ripen"] as const;

export type StepKind = (typeof stepKinds)[number];

/** A change the farm makes by itself at a server time (`GLOSSARY.md`, "Automated step"). */
export interface AutomatedStep {
	/** Server time in integer ms. */
	readonly at: number;
	readonly kind: StepKind;
	/** The facility, pen or plot index, in content order. */
	readonly index: number;
	/** The queue slot, or 0 where there is no queue. */
	readonly slot: number;
}

/** A feature's automated steps: those it has pending, and how one runs. */
export interface StepSource<F> {
	/** Every pending step of this source, in any order. */
	steps(farm: F): readonly AutomatedStep[];
	/** Runs `step` on a farm already at `step.at`. */
	run(farm: F, step: AutomatedStep): F;
}

/** MUST-10.6's key: time, then kind, then index, then slot. Never an object's key order. */
export function compareSteps(a: AutomatedStep, b: AutomatedStep): number {
	return (
		a.at - b.at ||
		stepKinds.indexOf(a.kind) - stepKinds.indexOf(b.kind) ||
		a.index - b.index ||
		a.slot - b.slot
	);
}

/**
 * Runs every automated step at or before `to`, steps at exactly `to` included, so advancing in
 * one call or in several runs the same steps in the same order (MUST-14.1). Returns `farm` itself
 * when `to` is before its time (D7). Throws a RangeError if `to` isn't a safe integer.
 */
export function advanceFarm<F extends { readonly time: number }>(
	farm: F,
	to: number,
	sources: readonly StepSource<F>[],
): F {
	assertTime(to);
	if (to < farm.time) return farm;

	let current = farm;
	for (
		let next = findEarliest(current, to, sources);
		next !== null;
		next = findEarliest(current, to, sources)
	) {
		const at = Math.max(current.time, next.step.at);
		current = next.source.run({ ...current, time: at }, next.step);
	}
	return current.time === to ? current : { ...current, time: to };
}

/** D7: a time that isn't integer ms is a programmer error, not a rule. Throws a RangeError. */
export function assertTime(time: number): void {
	if (!Number.isSafeInteger(time)) {
		throw new RangeError(`A time must be integer ms, got ${String(time)}.`);
	}
}

function findEarliest<F>(
	farm: F,
	to: number,
	sources: readonly StepSource<F>[],
): { source: StepSource<F>; step: AutomatedStep } | null {
	let best: { source: StepSource<F>; step: AutomatedStep } | null = null;
	for (const source of sources) {
		for (const step of source.steps(farm)) {
			if (step.at <= to && (best === null || compareSteps(step, best.step) < 0)) {
				best = { source, step };
			}
		}
	}
	return best;
}

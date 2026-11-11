// The next-event loop (ADR-0003, section 2, D6): repeatedly run the earliest automated step at or
// before `to`, in MUST-10.6's order, until none is left. The order is defined here and nowhere else.

/**
 * The kinds of automated step, in the order they run when they fall at the same time
 * (MUST-10.6). A kind's rank is its position here; each new kind is placed deliberately.
 *
 * - `finishJob` (#84) after `ripen`: neither touches storage, so their rank changes no outcome
 *   today. Kinds that produce goods rank before the kinds that will move or use them (the
 *   Collector and the Loop, #88), so a step sees what was produced at the same time (ADR-0003,
 *   section 12).
 */
const stepKinds = ["ripen", "finishJob"] as const;

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
 * when `to` is before its time (D7).
 *
 * Throws a RangeError if `to` isn't a safe integer, and on a programmer error in a source or the
 * farm: a step before the farm's time, or a step that doesn't come after the one run before it in
 * MUST-10.6's order (a source whose run didn't remove its step would otherwise loop forever).
 */
export function advanceFarm<F extends { readonly time: number }>(
	farm: F,
	to: number,
	sources: readonly StepSource<F>[],
): F {
	assertTime(to);
	if (to < farm.time) return farm;

	let current = farm;
	let ran: AutomatedStep | null = null;
	for (
		let next = findEarliest(current, to, sources);
		next !== null;
		next = findEarliest(current, to, sources)
	) {
		const { source, step } = next;
		assertInOrder(step, ran, current.time);
		current = source.run({ ...current, time: step.at }, step);
		ran = step;
	}
	return current.time === to ? current : { ...current, time: to };
}

/** D7: a time that isn't integer ms is a programmer error, not a rule. Throws a RangeError. */
export function assertTime(time: number): void {
	if (!Number.isSafeInteger(time)) {
		throw new RangeError(`A time must be integer ms, got ${String(time)}.`);
	}
}

/**
 * A step is never overdue: every farm the rules return has run all its steps at or before its time
 * (this loop), and a source schedules steps at or after the time it runs at. One before the farm's
 * time means a corrupt snapshot or a buggy source, so it throws rather than run late (D7).
 */
function assertInOrder(step: AutomatedStep, ran: AutomatedStep | null, time: number): void {
	if (step.at < time) {
		throw new RangeError(
			`An automated step at ${String(step.at)} ms is overdue: the farm is at ${String(time)} ms.`,
		);
	}
	if (ran !== null && compareSteps(step, ran) <= 0) {
		throw new RangeError(
			`An automated step (${step.kind}, index ${String(step.index)}, at ${String(step.at)} ms) doesn't come after the one run before it.`,
		);
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

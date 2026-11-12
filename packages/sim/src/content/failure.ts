// How the content check reports a failure (ADR-0003, section 17): data, never a throw, so one run
// lists every broken rule.
import type { ContentFailure, ContentRule } from "./index.js";

/** MUST-10.4's timer bounds, in whole seconds: 10 s to 24 h. */
const minTimerSeconds = 10;
const maxTimerSeconds = 86_400;

/** A failure of `rule` at `path`, whose value is `value`, for the reason `why`: a full sentence. */
export function fail(rule: ContentRule, path: string, value: unknown, why: string): ContentFailure {
	return { rule, path, message: `${path} is ${formatValue(value)}: ${why}` };
}

/** Whether `seconds` is a timer MUST-10.4 allows: a whole number of seconds from 10 s to 24 h. */
export function isTimer(seconds: number): boolean {
	return Number.isInteger(seconds) && seconds >= minTimerSeconds && seconds <= maxTimerSeconds;
}

/** -0 prints as -0, since String(-0) is "0" and R1 rejects it (D16). */
function formatValue(value: unknown): string {
	if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);

	return JSON.stringify(value);
}

// The farm state and the actions: the persisted format (ADR-0001, action log plus snapshots), so a
// change here meets CONSTRAINTS.md's "Interface change" row. Plain JSON data with readonly types
// (ADR-0003, section 5, D12); the invariants the property tests check are below. Each feature
// module owns its part of the state and its actions (ADR-0005, section 3); this module composes them.
import type { FacilityAction, OwnedFacility } from "../facilities/index.js";
import type { Plot, PlotAction } from "../plots/index.js";

/** A farm at a server time. Facts only: Level and unlocks are derived from content (D12). */
export interface FarmState {
	/** The server time the farm has been advanced to, in integer ms (D7). */
	readonly time: number;
	readonly coins: number;
	readonly xp: number;
	/** Crops by good id. A good has a key only while its count is above 0, so equal farms hash equally. */
	readonly silo: Readonly<Record<string, number>>;
	/** Every other good by good id, keyed as the silo is (MUST-06.4). */
	readonly barn: Readonly<Record<string, number>>;
	/** In content order. */
	readonly plots: readonly Plot[];
	/** One entry per content facility, in content order: null until bought (MUST-05.6). */
	readonly facilities: readonly (OwnedFacility | null)[];
	/** The mulberry32 state of each stream, an unsigned 32-bit integer (ADR-0003, section 7). */
	readonly streams: { readonly yields: number; readonly orders: number };
}

/** Something a player chooses to do, applied at a server time (`GLOSSARY.md`). */
export type Action = PlotAction | FacilityAction;

/** A refusal is data, not a throw, and carries no state (ADR-0003, section 4, D15). */
export type ApplyResult =
	| { readonly ok: true; readonly state: FarmState }
	| { readonly ok: false; readonly reason: string };

/** A refusal (D15). `reason` is a full sentence a player reads, ending in a full stop. */
export function refuse(reason: string): ApplyResult {
	return { ok: false, reason };
}

/**
 * D16 (ADR-0003, section 10): every number in the state is a safe integer, and not -0. Throws on
 * the first number that isn't, naming its path (for example `$.plots[1].grownAt`).
 */
export function assertSafeIntegers(value: unknown): void {
	check(value, "$");
}

function check(value: unknown, path: string): void {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) {
			throw new Error(`${path} is ${String(value)}, not a safe integer`);
		}
		// -0 is a safe integer to JavaScript, but a JSON round trip turns it into 0, so a state holding
		// it wouldn't survive a snapshot unchanged (ADR-0003, section 9).
		if (Object.is(value, -0)) throw new Error(`${path} is -0, not a safe integer for the state`);
	} else if (Array.isArray(value)) {
		value.forEach((item, i) => {
			check(item, `${path}[${String(i)}]`);
		});
	} else if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value)) check(item, `${path}.${key}`);
	}
}

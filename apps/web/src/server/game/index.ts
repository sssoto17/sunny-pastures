import "server-only";

import type { FarmState } from "@sunny-pastures/sim";

import type { PlayerId } from "@/server/auth";
import type { Rules } from "@/server/rules";
import type { FarmRecord, GameStore } from "@/server/store";
import type { Timing } from "@/server/timing";

/**
 * What the game loop runs on (ADR-0007, section 2: dependency injection by argument). `api/`
 * builds one per request, since `timing` accumulates one request's phases.
 */
export interface GameDeps {
	readonly store: GameStore;
	readonly rules: Pick<Rules, "sim" | "rulesVersion">;
	/** This request's recorder: `load` (store reads), `sim` and `commit` (#394). */
	readonly timing: Timing;
	/** Server time in ms (`Date.now` in `api/`). `submitAction` reads it once per request (T1). */
	readonly serverTime: () => number;
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

/** What `loadFarm` found. */
export type LoadResult = { readonly kind: "loaded"; readonly farm: FarmEnvelope } | Busy;

/**
 * The farm can't be served now, and the client retries with the same key (503 `busy`, ADR-0007,
 * section 3, "Errors"). `conflicts`: still conflicting after the last retry, and nothing was
 * written (MUST-13.3). `store`: the store threw, as on an unknown rules version (ADR-0006, sections
 * 5 and 8). The action may be in the log even so (a commit whose reply was lost, or a resend whose
 * fresh load failed), and the retry with the same key then gets its answer. `error` is for the
 * server's log, never for the response body.
 */
export type Busy =
	| { readonly kind: "busy"; readonly cause: "conflicts" }
	| { readonly kind: "busy"; readonly cause: "store"; readonly error: unknown };

/** Reads the player's farm (`GET /api/farm`). Never writes (MUST-11.5). */
export async function loadFarm(deps: GameDeps, playerId: PlayerId): Promise<LoadResult> {
	const loaded = await callStore(deps, "load", () => deps.store.load(playerId));
	if (!loaded.ok) return loaded.busy;

	return { kind: "loaded", farm: buildEnvelope(deps, loaded.value) };
}

/** A store call's value, or the `busy` its throw becomes. */
type Stored<T> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly busy: Busy };

/**
 * Runs one store call, timed as `phase`. A throw is a store error, so it becomes `busy` (ADR-0006,
 * sections 5 and 8), and so is a throw from the `replay` it runs (`@/server/rules`). Only the store
 * is caught: a bug in the loop, or in `apply` or `stateHash`, still throws and reaches the route as
 * a 500.
 */
async function callStore<T>(
	{ timing }: GameDeps,
	phase: "load" | "commit",
	call: () => Promise<T>,
): Promise<Stored<T>> {
	try {
		return { ok: true, value: await timing.withTiming(phase, call) };
	} catch (error) {
		return { ok: false, busy: { kind: "busy", cause: "store", error } };
	}
}

function buildEnvelope({ rules }: GameDeps, { seq, at, state }: FarmRecord): FarmEnvelope {
	return { seq, at, state, rulesVersion: rules.rulesVersion };
}

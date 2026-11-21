import "server-only";

import { stateHash, type Action, type FarmState } from "@sunny-pastures/sim";

import type { PlayerId } from "@/server/auth";
import type { Rules } from "@/server/rules";
import type { Answer, FarmRecord, GameStore } from "@/server/store";
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
	/** Server wall-clock time in ms (`Date.now` in `api/`). `submitAction` reads it once (T1). */
	readonly now: () => number;
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

/** One action as the request checks read it (`ActionRequest` in `http/`, #395). */
export interface SubmitRequest {
	readonly action: Action;
	/** The seq the client last saw. It only sets `answer.rebased` (ADR-0007, section 3). */
	readonly expectedSeq: number;
	/** A UUID scoped to the player's farm (MUST-13.2). */
	readonly idempotencyKey: string;
}

/**
 * What `submitAction` did. `answered`: the action is in the log, now or by an earlier request with
 * the same key; `answer` is the stored one (ADR-0001). `refused`: the rules refused it, nothing was
 * written, and `reason` is the sim's sentence word for word (422, MUST-12.3).
 */
export type SubmitResult =
	| { readonly kind: "answered"; readonly answer: Answer; readonly farm: FarmEnvelope }
	| { readonly kind: "refused"; readonly reason: string }
	| Busy;

/** What `loadFarm` found. */
export type LoadResult = { readonly kind: "loaded"; readonly farm: FarmEnvelope } | Busy;

/**
 * The farm can't be served now; nothing was written, and the client retries with the same key
 * (503 `busy`, ADR-0007, section 3, "Errors"). `conflicts`: still conflicting after the last retry
 * (MUST-13.3). `store`: the store threw, as on an unknown rules version (ADR-0006, sections 5 and
 * 8); `error` is for the server's log, never for the response body.
 */
export type Busy =
	| { readonly kind: "busy"; readonly cause: "conflicts" }
	| { readonly kind: "busy"; readonly cause: "store"; readonly error: unknown };

/** Retries after a conflict, so at most 4 commits per request (MUST-13.3). */
const maxRetries = 3;

/**
 * Runs one action on the player's farm (`POST /api/farm/actions`): ADR-0001's loop, processed →
 * load → advance → apply → commit, retried on a conflict. A key the farm has used gets its stored
 * answer unchanged, even when the action would now be refused (MUST-13.2), with a fresh load as its
 * farm. On `answered` for a new commit, the farm is the one committed, at the action's `at`.
 */
export async function submitAction(
	deps: GameDeps,
	playerId: PlayerId,
	request: SubmitRequest,
): Promise<SubmitResult> {
	const { store, rules, timing } = deps;
	const { action, idempotencyKey } = request;
	// Server time, read once per request and never taken from the client (T1, MUST-11.1): every
	// attempt below starts from it.
	const stampedAt = deps.now();

	const first = await callStore(deps, "load", () => store.processed(playerId, idempotencyKey));
	if (!first.ok) return first.busy;
	if (first.value !== null) return await answerResend(deps, playerId, first.value);

	for (let retries = 0; retries <= maxRetries; retries++) {
		const loaded = await callStore(deps, "load", () => store.load(playerId));
		if (!loaded.ok) return loaded.busy;

		const farm = loaded.value;
		// A request that lost a race loads the winner's action, stamped later than its own: it takes
		// effect at the farm's time instead, as the rules refuse a time before it (ADR-0003, D7), and
		// the loser must still commit on its retry (MUST-13.3). Both times are the server's.
		const at = Math.max(stampedAt, farm.at);
		const step = timing.withTiming("sim", () => runStep(rules, farm, request, at, retries));
		if (!step.ok) return await refuse(deps, playerId, idempotencyKey, step.reason);

		const { next, answer } = step;
		const committed = await callStore(deps, "commit", () =>
			store.commit(playerId, { expectedSeq: farm.seq, action, at, idempotencyKey, next, answer }),
		);
		if (!committed.ok) return committed.busy;

		const outcome = committed.value;
		if (outcome.kind === "committed") {
			return {
				kind: "answered",
				answer,
				farm: toEnvelope(deps, { seq: outcome.seq, at, state: next }),
			};
		}

		// A request with the same key committed between `processed` and this commit.
		if (outcome.kind === "duplicate") return await answerResend(deps, playerId, outcome.answer);

		// `conflict`: another action took the seq and nothing was written, so load it and run again.
	}

	return { kind: "busy", cause: "conflicts" };
}

/** Reads the player's farm (`GET /api/farm`). Never writes (MUST-11.5). */
export async function loadFarm(deps: GameDeps, playerId: PlayerId): Promise<LoadResult> {
	const loaded = await callStore(deps, "load", () => deps.store.load(playerId));
	if (!loaded.ok) return loaded.busy;

	return { kind: "loaded", farm: toEnvelope(deps, loaded.value) };
}

/** One attempt's sim work: the farm after the action, and the answer to commit with it. */
type Step =
	| { readonly ok: true; readonly next: FarmState; readonly answer: Answer }
	| { readonly ok: false; readonly reason: string };

/**
 * Applies the action to the loaded farm at `at`. `apply` advances the farm to `at` before it
 * applies the action (ADR-0003), which is the loop's advance step. `rebased` says the action ran on
 * a farm other than the one the client saw, so its prediction needs reconciling (ADR-0001).
 */
function runStep(
	{ sim }: GameDeps["rules"],
	farm: FarmRecord,
	{ action, expectedSeq }: SubmitRequest,
	at: number,
	retries: number,
): Step {
	const result = sim.apply(farm.state, action, at);
	if (!result.ok) return result;

	const next = result.state;
	return {
		ok: true,
		next,
		answer: {
			seq: farm.seq + 1,
			hash: stateHash(next),
			rebased: expectedSeq !== farm.seq,
			retries,
		},
	};
}

/** The stored answer for a resent key, with the farm as it is now (ADR-0007, section 3). */
async function answerResend(
	deps: GameDeps,
	playerId: PlayerId,
	answer: Answer,
): Promise<SubmitResult> {
	const loaded = await loadFarm(deps, playerId);
	return loaded.kind === "loaded" ? { kind: "answered", answer, farm: loaded.farm } : loaded;
}

/**
 * Before a refusal, asks for the key again: a resend that raced its first commit missed it in
 * `processed`, then loaded that commit, so the rules refused the action a second time. It gets its
 * first answer, not a 422 (ADR-0001, amended 6 Nov after #8).
 */
async function refuse(
	deps: GameDeps,
	playerId: PlayerId,
	idempotencyKey: string,
	reason: string,
): Promise<SubmitResult> {
	const again = await callStore(deps, "load", () => deps.store.processed(playerId, idempotencyKey));
	if (!again.ok) return again.busy;
	if (again.value !== null) return await answerResend(deps, playerId, again.value);

	return { kind: "refused", reason };
}

/** A store call's value, or the `busy` its throw becomes. */
type Stored<T> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly busy: Busy };

/**
 * Runs one store call, timed as `phase`. A throw is a store error, so it becomes `busy` (ADR-0006,
 * sections 5 and 8); the store is the only collaborator caught, so a bug in the loop or the sim
 * still throws and reaches the route as a 500.
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

function toEnvelope({ rules }: GameDeps, { seq, at, state }: FarmRecord): FarmEnvelope {
	return { seq, at, state, rulesVersion: rules.rulesVersion };
}

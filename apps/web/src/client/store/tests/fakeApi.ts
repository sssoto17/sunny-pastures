import { createSim, sliceContent, type Action } from "@sunny-pastures/sim";

import type { FarmEnvelope } from "@/contract";

import type { ActionRequest, ActionResult, Api, ApiFailure, LoadResult } from "../../api";

// A fake `api/` for the store's tests: every call waits until the test answers it, so a test can
// look at the store while a request is in flight.

const sim = createSim(sliceContent);

/** One call the store made, answered by the test with `answer`. */
interface Call<Request, Result> {
	readonly request: Request;
	answer(result: Result): Promise<void>;
}

export interface FakeApi {
	readonly api: Api;
	readonly loads: Call<null, LoadResult>[];
	readonly sends: Call<ActionRequest, ActionResult>[];
}

export function createFakeApi(): FakeApi {
	const loads: Call<null, LoadResult>[] = [];
	const sends: Call<ActionRequest, ActionResult>[] = [];
	return {
		loads,
		sends,
		api: {
			loadFarm: () => wait(loads, null),
			sendAction: (request) => wait(sends, request),
		},
	};
}

function wait<Request, Result>(calls: Call<Request, Result>[], request: Request): Promise<Result> {
	return new Promise((resolve) => {
		calls.push({
			request,
			answer: async (result) => {
				resolve(result);
				await flush();
			},
		});
	});
}

/** Lets the store's awaits run, without moving the fake clock. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A new farm's envelope, at `at` ms with `seq` 0. */
export function newEnvelope(at: number, rulesVersion = 1): FarmEnvelope {
	return { seq: 0, at, state: sim.advance(sim.newFarm("farm-test"), at), rulesVersion };
}

/** What the server would answer for `action` at `at` on `farm`: the next seq. */
export function accept(farm: FarmEnvelope, action: Action, at: number): ActionResult {
	const result = sim.apply(farm.state, action, at);
	if (!result.ok) throw new Error(`The test's action was refused: ${result.reason}`);
	return {
		ok: true,
		answer: { seq: farm.seq + 1, hash: "fake-hash", rebased: false, retries: 0 },
		farm: { seq: farm.seq + 1, at, state: result.state, rulesVersion: farm.rulesVersion },
	};
}

export function failure(
	error: ApiFailure["error"],
	retryAfterMs: number | null = null,
): ApiFailure {
	return { ok: false, error, message: `The server said ${error}.`, retryAfterMs };
}

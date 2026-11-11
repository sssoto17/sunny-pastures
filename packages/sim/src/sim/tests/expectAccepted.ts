import type { ApplyResult, FarmState } from "../../index.js";

/** The state of an accepted result; fails the test on a refusal. */
export function expectAccepted(result: ApplyResult): FarmState {
	if (!result.ok) throw new Error(`refused: ${result.reason}`);

	return result.state;
}

import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { FarmState } from "@sunny-pastures/sim";

import type { FarmHarness } from "@/client/store/tests/clock";
import { newEnvelope } from "@/client/store/tests/fakeApi";

import Game from "../index";

/**
 * Renders the game over `harness`, answers its load with a new farm at `start` ms, 100 XP and
 * `changes` over it, and returns the user to click with. A lot's popover tests share it.
 */
export async function renderLoadedFarm(
	harness: FarmHarness,
	start: number,
	changes: Partial<FarmState>,
) {
	const user = userEvent.setup();
	const envelope = newEnvelope(start);
	const state = { ...envelope.state, xp: 100, ...changes };
	render(<Game store={harness.store} />);
	await act(() => harness.fake.loads[0]?.answer({ ok: true, farm: { ...envelope, state } }));
	return user;
}

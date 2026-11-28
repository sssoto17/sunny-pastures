import { act } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { StoreApi } from "zustand/vanilla";

import { createFarmStore, type FarmStore } from "../index";
import { createFakeApi, type FakeApi } from "./fakeApi";

/**
 * Registers hooks that give a test file the farm's fake clock, starting at `start` ms: the clock
 * and the animation frames are fake; Testing Library's async `act` waits on a real `setTimeout`,
 * so that one stays real. After each test it runs the frames React Aria waits on to restore focus
 * and finish its transitions, so none is held across tests. Register it before the file's own
 * hooks: `afterEach` hooks run in reverse, so the file's own cleanup runs first.
 */
function useFakeFarmClock(start: number): void {
	beforeEach(() => {
		vi.useFakeTimers({
			now: start,
			toFake: [
				"Date",
				"setInterval",
				"clearInterval",
				"requestAnimationFrame",
				"cancelAnimationFrame",
			],
		});
	});

	afterEach(() => {
		act(() => {
			vi.advanceTimersByTime(100);
		});
		vi.useRealTimers();
	});
}

/** The fake API and the store over it, new for each test. */
export interface FarmHarness {
	fake: FakeApi;
	store: StoreApi<FarmStore>;
}

/** `useFakeFarmClock`, plus a fresh fake API and store per test, which it stops afterwards. */
export function useFarmHarness(start: number): FarmHarness {
	useFakeFarmClock(start);
	// Replaced before each test; the first values only give the fields their type.
	const first = createFakeApi();
	const harness: FarmHarness = { fake: first, store: createFarmStore({ api: first.api }) };
	beforeEach(() => {
		harness.fake = createFakeApi();
		harness.store = createFarmStore({ api: harness.fake.api });
	});

	afterEach(() => {
		harness.store.getState().stop();
	});
	return harness;
}

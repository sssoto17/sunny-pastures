import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSim, sliceContent } from "@sunny-pastures/sim";

import { createApi, type Api, type LoadResult } from "@/client/api";
import { createFarmStore } from "@/client/store";

import Game from "../index";

const sim = createSim(sliceContent);
const farm: LoadResult = {
	ok: true,
	farm: { seq: 0, at: 1_000, state: sim.newFarm("farm-game"), rulesVersion: 1 },
};
const failed: LoadResult = {
	ok: false,
	error: "internal",
	message: "The server could not load your farm.",
	retryAfterMs: null,
};

/** Renders the game over an API whose `loadFarm` answers from `results`, one per call. */
function setup(...results: LoadResult[]) {
	const calls: number[] = [];
	const api: Api = {
		loadFarm: () => {
			calls.push(calls.length);
			return Promise.resolve(results[calls.length - 1] ?? failed);
		},
		sendAction: () => Promise.reject(new Error("The game sends nothing yet.")),
	};
	render(<Game store={createFarmStore({ api })} />);
	return calls;
}

describe("Game", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("tells the player, in a status message, that their farm is loading", async () => {
		setup(farm);

		expect(screen.getByRole("status").textContent).toBe("Loading your farm…");
		// Let the load finish inside the test, so its update isn't left outside act.
		await screen.findByRole("group", { name: "Farm map" });
	});

	it("shows the error message with a Try again button when the farm fails to load", async () => {
		setup(failed);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"The server could not load your farm.",
		);
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	});

	it("shows Try again, not loading for good, when the session throws during sign-in (#684)", async () => {
		const logged: unknown[][] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args);
		});
		// Thrown synchronously, as `getBrowserSession` does when the game isn't configured.
		const throwing = (): Promise<string | null> => {
			throw new Error("A fake sign-in error.");
		};
		const store = createFarmStore({
			api: createApi({
				fetch: () => Promise.reject(new Error("The test sends no request.")),
				session: { getAccessToken: throwing, refreshAccessToken: throwing },
			}),
		});
		render(<Game store={store} />);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Your farm could not be loaded. Please try again.",
		);
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
		expect(store.getState().status).toBe("error");
		expect(logged).toHaveLength(1);
		await expect(store.getState().load()).resolves.toBeUndefined();
	});

	it("loads again when the player presses Try again, and shows the farm if it works", async () => {
		const calls = setup(failed, farm);

		await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

		expect(await screen.findByRole("group", { name: "Farm map" })).toBeTruthy();
		expect(calls).toHaveLength(2);
	});

	it("shows the farm map, and no status, once the farm is ready", async () => {
		setup(farm);

		expect(await screen.findByRole("group", { name: "Farm map" })).toBeTruthy();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows the HUD over the map once the farm is ready, and its refusals as toasts", async () => {
		const api: Api = {
			loadFarm: () => Promise.resolve(farm),
			sendAction: () => Promise.reject(new Error("The game sends nothing yet.")),
		};
		const store = createFarmStore({ api });
		render(<Game store={store} />);

		expect(await screen.findByRole("region", { name: "Farm status" })).toBeTruthy();

		act(() => {
			store.setState({ lastRefusal: "Nothing is ready to harvest." });
		});

		expect(screen.getByRole("alert").textContent).toBe("Nothing is ready to harvest.");
	});

	it("shows the Orders button over the map once the farm is ready", async () => {
		setup(farm);

		expect(await screen.findByRole("button", { name: /^Orders/ })).toBeTruthy();
	});
});

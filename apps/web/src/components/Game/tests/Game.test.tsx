import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "@sunny-pastures/sim";

import type { Api, LoadResult } from "@/client/api";
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
});

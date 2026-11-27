import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSim, sliceContent, type FarmState } from "@sunny-pastures/sim";

import { createFarmStore, selectLevel, type FarmStore } from "@/client/store";
import { accept, createFakeApi, failure, type FakeApi } from "@/client/store/tests/fakeApi";
import type { FarmEnvelope } from "@/contract";

import { LevelUp } from "../index";

const sim = createSim(sliceContent);
const start = 1_000_000;
const shownKey = "sunny-pastures:level-shown";
const harvest = { type: "harvest", plot: 0 } as const;

/** A farm at `xp`, its first plot holding ripe wheat: a harvest gives 1 XP (`sliceContent`). */
function farmAt(xp: number): FarmEnvelope {
	const farm = sim.advance(sim.newFarm("farm-test"), start);
	const plots = farm.plots.map((plot, i) => (i === 0 ? { status: "ready", crop: "wheat" } : plot));
	const state: FarmState = { ...farm, xp, plots: plots as FarmState["plots"] };
	return { seq: 0, at: start, state, rulesVersion: 1 };
}

let fake: FakeApi;
let store: ReturnType<typeof createFarmStore>;
const state = (): FarmStore => store.getState();

beforeEach(() => {
	localStorage.clear();
	// Only the farm's clock is fake: React Aria and user-event keep their real timers.
	vi.useFakeTimers({ now: start, toFake: ["Date", "setInterval", "clearInterval"] });
});

afterEach(() => {
	store.getState().stop();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Renders the dialog over a store that loads `farm`, with the Level last shown already stored. */
async function setup(farm: FarmEnvelope, shown: string | null) {
	if (shown !== null) localStorage.setItem(shownKey, shown);
	fake = createFakeApi();
	store = createFarmStore({ api: fake.api });
	render(<LevelUp store={store} />);
	const loading = state().load();
	await act(() => fake.loads[0]?.answer({ ok: true, farm }));
	await act(() => loading);
}

/** Harvests the first plot, and answers it as the server would on `farm`. */
async function harvestConfirmed(farm: FarmEnvelope) {
	act(() => {
		state().act(harvest);
	});
	await act(() => fake.sends[0]?.answer(accept(farm, harvest, start)));
}

describe("LevelUp", () => {
	it("opens once a harvest that crosses Level 2 is confirmed, naming the feed mill", async () => {
		const farm = farmAt(9);
		await setup(farm, "1");

		act(() => {
			state().act(harvest);
		});

		expect(selectLevel(state())).toBe(2);
		expect(screen.queryByRole("dialog")).toBeNull();

		await act(() => fake.sends[0]?.answer(accept(farm, harvest, start)));

		const dialog = screen.getByRole("dialog", { name: "You reached Level 2" });
		expect(within(dialog).getByText("Feed mill, unlocked to buy")).toBeTruthy();
		expect(within(dialog).getByText("20 level-up coins")).toBeTruthy();
		expect(localStorage.getItem(shownKey)).toBe("1");
	});

	it("never opens for a refused harvest, whose predicted Level rolls back", async () => {
		await setup(farmAt(9), "1");

		act(() => {
			state().act(harvest);
		});
		await act(() => fake.sends[0]?.answer(failure("refused")));

		expect(selectLevel(state())).toBe(1);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on Continue and stores the Level shown, so a reload doesn't open it again", async () => {
		const farm = farmAt(9);
		await setup(farm, "1");
		await harvestConfirmed(farm);

		await userEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(localStorage.getItem(shownKey)).toBe("2");
	});

	it("opens on load when the Level is higher than the one last shown, listing each Level", async () => {
		await setup(farmAt(35), "1");

		const dialog = screen.getByRole("dialog", { name: "You reached Level 3" });
		const level2 = within(dialog).getByRole("region", { name: "Level 2" });
		const level3 = within(dialog).getByRole("region", { name: "Level 3" });
		expect(within(level2).getByText("Feed mill, unlocked to buy")).toBeTruthy();
		expect(within(level2).getByText("20 level-up coins")).toBeTruthy();
		expect(within(level3).getByText("Bakery, unlocked to buy")).toBeTruthy();
		expect(within(level3).getByText("30 level-up coins")).toBeTruthy();
	});

	it("stays closed on a first visit, and remembers the Level it found", async () => {
		await setup(farmAt(35), null);

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(localStorage.getItem(shownKey)).toBe("3");
	});

	it("stays closed when the stored Level is above the farm's, which is another farm's", async () => {
		await setup(farmAt(0), "5");

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(localStorage.getItem(shownKey)).toBe("1");
	});

	it("still opens, and closes for good, when the browser blocks storage", async () => {
		const blocked = () => {
			throw new DOMException("The storage is blocked.", "SecurityError");
		};
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
		const farm = farmAt(9);
		await setup(farm, null);
		await harvestConfirmed(farm);

		await userEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

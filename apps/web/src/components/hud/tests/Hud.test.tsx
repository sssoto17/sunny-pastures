import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { createSim, sliceContent, type FarmState } from "@sunny-pastures/sim";

import type { Api } from "@/client/api";
import { createFarmStore } from "@/client/store";
import { ToastRegion } from "@/components/ui";

import { Hud } from "../index";

const sim = createSim(sliceContent);

const api: Api = {
	loadFarm: () =>
		Promise.resolve({
			ok: true,
			farm: { seq: 0, at: 1_000, state: sim.newFarm("farm-hud"), rulesVersion: 1 },
		}),
	sendAction: () => Promise.reject(new Error("The HUD sends nothing.")),
};

/** A store that has loaded a new farm, at 1 s. */
async function loadStore() {
	const store = createFarmStore({ api });
	await store.getState().load();
	store.getState().stop();
	return store;
}

type FarmStoreApi = Awaited<ReturnType<typeof loadStore>>;

/** Replaces part of the predicted farm, as a confirmed answer or a tick would. */
function changeFarm(store: FarmStoreApi, change: Partial<FarmState>) {
	const { predicted } = store.getState();
	if (predicted === null) throw new Error("The store has no farm.");

	act(() => {
		store.setState({ predicted: { ...predicted, ...change } });
	});
}

describe("Hud", () => {
	it("shows nothing until the farm loads", () => {
		render(<Hud store={createFarmStore({ api })} />);

		expect(screen.queryByRole("region", { name: "Farm status" })).toBeNull();
	});

	it("shows the farm's coins and updates them when the store changes", async () => {
		const store = await loadStore();
		render(<Hud store={store} />);

		const hud = screen.getByRole("region", { name: "Farm status" });
		expect(within(hud).getByText("50 coins")).toBeTruthy();

		changeFarm(store, { coins: 1234 });

		expect(within(hud).getByText("1,234 coins")).toBeTruthy();
	});

	it("shows the Level, with the XP toward the next Level as a meter", async () => {
		const store = await loadStore();
		render(<Hud store={store} />);

		const meter = screen.getByRole("meter", { name: "Level 1" });
		expect(meter.getAttribute("aria-valuetext")).toBe("0 of 10 XP to Level 2");

		// The slice's Level table: Level 2 at 10 XP, Level 3 at 30.
		changeFarm(store, { xp: 15 });

		const next = screen.getByRole("meter", { name: "Level 2" });
		expect(next.getAttribute("aria-valuetext")).toBe("5 of 20 XP to Level 3");
		expect(next.getAttribute("aria-valuenow")).toBe("5");
		expect(next.getAttribute("aria-valuemax")).toBe("20");
	});

	it("shows a full meter at the top Level, with the XP the farm has", async () => {
		const store = await loadStore();
		render(<Hud store={store} />);

		// The slice's top Level, 5, is reached at 100 XP.
		changeFarm(store, { xp: 140 });

		const meter = screen.getByRole("meter", { name: "Level 5" });
		expect(meter.getAttribute("aria-valuetext")).toBe("140 XP, the top Level");
		expect(meter.getAttribute("aria-valuenow")).toBe(meter.getAttribute("aria-valuemax"));
	});

	it("shows how full the silo and the barn are as meters", async () => {
		const store = await loadStore();
		render(<Hud store={store} />);

		changeFarm(store, { silo: { wheat: 12 }, barn: { egg: 3, chickenFeed: 4 } });

		const silo = screen.getByRole("meter", { name: "Silo" });
		expect(silo.getAttribute("aria-valuetext")).toBe("12 of 50");
		const barn = screen.getByRole("meter", { name: "Barn" });
		expect(barn.getAttribute("aria-valuetext")).toBe("7 of 50");
		expect(barn.getAttribute("aria-valuenow")).toBe("7");
	});

	it("lists what the silo and the barn hold in a popover from the Storage button", async () => {
		const user = userEvent.setup();
		const store = await loadStore();
		render(<Hud store={store} />);
		changeFarm(store, { silo: {}, barn: { egg: 3, chickenFeed: 4 } });

		await user.click(screen.getByRole("button", { name: "Storage" }));

		const popover = screen.getByRole("dialog", { name: "Storage" });
		const silo = within(popover).getByRole("list", { name: "Silo" });
		expect(
			within(silo)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["Empty"]);
		const barn = within(popover).getByRole("list", { name: "Barn" });
		expect(
			within(barn)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["Chicken feed: 4", "Eggs: 3"]);
	});

	it("names a good the HUD has no name for by its id", async () => {
		const user = userEvent.setup();
		const store = await loadStore();
		render(<Hud store={store} />);
		changeFarm(store, { barn: { jam: 2 } });

		await user.click(screen.getByRole("button", { name: "Storage" }));

		const barn = screen.getByRole("list", { name: "Barn" });
		expect(within(barn).getByRole("listitem").textContent).toBe("jam: 2");
	});

	it("shows a refusal as a toast and clears it, so the same refusal shows again", async () => {
		const store = await loadStore();
		render(
			<>
				<Hud store={store} />
				<ToastRegion />
			</>,
		);
		const harvest = { type: "harvest", plot: 0 } as const;
		const { predicted, now } = store.getState();
		const refused = predicted === null ? null : sim.apply(predicted, harvest, now);
		if (refused === null || refused.ok) throw new Error("Harvesting an empty plot was allowed.");

		act(() => {
			store.getState().act(harvest);
		});

		expect(screen.getByRole("alert").textContent).toBe(refused.reason);
		expect(store.getState().lastRefusal).toBeNull();

		act(() => {
			store.getState().act(harvest);
		});

		expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
			refused.reason,
			refused.reason,
		]);
	});
});

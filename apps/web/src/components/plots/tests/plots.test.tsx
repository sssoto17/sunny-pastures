import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sliceContent } from "@sunny-pastures/sim";

import { createFarmStore, selectStorage } from "@/client/store";
import {
	accept,
	createFakeApi,
	failure,
	newEnvelope,
	type FakeApi,
} from "@/client/store/tests/fakeApi";

import Game from "../../Game";
import { getLotTile } from "../../map/tests/press";
import { formatTimeLeft } from "../index";

const start = 1_000_000;
const growMs = sliceContent.crops.wheat.growSeconds * 1000;

let fake: FakeApi;
let store: ReturnType<typeof createFarmStore>;

beforeEach(() => {
	// The farm's clock and the animation frames are fake; Testing Library's async `act` waits on a
	// real `setTimeout`, so that one stays real.
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
	fake = createFakeApi();
	store = createFarmStore({ api: fake.api });
});

afterEach(() => {
	store.getState().stop();
	// React Aria waits a frame to restore focus and finish its transitions; run the frames left, so
	// none is held across tests.
	flushFrames();
	vi.useRealTimers();
});

function flushFrames() {
	act(() => {
		vi.advanceTimersByTime(100);
	});
}

/** Renders the game and answers its load with `envelope`, so the map is on screen. */
async function renderFarm(envelope = newEnvelope(start)) {
	const user = userEvent.setup();
	render(<Game store={store} />);
	await act(() => fake.loads[0]?.answer({ ok: true, farm: envelope }));
	return { user, envelope };
}

/** Opens Plot `n`'s popover by its lot, whatever its state, and returns the dialog. */
async function openPlot(user: ReturnType<typeof userEvent.setup>, n: number) {
	await user.click(getLotTile(new RegExp(`^Plot ${String(n)}:`)));
	return screen.getByRole("dialog", { name: `Plot ${String(n)}` });
}

function spriteOf(name: string): string | null {
	return screen.getByRole("button", { name }).querySelector("img")?.getAttribute("src") ?? null;
}

describe("PlotPopover", () => {
	it("plants wheat, counts down, ripens on the clock and harvests into the silo", async () => {
		const { user, envelope } = await renderFarm();
		expect(spriteOf("Plot 1: empty")).toMatch(/plot-empty/);

		let dialog = await openPlot(user, 1);
		expect(within(dialog).getByText("Wheat: 2 coins")).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Plant wheat" }));

		// The prediction shows at once, before the server answers (MUST-12).
		const growing = within(dialog).getByText("Wheat is growing: 2 min left.");
		expect(document.activeElement).toBe(growing);
		expect(fake.sends[0]?.request.action).toEqual({ type: "plant", plot: 0, crop: "wheat" });
		await act(() => fake.sends[0]?.answer(accept(envelope, fake.sends[0].request.action, start)));

		act(() => {
			vi.advanceTimersByTime(30_000);
		});
		expect(within(dialog).getByText("Wheat is growing: 1 min 30 s left.")).toBeTruthy();
		await user.keyboard("{Escape}");
		expect(spriteOf("Plot 1: wheat, growing")).toMatch(/plot-growing/);

		act(() => {
			vi.advanceTimersByTime(growMs - 30_000);
		});
		expect(spriteOf("Plot 1: wheat, ready")).toMatch(/plot-ready/);
		dialog = await openPlot(user, 1);
		expect(within(dialog).getByText("Wheat is ready.")).toBeTruthy();
		expect(selectStorage(store.getState())?.silo.goods["wheat"]).toBeUndefined();
		await user.click(within(dialog).getByRole("button", { name: "Harvest wheat" }));

		expect(fake.sends[1]?.request.action).toEqual({ type: "harvest", plot: 0 });
		expect(selectStorage(store.getState())?.silo.goods["wheat"]).toBeGreaterThanOrEqual(2);
		expect(within(dialog).getByText("Plot 1 is empty.")).toBeTruthy();
		await user.keyboard("{Escape}");
		expect(spriteOf("Plot 1: empty")).toMatch(/plot-empty/);
	});

	it("rolls the plot back when the server refuses a planting, and the HUD shows why", async () => {
		const { user } = await renderFarm();
		const dialog = await openPlot(user, 2);
		await user.click(within(dialog).getByRole("button", { name: "Plant wheat" }));

		await act(() => fake.sends[0]?.answer(failure("refused")));

		expect(within(dialog).getByRole("button", { name: "Plant wheat" })).toBeTruthy();
		await user.keyboard("{Escape}");
		expect(screen.getByRole("button", { name: "Plot 2: empty" })).toBeTruthy();
		// The HUD is the one reader of `lastRefusal` (#600): it shows the reason as a toast.
		expect(screen.getByRole("alert").textContent).toBe("The server said refused.");
	});

	it("disables a crop the farm can't afford, says why, and never sends it", async () => {
		const poor = newEnvelope(start);
		const { user } = await renderFarm({ ...poor, state: { ...poor.state, coins: 1 } });
		const dialog = await openPlot(user, 1);

		const plant = within(dialog).getByRole("button", { name: "Plant wheat" });
		expect(plant.hasAttribute("disabled")).toBe(true);
		expect(
			within(dialog).getByText("Planting wheat costs 2 coins, and the farm has 1."),
		).toBeTruthy();
		await user.click(plant);
		expect(fake.sends).toHaveLength(0);
	});

	it("opens from the keyboard, keeps its keys from the map, and Escape returns focus to the lot", async () => {
		const { user } = await renderFarm();
		const lot = screen.getByRole("button", { name: "Plot 1: empty" });
		await user.tab();
		await user.tab();
		expect(document.activeElement).toBe(lot);
		await user.keyboard("{Enter}");

		const dialog = screen.getByRole("dialog", { name: "Plot 1" });
		await user.tab();
		expect(dialog.contains(document.activeElement)).toBe(true);
		// Keys pressed in the popover stay there: the map behind it doesn't pan or zoom.
		const map = screen.getByRole("group", { name: "Farm map", hidden: true });
		const { transform } = (map.firstElementChild as HTMLElement).style;
		act(() => {
			within(dialog).getByText("Plot 1 is empty.").focus();
		});
		await user.keyboard("{ArrowLeft}+0");
		expect((map.firstElementChild as HTMLElement).style.transform).toBe(transform);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		flushFrames();
		expect(document.activeElement).toBe(lot);
	});
});

describe("formatTimeLeft", () => {
	it("shows the two largest units, rounding a part second up", () => {
		expect(formatTimeLeft(45_000)).toBe("45 s");
		expect(formatTimeLeft(400)).toBe("1 s");
		expect(formatTimeLeft(120_000)).toBe("2 min");
		expect(formatTimeLeft(90_500)).toBe("1 min 31 s");
		expect(formatTimeLeft(3_900_000)).toBe("1 h 5 min");
		expect(formatTimeLeft(3_605_000)).toBe("1 h");
	});

	it("never shows a negative time", () => {
		expect(formatTimeLeft(0)).toBe("0 s");
		expect(formatTimeLeft(-5_000)).toBe("0 s");
	});
});

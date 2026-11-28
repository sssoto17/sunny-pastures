import { act, screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FarmState, OwnedPen } from "@sunny-pastures/sim";

import { selectStorage } from "@/client/store";
import { useFarmHarness } from "@/client/store/tests/clock";

import { renderLoadedFarm } from "../../Game/tests/loaded";
import { getLotTile } from "../../map/tests/press";

const start = 1_000_000;

const harness = useFarmHarness(start);

const emptyPen: OwnedPen = {
	trough: 0,
	animals: [{ status: "idle" }, { status: "idle" }, { status: "idle" }],
	products: 0,
};

/** A farm with the chicken pen bought and no feed in the barn, `changes` over a new farm. */
function renderFarm(changes: Partial<FarmState>) {
	return renderLoadedFarm(harness, start, { pens: [emptyPen], ...changes });
}

function isOff(popover: HTMLElement, name: string): boolean {
	return within(popover).getByRole("button", { name }).hasAttribute("disabled");
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
	await user.click(getLotTile(/^Chicken pen/));
	return screen.getByRole("dialog", { name: "Chicken pen" });
}

describe("PenPopover", () => {
	it("shows the chickens, the trough, the next egg's time left and the eggs waiting", async () => {
		const pen: OwnedPen = {
			trough: 0,
			animals: [
				{ status: "producing", readyAt: start + 90_000 },
				{ status: "producing", readyAt: start + 150_000 },
				{ status: "idle" },
			],
			products: 2,
		};
		const user = await renderFarm({ pens: [pen] });

		const popover = await openPopover(user);

		expect(within(popover).getByText("3 chickens, 1 waiting for feed")).toBeTruthy();
		expect(within(popover).getByRole("meter", { name: "Trough" })).toBeTruthy();
		expect(within(popover).getByText("0 of 1 portions")).toBeTruthy();
		expect(within(popover).getByText("Next egg in 1 min 30 s.")).toBeTruthy();
		expect(within(popover).getByText("Eggs waiting: 2")).toBeTruthy();
	});

	it("disables Feed with the sim's reason when the barn holds no feed", async () => {
		const user = await renderFarm({});
		const popover = await openPopover(user);
		expect(isOff(popover, "Feed")).toBe(true);
		expect(
			within(popover).getByText("Feeding the chickenPen needs 1 chickenFeed, and the barn has 0."),
		).toBeTruthy();
		expect(isOff(popover, "Collect eggs")).toBe(true);
		expect(harness.fake.sends).toHaveLength(0);
	});

	it("says one chicken, not one chickens, for a pen of one", async () => {
		const one: OwnedPen = { trough: 0, animals: [{ status: "idle" }], products: 0 };
		const user = await renderFarm({ pens: [one] });

		const popover = await openPopover(user);

		expect(within(popover).getByText("1 chicken, 1 waiting for feed")).toBeTruthy();
	});

	it("says the trough is full when it is", async () => {
		const full: OwnedPen = {
			trough: 1,
			animals: [{ status: "idle" }],
			products: 0,
		};
		const user = await renderFarm({ pens: [full], barn: { chickenFeed: 2 } });

		const popover = await openPopover(user);

		expect(isOff(popover, "Feed")).toBe(true);
		expect(within(popover).getByText(/trough is full/)).toBeTruthy();
	});

	it("feeds, lays an egg after the production time, and collect puts it in the barn", async () => {
		const user = await renderFarm({ barn: { chickenFeed: 1 } });
		const popover = await openPopover(user);

		await user.click(within(popover).getByRole("button", { name: "Feed" }));
		expect(harness.fake.sends[0]?.request.action).toEqual({ type: "feed", pen: 0 });
		expect(within(popover).getByText("Next egg in 3 min.")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(180_000);
		});
		expect(within(popover).getByText("Eggs waiting: 1")).toBeTruthy();
		expect(screen.getByText("1 egg waiting")).toBeTruthy();

		await user.click(within(popover).getByRole("button", { name: "Collect eggs" }));
		expect(selectStorage(harness.store.getState())?.barn.goods["egg"]).toBe(1);
		expect(within(popover).getByText("Eggs waiting: 0")).toBeTruthy();
		expect(screen.queryByText("1 egg waiting")).toBeNull();
	});
});

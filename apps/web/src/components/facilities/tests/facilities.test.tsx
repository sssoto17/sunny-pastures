import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sliceContent, type FarmState, type OwnedFacility } from "@sunny-pastures/sim";

import { selectStorage } from "@/client/store";
import { useFarmHarness } from "@/client/store/tests/clock";
import { newEnvelope } from "@/client/store/tests/fakeApi";

import Game from "../../Game";
import { getLotTile } from "../../map/tests/press";

const start = 1_000_000;

const harness = useFarmHarness(start);

function owned(tier: number, jobs: OwnedFacility["jobs"] = []): OwnedFacility {
	return { tier, jobs, lastRecipe: null, addOns: { loop: false, collector: false } };
}

/** A farm with both facilities bought, `changes` over a new farm, rendered once its load answers. */
async function renderFarm(changes: Partial<FarmState>) {
	const user = userEvent.setup();
	const envelope = newEnvelope(start);
	const state = {
		...envelope.state,
		xp: 100,
		silo: { wheat: 10 },
		facilities: [owned(1), owned(2)],
		...changes,
	};
	render(<Game store={harness.store} />);
	await act(() => harness.fake.loads[0]?.answer({ ok: true, farm: { ...envelope, state } }));
	return user;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>, name: string) {
	await user.click(getLotTile(name));
	const popover = screen.getByRole("dialog", { name });
	await user.click(within(popover).getByRole("button", { name: "Open" }));
	return screen.getByRole("dialog", { name });
}

describe("FacilityPopover", () => {
	it("shows the queue in the popover, and Open opens a dialog titled with the facility", async () => {
		const running = { status: "running", recipe: "chickenFeed", readyAt: start + 60_000 } as const;
		const user = await renderFarm({ facilities: [owned(1, [running]), owned(2)] });

		await user.click(getLotTile("Feed mill"));
		const popover = screen.getByRole("dialog", { name: "Feed mill" });
		expect(within(popover).getByText("Slot 1: chicken feed, running, 1 min left")).toBeTruthy();
		expect(within(popover).getByText("Slot 2: empty")).toBeTruthy();
		await user.click(within(popover).getByRole("button", { name: "Open" }));

		expect(screen.getByRole("heading", { name: "Feed mill" })).toBeTruthy();
	});

	it("makes chicken feed from wheat at the feed mill, and collect moves it to the barn", async () => {
		const user = await renderFarm({});
		const dialog = await openDialog(user, "Feed mill");
		expect(within(dialog).getByText("Wheat: have 10, need 2")).toBeTruthy();
		expect(within(dialog).getByText("Takes 1 min")).toBeTruthy();

		await user.click(within(dialog).getByRole("button", { name: "Start chicken feed" }));
		expect(harness.fake.sends[0]?.request.action).toEqual({
			type: "startJob",
			facility: 0,
			recipe: "chickenFeed",
		});
		expect(within(dialog).getByText("Wheat: have 8, need 2")).toBeTruthy();
		expect(within(dialog).getByText("Slot 1: chicken feed, running, 1 min left")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(within(dialog).getByText("Slot 1: chicken feed, done")).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Collect" }));

		expect(selectStorage(harness.store.getState())?.barn.goods["chickenFeed"]).toBe(2);
		expect(within(dialog).getByText("Slot 1: empty")).toBeTruthy();
	});

	it("makes cookies from wheat and eggs at the bakery", async () => {
		const user = await renderFarm({ barn: { egg: 2 } });
		const dialog = await openDialog(user, "Bakery");
		expect(within(dialog).getByText("Eggs: have 2, need 2")).toBeTruthy();

		await user.click(within(dialog).getByRole("button", { name: "Start cookies" }));

		const stored = selectStorage(harness.store.getState());
		expect(stored?.silo.goods["wheat"]).toBe(8);
		expect(stored?.barn.goods["egg"]).toBeUndefined();
		expect(within(dialog).getByText(/Slot 1: cookies, running/)).toBeTruthy();
	});

	it("disables Start with the sim's reason for a missing input, a locked recipe and a full queue", async () => {
		const running = { status: "running", recipe: "chickenFeed", readyAt: start + 60_000 } as const;
		const user = await renderFarm({
			silo: { wheat: 1 },
			facilities: [owned(1, [running, running]), owned(1)],
		});

		const mill = await openDialog(user, "Feed mill");
		expect(
			within(mill).getByRole("button", { name: "Start chicken feed" }).hasAttribute("disabled"),
		).toBe(true);
		expect(within(mill).getByText(/queue is full/)).toBeTruthy();
		await user.keyboard("{Escape}");

		const bakery = await openDialog(user, "Bakery");
		expect(
			within(bakery).getByRole("button", { name: "Start cookies" }).hasAttribute("disabled"),
		).toBe(true);
		expect(within(bakery).getByText(/makes cookies from tier 2/)).toBeTruthy();
		expect(within(bakery).getByText(/Making bread/)).toBeTruthy();
		expect(harness.fake.sends).toHaveLength(0);
	});

	it("refuses to collect into a full barn, says why, and shows the done goods on the map", async () => {
		const done = { status: "done", recipe: "chickenFeed" } as const;
		const user = await renderFarm({
			barn: { bread: sliceContent.barn.capacity - 1 },
			facilities: [owned(1, [done]), owned(2)],
		});
		expect(screen.getByText("1 ready")).toBeTruthy();

		const dialog = await openDialog(user, "Feed mill");

		expect(within(dialog).getByRole("button", { name: "Collect" }).hasAttribute("disabled")).toBe(
			true,
		);
		expect(within(dialog).getByText(/barn/i)).toBeTruthy();
		expect(harness.fake.sends).toHaveLength(0);
	});
});

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSim, sliceContent, type FarmState } from "@sunny-pastures/sim";

import type { Api } from "@/client/api";
import { createFarmStore, selectCoins, type FarmStore } from "@/client/store";

import { OrderBoard } from "../index";

const sim = createSim(sliceContent);
const start = 1_000_000;

// The seed "farm-test" draws three wheat orders: 3, 4 and 6 wheat. With 4 wheat in the silo, the
// first two can be delivered and the third is short by 2.
const seeded: FarmState = sim.advance({ ...sim.newFarm("farm-test"), silo: { wheat: 4 } }, start);

/** A fake game API that answers every action as the server would, with the same sim. */
function createFakeServer(state: FarmState): Api {
	let farm = { seq: 0, at: start, state, rulesVersion: 1 };
	return {
		loadFarm: () => Promise.resolve({ ok: true, farm }),
		sendAction: ({ action }) => {
			const at = Math.max(Date.now(), farm.at);
			const result = sim.apply(farm.state, action, at);
			if (!result.ok) {
				return Promise.resolve({
					ok: false,
					error: "refused",
					message: result.reason,
					retryAfterMs: null,
				});
			}

			farm = { seq: farm.seq + 1, at, state: result.state, rulesVersion: 1 };
			return Promise.resolve({
				ok: true,
				answer: { seq: farm.seq, hash: "fake-hash", rebased: false, retries: 0 },
				farm,
			});
		},
	};
}

let store: ReturnType<typeof createFarmStore>;
const state = (): FarmStore => store.getState();

beforeEach(() => {
	// Only the farm's clock is fake: the store's tick and `Date.now`. React Aria and user-event keep
	// their real timeouts and animation frames.
	vi.useFakeTimers({ now: start, toFake: ["Date", "setInterval", "clearInterval"] });
});

afterEach(() => {
	store.getState().stop();
	vi.useRealTimers();
});

async function setup(farm = seeded) {
	store = createFarmStore({ api: createFakeServer(farm) });
	await act(() => state().load());
	render(<OrderBoard store={store} />);
	return userEvent.setup();
}

async function openBoard(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: /^Orders/ }));
	return screen.getByRole("dialog", { name: "Orders" });
}

/** Opens the board and presses Discard on the short third order. */
async function askToDiscardThird() {
	const user = await setup();
	const board = await openBoard(user);
	await user.click(within(getSlot(board, 3)).getByRole("button", { name: "Discard" }));
	return { user, board, confirm: screen.getByRole("dialog", { name: "Discard order 3?" }) };
}

function getSlot(board: HTMLElement, number: number): HTMLElement {
	return within(board).getByRole("listitem", { name: `Order ${String(number)}` });
}

describe("OrderBoard", () => {
	it("counts the orders the farm can deliver on the Orders button", async () => {
		await setup();

		expect(screen.getByRole("button", { name: "Orders 2 to deliver" })).toBeTruthy();
	});

	it("names the Orders button without a count when nothing can be delivered", async () => {
		await setup(sim.advance(sim.newFarm("farm-test"), start));

		expect(screen.getByRole("button", { name: "Orders" })).toBeTruthy();
	});

	it("shows each open order's goods with have and need, and what it pays", async () => {
		const user = await setup();
		const board = await openBoard(user);

		const slot = getSlot(board, 1);
		expect(within(slot).getByText("Wheat: have 4, need 3")).toBeTruthy();
		expect(within(slot).getByText("Pays 9 coins and 3 XP")).toBeTruthy();
		expect(within(board).getAllByRole("listitem", { name: /^Order \d$/ })).toHaveLength(3);
	});

	it("delivers a deliverable order: it pays, and the slot shows its refill time", async () => {
		const user = await setup();
		const board = await openBoard(user);

		await user.click(within(getSlot(board, 1)).getByRole("button", { name: "Deliver" }));

		expect(selectCoins(state())).toBe(50 + 9);
		expect(state().predicted?.silo).toEqual({ wheat: 1 });
		expect(within(getSlot(board, 1)).getByText("New order in 2 min")).toBeTruthy();
		expect(document.activeElement).toBe(within(board).getByRole("heading", { name: "Order 1" }));
		// The open dialog hides the page behind it from the accessibility tree.
		expect(screen.getByRole("button", { name: "Orders", hidden: true })).toBeTruthy();
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(state().pending).toEqual([]);
		expect(state().confirmed?.state.coins).toBe(50 + 9);
	});

	it("disables Deliver on a short order and says what is missing", async () => {
		const user = await setup();
		const board = await openBoard(user);
		const slot = getSlot(board, 3);

		const deliver = within(slot).getByRole("button", { name: "Deliver" });
		expect(deliver.hasAttribute("disabled")).toBe(true);
		expect(within(slot).getByText("You need 2 more wheat to deliver this order.")).toBeTruthy();
		await user.click(deliver);
		expect(state().pending).toEqual([]);
	});

	it("asks before discarding, and keeps the order when the player says no", async () => {
		const { user, board, confirm } = await askToDiscardThird();
		await user.click(within(confirm).getByRole("button", { name: "Keep it" }));

		expect(screen.queryByRole("dialog", { name: "Discard order 3?" })).toBeNull();
		expect(state().pending).toEqual([]);
		expect(within(getSlot(board, 3)).getByText("Wheat: have 4, need 6")).toBeTruthy();
	});

	it("discards on confirm: the slot shows its refill time, and the clock refills it", async () => {
		const { user, board, confirm } = await askToDiscardThird();
		await user.click(within(confirm).getByRole("button", { name: "Discard order" }));

		expect(within(getSlot(board, 3)).getByText("New order in 5 min")).toBeTruthy();
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(within(board).getByRole("heading", { name: "Order 3" }));
		});
		await act(() => vi.advanceTimersByTimeAsync(61_000));
		expect(within(getSlot(board, 3)).getByText("New order in 3 min 59 s")).toBeTruthy();
		await act(() => vi.advanceTimersByTimeAsync(239_000));
		expect(within(getSlot(board, 3)).queryByText(/New order in/)).toBeNull();
		expect(within(getSlot(board, 3)).getByRole("button", { name: "Deliver" })).toBeTruthy();
	});

	it("closes with the Close button", async () => {
		const user = await setup();
		const board = await openBoard(user);

		await user.click(within(board).getByRole("button", { name: "Close" }));

		expect(screen.queryByRole("dialog", { name: "Orders" })).toBeNull();
	});
});

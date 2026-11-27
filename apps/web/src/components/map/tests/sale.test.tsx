import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { createSim, sliceContent, type Action, type FarmState } from "@sunny-pastures/sim";

import { FarmMap } from "../index";
import { getLotTile } from "./press";

const sim = createSim(sliceContent);

/** A farm map over the real sim: "Buy" applies the action it sends, as the store would. */
function SaleMap({
	start,
	level,
	onOpen,
}: {
	start: FarmState;
	level: number;
	onOpen: () => void;
}) {
	const [farm, setFarm] = useState(start);
	const handleBuy = (action: Action) => {
		const result = sim.apply(farm, action, 0);
		if (result.ok) setFarm(result.state);
	};
	return <FarmMap farm={farm} level={level} onBuy={handleBuy} onOpen={onOpen} />;
}

function newFarm(coins: number): FarmState {
	return { ...sim.newFarm("farm-sale"), coins };
}

describe("FarmMap lots for sale", () => {
	it("shows the name, price and unlocking Level, and buys the feed mill at Level 2", async () => {
		render(<SaleMap start={{ ...newFarm(500), xp: 10 }} level={2} onOpen={vi.fn()} />);

		await userEvent.click(getLotTile("Feed mill: for sale"));
		const popover = screen.getByRole("dialog", { name: "Feed mill" });
		expect(popover.textContent).toContain(`${String(sliceContent.facilities[0].price)} coins`);
		expect(popover.textContent).toContain("Unlocks at Level 2");

		await userEvent.click(screen.getByRole("button", { name: "Buy" }));

		expect(screen.getByRole("button", { name: "Feed mill" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Feed mill: for sale" })).toBeNull();
	});

	it("disables Buy at Level 1 and says which Level is needed", async () => {
		render(<SaleMap start={newFarm(500)} level={1} onOpen={vi.fn()} />);

		await userEvent.click(getLotTile("Feed mill: for sale"));

		const buy = screen.getByRole("button", { name: "Buy" });
		expect(buy.hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("Reach Level 2 to buy this.")).toBeTruthy();
	});

	it("disables Buy when the coins fall short and says how many are missing", async () => {
		const { price } = sliceContent.pens[0];
		render(<SaleMap start={{ ...newFarm(price - 1), xp: 10 }} level={2} onOpen={vi.fn()} />);

		await userEvent.click(getLotTile("Chicken pen: for sale"));

		expect(screen.getByRole("button", { name: "Buy" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("You need 1 more coin to buy this.")).toBeTruthy();
	});

	it("buys the chicken pen, and a bought lot calls onOpen with the lot", async () => {
		const onOpen = vi.fn();
		render(<SaleMap start={{ ...newFarm(500), xp: 10 }} level={2} onOpen={onOpen} />);

		await userEvent.click(getLotTile("Chicken pen: for sale"));
		await userEvent.click(screen.getByRole("button", { name: "Buy" }));
		await userEvent.click(getLotTile("Chicken pen"));

		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: "pen", index: 0 }));
	});
});

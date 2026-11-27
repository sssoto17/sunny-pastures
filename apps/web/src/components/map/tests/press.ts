import { screen } from "@testing-library/react";

/**
 * The part of a lot's button that takes a press: its tile (#699). The rest of the lot, its sprite
 * included, has `pointer-events: none`, so a test presses the tile, as a player's tap would.
 */
export function getLotTile(name: string | RegExp): HTMLElement {
	const tile = screen.getByRole("button", { name }).querySelector<HTMLElement>("[data-lot-tile]");
	if (tile === null) throw new Error(`The lot "${String(name)}" has no tile to press.`);

	return tile;
}

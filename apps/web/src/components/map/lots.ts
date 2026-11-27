import type { FarmState } from "@sunny-pastures/sim";

import type { SpriteId } from "@/client/sprites";

// The lots (GLOSSARY.md, "Lot"): the fixed places on the farm map, in isometric coordinates. A lot
// is a place, so the table is data and what stands on it comes from the farm's state.

/** A lot's grid position: `col` runs down-right and `row` down-left, in whole tiles. */
export interface LotPlace {
	readonly col: number;
	readonly row: number;
}

export type LotKind = "plot" | "facility" | "pen";

export interface Lot extends LotPlace {
	readonly kind: LotKind;
	/** The index in content order: the plot's, the facility's or the pen's own (D12). */
	readonly index: number;
	/** The facility's or pen's name; a plot's is numbered from its index. */
	readonly label: string;
	/** The sprite shown once the lot is bought. */
	readonly sprite: SpriteId;
}

/**
 * The 6 starting plots in two rows of three, with the chicken pen, the feed mill and the bakery
 * in a column beside them (the slice's content, `sliceContent`).
 */
export const lots = [
	{ kind: "plot", index: 0, label: "Plot 1", sprite: "plotEmpty", col: 0, row: 0 },
	{ kind: "plot", index: 1, label: "Plot 2", sprite: "plotEmpty", col: 1, row: 0 },
	{ kind: "plot", index: 2, label: "Plot 3", sprite: "plotEmpty", col: 2, row: 0 },
	{ kind: "plot", index: 3, label: "Plot 4", sprite: "plotEmpty", col: 0, row: 1 },
	{ kind: "plot", index: 4, label: "Plot 5", sprite: "plotEmpty", col: 1, row: 1 },
	{ kind: "plot", index: 5, label: "Plot 6", sprite: "plotEmpty", col: 2, row: 1 },
	{ kind: "pen", index: 0, label: "Chicken pen", sprite: "chickenPen", col: 4, row: 0 },
	{ kind: "facility", index: 0, label: "Feed mill", sprite: "feedMill", col: 4, row: 1 },
	{ kind: "facility", index: 1, label: "Bakery", sprite: "bakery", col: 4, row: 2 },
] as const satisfies readonly Lot[];

/** A tile's drawn size, in px: the isometric diamond is twice as wide as it is tall. */
export const tileSize = { width: 128, height: 64 } as const;

/** Where the lot's tile is drawn, in px from the content's origin. */
export function lotPosition(lot: LotPlace): { x: number; y: number } {
	return {
		x: ((lot.col - lot.row) * tileSize.width) / 2,
		y: ((lot.col + lot.row) * tileSize.height) / 2,
	};
}

/** Nearer lots have a larger sum, so they stack over the ones behind them. */
export function lotDepth(lot: LotPlace): number {
	return lot.col + lot.row;
}

/** The middle of the lots' tiles: the point the camera centres on. */
export function mapCenter(): { x: number; y: number } {
	const positions = lots.map(lotPosition);
	const xs = positions.map((p) => p.x);
	const ys = positions.map((p) => p.y);
	return {
		x: (Math.min(...xs) + Math.max(...xs) + tileSize.width) / 2,
		y: (Math.min(...ys) + Math.max(...ys) + tileSize.height) / 2,
	};
}

export interface LotLook {
	readonly name: string;
	readonly sprite: SpriteId;
	/** True while the lot shows the "For sale" sign: nothing is bought on it yet. */
	readonly isForSale: boolean;
}

/** What a lot shows and is called, from the farm: the accessible name and the sprite. */
export function describeLot(lot: Lot, farm: FarmState): LotLook {
	if (lot.kind === "plot") return describePlot(lot, farm);

	// An unbought pen or facility is `null` in the farm, one entry per content item (ADR-0003).
	const entry = (lot.kind === "pen" ? farm.pens : farm.facilities)[lot.index] ?? null;
	if (entry === null) return forSale(lot);

	return { name: lot.label, sprite: lot.sprite, isForSale: false };
}

function forSale(lot: Lot): LotLook {
	return { name: `${lot.label}: for sale`, sprite: "lotForSale", isForSale: true };
}

function describePlot(lot: Lot, farm: FarmState): LotLook {
	const plot = farm.plots[lot.index];
	if (plot === undefined) return forSale(lot);
	if (plot.status === "empty") {
		return { name: `${lot.label}: empty`, sprite: "plotEmpty", isForSale: false };
	}

	const sprite = plot.status === "ready" ? "plotReady" : "plotGrowing";
	return { name: `${lot.label}: ${plot.crop}, ${plot.status}`, sprite, isForSale: false };
}

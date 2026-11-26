"use client";

import type { ReactElement } from "react";

import { sliceContent, type Action, type FarmState, type LevelRow } from "@sunny-pastures/sim";

import { Button, Popover } from "@/components/ui";

import type { Lot } from "./lots";

/**
 * A lot for sale (ADR-0010, "predefined lots with a For sale sign"; MUST-05.6): the popover that
 * opens from its sign. It shows the name, the price and the Level that unlocks it, and a "Buy"
 * that sends `buyPen` or `buyFacility` with the lot's content index. While the farm's Level or
 * coins fall short, "Buy" is disabled and the reason shows beside it; the sim still decides.
 */
export interface LotSaleProps {
	readonly lot: Lot;
	readonly farm: FarmState;
	/** The farm's Level, from 1. */
	readonly level: number;
	/** The lot's sign: the `Button` the popover opens from. */
	readonly trigger: ReactElement;
	readonly onBuy: (action: Action) => void;
}

export function LotSale({ lot, farm, level, trigger, onBuy }: LotSaleProps) {
	const offer = findOffer(lot);
	if (offer === null) return trigger;

	const reason = findReason(offer, farm, level);
	const handleBuy = () => {
		onBuy(offer.action);
	};
	return (
		<Popover trigger={trigger} label={lot.label}>
			<h3>{lot.label}</h3>
			<p>{offer.price.toLocaleString("en")} coins</p>
			<p>Unlocks at Level {String(offer.level)}</p>
			{reason !== null && <p>{reason}</p>}
			<Button variant="primary" isDisabled={reason !== null} onPress={handleBuy}>
				Buy
			</Button>
		</Popover>
	);
}

interface Offer {
	readonly price: number;
	/** The Level that unlocks it, from 1. */
	readonly level: number;
	readonly action: Action;
}

/** The lot's price, unlocking Level and buy action from the content; null for a plot. */
function findOffer(lot: Lot): Offer | null {
	if (lot.kind === "plot") return null;

	if (lot.kind === "pen") {
		const pen = sliceContent.pens[lot.index];
		if (pen === undefined) return null;

		const level = unlockLevel(pen.id, "pens");
		if (level === null) return null;

		return { price: pen.price, level, action: { type: "buyPen", pen: lot.index } };
	}

	const facility = sliceContent.facilities[lot.index];
	if (facility === undefined) return null;

	const level = unlockLevel(facility.id, "facilities");
	if (level === null) return null;

	return { price: facility.price, level, action: { type: "buyFacility", facility: lot.index } };
}

/** The Level whose row of the Level table first lists `id` under `unlocks` (MUST-05.3, 05.6). */
function unlockLevel(id: string, unlocks: "pens" | "facilities"): number | null {
	const { levels }: { levels: readonly LevelRow[] } = sliceContent;
	const index = levels.findIndex((row) => row[unlocks].includes(id));
	// A lot no Level unlocks has no offer: it can't be bought, so it has no popover.
	return index === -1 ? null : index + 1;
}

/** Why "Buy" is off, as a sentence a player reads; null when the farm can buy it. */
function findReason(offer: Offer, farm: FarmState, level: number): string | null {
	if (level < offer.level) return `Reach Level ${String(offer.level)} to buy this.`;
	if (farm.coins < offer.price) {
		const missing = offer.price - farm.coins;
		return `You need ${String(missing)} more ${missing === 1 ? "coin" : "coins"} to buy this.`;
	}

	return null;
}

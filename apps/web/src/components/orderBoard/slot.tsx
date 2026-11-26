"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { Order, OrderSlot } from "@sunny-pastures/sim";

import { selectStorage, type FarmStore } from "@/client/store";
import { Button, Dialog } from "@/components/ui";

import { findShortfall, formatTimeLeft, listNeeds, nameGood } from "./goods";

/**
 * One slot of the board: its open order, or the time left until it refills. After a delivery or a
 * discard the slot's buttons are gone, so focus moves to the slot's heading rather than being
 * lost to the page.
 */
export interface OrderSlotViewProps {
	readonly store: StoreApi<FarmStore>;
	readonly slot: OrderSlot;
	readonly index: number;
}

export function OrderSlotView({ store, slot, index }: OrderSlotViewProps) {
	const headingId = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const [isFocusDue, setIsFocusDue] = useState(false);
	const number = index + 1;

	useEffect(() => {
		if (!isFocusDue || slot.status !== "empty") return;

		heading.current?.focus();
		setIsFocusDue(false);
	}, [isFocusDue, slot.status]);

	const handleAct = (type: "deliver" | "discard") => {
		setIsFocusDue(true);
		store.getState().act({ type, slot: index });
	};

	return (
		<li aria-labelledby={headingId}>
			<h3 id={headingId} ref={heading} tabIndex={-1}>
				Order {number}
			</h3>
			{slot.status === "open" ? (
				<OpenOrder store={store} order={slot.order} number={number} onAct={handleAct} />
			) : (
				<Refill store={store} refillAt={slot.refillAt} />
			)}
		</li>
	);
}

interface OpenOrderProps {
	readonly store: StoreApi<FarmStore>;
	readonly order: Order;
	readonly number: number;
	readonly onAct: (type: "deliver" | "discard") => void;
}

function OpenOrder({ store, order, number, onAct }: OpenOrderProps) {
	const storage = useStore(store, selectStorage);
	const [isConfirming, setIsConfirming] = useState(false);
	if (storage === null) return null;

	const needs = listNeeds(order, storage);
	const shortfall = findShortfall(needs);

	const handleDeliver = () => {
		onAct("deliver");
	};
	const handleDiscard = () => {
		setIsConfirming(true);
	};
	const handleConfirm = () => {
		setIsConfirming(false);
		onAct("discard");
	};
	const handleKeep = () => {
		setIsConfirming(false);
	};

	return (
		<>
			<ul aria-label="Goods">
				{needs.map((need) => (
					<li key={need.good}>
						{capitalise(nameGood(need.good, need.amount))}: have {need.have}, need {need.amount}
					</li>
				))}
			</ul>
			<p>
				Pays {order.coins} coins and {order.xp} XP
			</p>
			{/* A disabled button leaves the Tab order, so the reason is text beside it (BASE-03). */}
			{shortfall !== null && <p>{shortfall}</p>}
			<Button variant="primary" onPress={handleDeliver} isDisabled={shortfall !== null}>
				Deliver
			</Button>
			<Button variant="quiet" onPress={handleDiscard}>
				Discard
			</Button>
			<Dialog
				title={`Discard order ${String(number)}?`}
				isOpen={isConfirming}
				onOpenChange={setIsConfirming}
			>
				<p>A new order takes its place after a wait.</p>
				<Button variant="danger" onPress={handleConfirm}>
					Discard order
				</Button>
				<Button onPress={handleKeep}>Keep it</Button>
			</Dialog>
		</>
	);
}

interface RefillProps {
	readonly store: StoreApi<FarmStore>;
	readonly refillAt: number;
}

/** Only this subscribes to the clock, so the rest of the board doesn't redraw every second. */
function Refill({ store, refillAt }: RefillProps) {
	const now = useStore(store, (s) => s.now);
	return <p>New order in {formatTimeLeft(refillAt, now)}</p>;
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

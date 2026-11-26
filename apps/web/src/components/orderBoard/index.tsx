"use client";

import { useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { selectOrders, selectStorage, type FarmStore } from "@/client/store";
import { Badge, Button, Dialog } from "@/components/ui";

import { countDeliverable } from "./goods";
import { OrderSlotView } from "./slot";

/**
 * The order board (MUST-04; ADR-0010): an "Orders" button, counting the orders the farm can
 * deliver, that opens the board as a dialog with one entry per slot. It reads the predicted farm
 * through the store's selectors and sends `deliver` and `discard` through `act`, so the board
 * changes at once and rolls back if the server refuses (MUST-12). The HUD (#600) hosts the button
 * once it lands; until then the game mounts it.
 */
export interface OrderBoardProps {
	readonly store: StoreApi<FarmStore>;
}

export function OrderBoard({ store }: OrderBoardProps) {
	const [isOpen, setIsOpen] = useState(false);
	const board = useStore(store, selectOrders);
	const storage = useStore(store, selectStorage);
	const deliverable = countDeliverable(board, storage);

	const handleOpen = () => {
		setIsOpen(true);
	};
	const handleClose = () => {
		setIsOpen(false);
	};

	return (
		<>
			<Button onPress={handleOpen}>
				Orders {deliverable > 0 && <Badge tone="attention">{deliverable} to deliver</Badge>}
			</Button>
			<Dialog title="Orders" isOpen={isOpen} onOpenChange={setIsOpen}>
				<ul aria-label="Order slots">
					{board.map((slot, index) => (
						// A slot's place on the board is its identity: slots never move (MUST-04.1).
						<OrderSlotView key={index} store={store} slot={slot} index={index} />
					))}
				</ul>
				<Button variant="quiet" onPress={handleClose}>
					Close
				</Button>
			</Dialog>
		</>
	);
}

"use client";

import { useState, type ReactElement } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { selectFacility, type FarmStore } from "@/client/store";
import { Button, Popover } from "@/components/ui";

import { FacilityDialog } from "./dialog";
import { FacilityQueue } from "./queue";

/**
 * A bought facility's popover and dialog (ADR-0010, "a button for a dialog"; MUST-03): the popover
 * shows the queue and an "Open" button, which opens a `Dialog` with the recipes, "Start" and
 * "Collect". Pattern: a container component over the store's selectors and `act`; the dialog's
 * state lives here, outside the popover, so closing the popover doesn't close the dialog. Finished
 * goods show beside the building as the map's attention cue (#608). Rejected: the dialog inside
 * the popover, which would unmount it with the popover.
 */
export interface FacilityPopoverProps {
	readonly store: StoreApi<FarmStore>;
	/** The facility's index, in content order. */
	readonly index: number;
	/** The lot's label ("Feed mill"), which names the popover and the dialog. */
	readonly label: string;
	/** The lot's `Button`, which opens the popover. */
	readonly trigger: ReactElement;
}

export function FacilityPopover({ store, index, label, trigger }: FacilityPopoverProps) {
	const facility = useStore(store, selectFacility(index));
	const now = useStore(store, (s) => s.now);
	const [isOpen, setIsOpen] = useState(false);
	if (facility === null) return trigger;

	return (
		<>
			<Popover trigger={trigger} label={label}>
				{(close) => (
					<>
						<h3>{label}</h3>
						<FacilityQueue facility={facility} index={index} now={now} />
						<Button
							variant="primary"
							onPress={() => {
								close();
								setIsOpen(true);
							}}
						>
							Open
						</Button>
					</>
				)}
			</Popover>
			<FacilityDialog
				store={store}
				index={index}
				label={label}
				isOpen={isOpen}
				onOpenChange={setIsOpen}
			/>
		</>
	);
}

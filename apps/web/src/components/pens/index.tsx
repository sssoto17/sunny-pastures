"use client";

import type { ReactElement } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { createSim, sliceContent, type Action, type OwnedPen } from "@sunny-pastures/sim";

import { selectPen, type FarmStore } from "@/client/store";
import { Button, Meter, Popover } from "@/components/ui";

import { formatTimeLeft } from "../orderBoard";

/**
 * A bought pen's popover (ADR-0010, "tap a lot for a status popover"; MUST-02): its chickens, the
 * trough as a `Meter`, the next egg's time left from the store's `now`, the eggs waiting, and the
 * "Feed" and "Collect eggs" buttons. Waiting eggs show beside the pen as the map's attention
 * cue (#608).
 * Pattern: a container component over the store's selectors and `act`. Whether a button is off is
 * asked of the shared sim by a dry run of the same action, so the reason shown is the sim's own
 * sentence and the client never restates a rule (MUST-12), as in the plot popover. Rejected:
 * checking the barn and the trough here, which would drift from the sim.
 */
export interface PenPopoverProps {
	readonly store: StoreApi<FarmStore>;
	/** The pen's index, in content order. */
	readonly index: number;
	/** The lot's label ("Chicken pen"), which names the popover. */
	readonly label: string;
	/** The lot's `Button`, which opens the popover. */
	readonly trigger: ReactElement;
}

// The client's rules are `sliceContent` (the store's `rulesVersion`), so the dry run uses them too.
const sim = createSim(sliceContent);

export function PenPopover({ store, index, label, trigger }: PenPopoverProps) {
	const pen = useStore(store, selectPen(index));
	if (pen === null) return trigger;

	return (
		<Popover trigger={trigger} label={label}>
			<PenStatus store={store} index={index} label={label} pen={pen} />
		</Popover>
	);
}

interface PenStatusProps {
	readonly store: StoreApi<FarmStore>;
	readonly index: number;
	readonly label: string;
	readonly pen: OwnedPen;
}

function PenStatus({ store, index, label, pen }: PenStatusProps) {
	const farm = useStore(store, (s) => s.predicted);
	const now = useStore(store, (s) => s.now);
	const rule = sliceContent.pens[index];
	if (farm === null || rule === undefined) return null;

	const handleAct = (action: Action) => {
		store.getState().act(action);
	};
	const feedAction: Action = { type: "feed", pen: index };
	const collectAction: Action = { type: "collectProducts", pen: index };
	const feedTried = sim.apply(farm, feedAction, farm.time);
	const collectTried = sim.apply(farm, collectAction, farm.time);
	const next = findNextReadyAt(pen);
	const waiting = pen.animals.filter((animal) => animal.status === "idle").length;
	return (
		<>
			<h3>{label}</h3>
			<p>
				{String(pen.animals.length)} {pen.animals.length === 1 ? "chicken" : "chickens"},{" "}
				{String(waiting)} waiting for feed
			</p>
			<Meter
				label="Trough"
				value={pen.trough}
				max={rule.troughCapacity}
				valueLabel={`${String(pen.trough)} of ${String(rule.troughCapacity)} portions`}
			/>
			<p>{next === null ? "No egg is coming." : `Next egg in ${formatTimeLeft(next, now)}.`}</p>
			<p>Eggs waiting: {String(pen.products)}</p>
			<Button
				variant="primary"
				isDisabled={!feedTried.ok}
				onPress={() => {
					handleAct(feedAction);
				}}
			>
				Feed
			</Button>
			{!feedTried.ok && <p>{feedTried.reason}</p>}
			<Button
				variant="primary"
				isDisabled={!collectTried.ok}
				onPress={() => {
					handleAct(collectAction);
				}}
			>
				Collect eggs
			</Button>
			{!collectTried.ok && <p>{collectTried.reason}</p>}
		</>
	);
}

/** The soonest time a chicken lays, in ms; null when none is producing. */
function findNextReadyAt(pen: OwnedPen): number | null {
	const times = pen.animals.flatMap((animal) =>
		animal.status === "producing" ? [animal.readyAt] : [],
	);
	return times.length === 0 ? null : Math.min(...times);
}

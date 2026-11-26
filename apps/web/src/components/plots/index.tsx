"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { createSim, sliceContent, type Action, type FarmState } from "@sunny-pastures/sim";

import { selectPlot, type FarmStore } from "@/client/store";
import { Button, Popover } from "@/components/ui";

/**
 * A plot's status popover (ADR-0010, "tap a lot for a status popover"; MUST-01): an empty plot
 * lists the crops with their seed price and a Plant button each, a growing plot its time left
 * from the store's `now`, and a ready plot a Harvest button. Pattern: a container component over
 * the store's selectors and `act`. Whether a crop can be planted is asked of the shared sim by a
 * dry run of the same `plant` action, so the reason shown is the sim's own sentence and the client
 * never restates a rule (MUST-12). Rejected: re-deriving the lock and price checks here, which
 * would drift from the sim.
 */
export interface PlotPopoverProps {
	readonly store: StoreApi<FarmStore>;
	/** The plot's index, in content order. */
	readonly index: number;
	/** The lot's label ("Plot 1"), which names the popover. */
	readonly label: string;
	/** The lot's `Button`, which opens the popover. */
	readonly trigger: ReactElement;
}

export function PlotPopover({ store, index, label, trigger }: PlotPopoverProps) {
	const isOwned = useStore(store, (s) => selectPlot(index)(s) !== null);
	if (!isOwned) return trigger;

	return (
		<Popover trigger={trigger} label={label}>
			<PlotStatus store={store} index={index} label={label} />
		</Popover>
	);
}

/** How long until `ms` from now, as a player reads it: "1 h 5 min", "1 min 30 s", "45 s". */
export function formatTimeLeft(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	const parts = [
		{ value: Math.floor(seconds / 3600), unit: "h" },
		{ value: Math.floor((seconds % 3600) / 60), unit: "min" },
		{ value: seconds % 60, unit: "s" },
	];
	// Two units are precise enough for a calm countdown (PRODUCT.md, principle 4); a zero second
	// unit is left out ("2 min", not "2 min 0 s").
	const first = parts.findIndex((part) => part.value > 0);
	if (first === -1) return "0 s";

	return parts
		.slice(first, first + 2)
		.filter((part, i) => i === 0 || part.value > 0)
		.map((part) => `${String(part.value)} ${part.unit}`)
		.join(" ");
}

// The client's rules are `sliceContent` (the store's `rulesVersion`), so the dry run uses them too.
const sim = createSim(sliceContent);
const crops = Object.entries(sliceContent.crops).map(([id, crop]) => ({
	id,
	price: crop.seedPrice,
}));

type PlotStatusProps = Omit<PlotPopoverProps, "trigger">;

/** The popover's content: mounted only while it is open, so its state starts fresh each time. */
function PlotStatus({ store, index, label }: PlotStatusProps) {
	const plot = useStore(store, selectPlot(index));
	const farm = useStore(store, (s) => s.predicted);
	const now = useStore(store, (s) => s.now);
	const [hasActed, setHasActed] = useState(false);
	const statusRef = useRef<HTMLParagraphElement>(null);
	const status = plot?.status ?? null;

	// The pressed button leaves with the state it acted on, so focus moves to the new status line
	// and a screen reader reads it, instead of falling back to the page.
	useEffect(() => {
		if (hasActed) statusRef.current?.focus();
	}, [hasActed, status]);

	if (plot === null || farm === null) return null;

	const handleAct = (action: Action) => {
		setHasActed(true);
		store.getState().act(action);
	};
	const renderStatus = (text: string) => (
		<p ref={statusRef} tabIndex={-1}>
			{text}
		</p>
	);

	if (plot.status === "empty") {
		return (
			<>
				{renderStatus(`${label} is empty.`)}
				<ul>
					{crops.map(({ id, price }) => (
						<CropOption
							key={id}
							id={id}
							price={price}
							farm={farm}
							index={index}
							onAct={handleAct}
						/>
					))}
				</ul>
			</>
		);
	}

	const crop = formatCrop(plot.crop);
	if (plot.status === "growing") {
		return <>{renderStatus(`${crop} is growing: ${formatTimeLeft(plot.readyAt - now)} left.`)}</>;
	}

	return (
		<>
			{renderStatus(`${crop} is ready.`)}
			<Button
				variant="primary"
				onPress={() => {
					handleAct({ type: "harvest", plot: index });
				}}
			>
				Harvest {plot.crop}
			</Button>
		</>
	);
}

interface CropOptionProps {
	readonly id: string;
	/** The seed price, in coins. */
	readonly price: number;
	readonly farm: FarmState;
	readonly index: number;
	readonly onAct: (action: Action) => void;
}

/** One crop to plant: its seed price and Plant button, disabled with the sim's reason. */
function CropOption({ id, price, farm, index, onAct }: CropOptionProps) {
	const action: Action = { type: "plant", plot: index, crop: id };
	const tried = sim.apply(farm, action, farm.time);
	return (
		<li>
			<span>
				{formatCrop(id)}: {String(price)} coins
			</span>
			<Button
				variant="primary"
				isDisabled={!tried.ok}
				onPress={() => {
					onAct(action);
				}}
			>
				Plant {id}
			</Button>
			{!tried.ok && <p>{tried.reason}</p>}
		</li>
	);
}

/** A crop id as a player reads it at the start of a sentence: `wheat` → "Wheat". */
function formatCrop(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1);
}

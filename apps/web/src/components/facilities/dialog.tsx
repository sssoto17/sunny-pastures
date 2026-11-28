"use client";

import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { createSim, sliceContent, type Action, type Recipe } from "@sunny-pastures/sim";

import { selectFacility, selectStorage, type FarmStorage, type FarmStore } from "@/client/store";
import { Button, Dialog } from "@/components/ui";

import { formatTimeLeft, listNeeds, nameGood } from "../orderBoard";
import { FacilityQueue } from "./queue";

// The client's rules are `sliceContent` (the store's `rulesVersion`), so the dry runs use them too.
const sim = createSim(sliceContent);

export interface FacilityDialogProps {
	readonly store: StoreApi<FarmStore>;
	/** The facility's index, in content order. */
	readonly index: number;
	/** The dialog's title: the facility's name. */
	readonly label: string;
	readonly isOpen: boolean;
	readonly onOpenChange: (isOpen: boolean) => void;
}

/**
 * The facility's dialog: its recipes with what they need, take and make, a "Start" for each, and
 * the queue with "Collect". Whether a recipe can start, or the oldest job be collected, is asked
 * of the shared sim by a dry run of the same action, so a disabled button shows the sim's own
 * sentence and the client never restates a rule (MUST-12). Rejected: re-deriving the tier, queue
 * and storage checks here, which would drift from the sim.
 */
export function FacilityDialog({ store, index, label, isOpen, onOpenChange }: FacilityDialogProps) {
	return (
		<Dialog title={label} isOpen={isOpen} onOpenChange={onOpenChange}>
			<FacilityBody store={store} index={index} />
		</Dialog>
	);
}

/** Mounted only while the dialog is open. */
function FacilityBody({ store, index }: Pick<FacilityDialogProps, "store" | "index">) {
	const facility = useStore(store, selectFacility(index));
	const farm = useStore(store, (s) => s.predicted);
	const storage = useStore(store, selectStorage);
	const now = useStore(store, (s) => s.now);
	const content = sliceContent.facilities[index];
	const recipes: Readonly<Record<string, Recipe>> = content?.recipes ?? {};
	if (facility === null || farm === null || storage === null || content === undefined) return null;

	const handleAct = (action: Action) => {
		store.getState().act(action);
	};
	const collected = sim.apply(farm, { type: "collect", facility: index }, farm.time);
	return (
		<>
			<h3>Recipes</h3>
			<ul aria-label="Recipes">
				{Object.entries(recipes).map(([id, recipe]) => {
					const action: Action = { type: "startJob", facility: index, recipe: id };
					const tried = sim.apply(farm, action, farm.time);
					const perMille = content.tiers[facility.tier - 2]?.timePerMille ?? 1000;
					return (
						<RecipeRow
							key={id}
							recipe={recipe}
							storage={storage}
							seconds={Math.floor((recipe.seconds * perMille) / 1000)}
							reason={tried.ok ? null : tried.reason}
							onStart={() => {
								handleAct(action);
							}}
						/>
					);
				})}
			</ul>
			<h3>Queue</h3>
			<FacilityQueue
				facility={facility}
				index={index}
				now={now}
				onCollect={handleAct}
				collectReason={collected.ok ? null : collected.reason}
			/>
		</>
	);
}

interface RecipeRowProps {
	readonly recipe: Recipe;
	readonly storage: FarmStorage;
	/** The job's time at the facility's tier now, in whole seconds (D16). */
	readonly seconds: number;
	/** The sim's reason "Start" is off, or null when it works. */
	readonly reason: string | null;
	readonly onStart: () => void;
}

/** One recipe: inputs (have / need), duration, output, and "Start" with the reason it is off. */
function RecipeRow({ recipe, storage, seconds, reason, onStart }: RecipeRowProps) {
	const output = nameGood(recipe.output.good, recipe.output.amount);
	const needs = listNeeds({ goods: recipe.inputs }, storage);
	return (
		<li>
			<h4>{capitalise(output)}</h4>
			<ul aria-label={`${output} needs`}>
				{needs.map((need) => (
					<li key={need.good}>
						{capitalise(nameGood(need.good, need.amount))}: have {String(need.have)}, need{" "}
						{String(need.amount)}
					</li>
				))}
			</ul>
			<p>Takes {formatTimeLeft(seconds * 1000, 0)}</p>
			<p>
				Makes {String(recipe.output.amount)} {output}
			</p>
			<Button variant="primary" isDisabled={reason !== null} onPress={onStart}>
				Start {output}
			</Button>
			{reason !== null && <p>{reason}</p>}
		</li>
	);
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

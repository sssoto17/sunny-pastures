"use client";

import { Coins } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";

import { selectConfirmedLevel, type FarmStore } from "@/client/store";
import { Button, Dialog } from "@/components/ui";

import { listRewards, type LevelReward } from "./rewards";
import { readShownLevel, writeShownLevel } from "./shown";

/**
 * The level-up dialog (#607; ADR-0010: "levelling up is the one dialog that opens by itself"): when
 * the confirmed Level rises above the one last shown, after an action or on load, it names each
 * Level reached with what it unlocks and its level-up coins (MUST-05.3, 05.4). It reads the
 * confirmed farm, not the prediction, so a refused action never opens it.
 */
export interface LevelUpProps {
	readonly store: StoreApi<FarmStore>;
}

export function LevelUp({ store }: LevelUpProps) {
	const { rewards, dismiss } = useLevelUps(store);
	const top = rewards.at(-1);
	if (top === undefined) return null;

	const handleOpenChange = (isOpen: boolean) => {
		if (!isOpen) dismiss();
	};

	return (
		<Dialog title={`You reached Level ${String(top.level)}`} isOpen onOpenChange={handleOpenChange}>
			{rewards.length === 1 ? (
				<RewardDetails reward={top} />
			) : (
				rewards.map((reward) => (
					<section key={reward.level} aria-labelledby={`level-up-${String(reward.level)}`}>
						<h3 id={`level-up-${String(reward.level)}`}>Level {reward.level}</h3>
						<RewardDetails reward={reward} />
					</section>
				))
			)}
			<Button variant="primary" onPress={dismiss}>
				Continue
			</Button>
		</Dialog>
	);
}

interface RewardDetailsProps {
	readonly reward: LevelReward;
}

function RewardDetails({ reward }: RewardDetailsProps) {
	return (
		<>
			<p>
				<Coins aria-hidden /> {reward.coins.toLocaleString("en")} level-up coins
			</p>
			{reward.unlocks.length > 0 && (
				<ul>
					{reward.unlocks.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			)}
		</>
	);
}

/**
 * The Levels to show, from the one after the Level last shown to the confirmed Level, and how to
 * mark them shown. It listens to the store rather than to a render, as the HUD's refusals do, and
 * acts only when the confirmed Level changes, so the clock tick costs nothing. A first visit, or a
 * stored Level above the farm's (another farm in this browser), starts from the farm's Level.
 */
function useLevelUps(store: StoreApi<FarmStore>) {
	const [rewards, setRewards] = useState<readonly LevelReward[]>([]);
	// The Level last shown, in memory too, so a browser that blocks storage still shows each once.
	const shown = useRef<number | null>(null);

	useEffect(() => {
		shown.current = readShownLevel();
		let seen: number | null = null;
		const check = (state: FarmStore) => {
			const level = selectConfirmedLevel(state);
			if (level === null || level === seen) return;

			seen = level;
			if (shown.current === null || shown.current > level) {
				shown.current = level;
				writeShownLevel(level);
				return;
			}

			setRewards(listRewards(shown.current + 1, level));
		};
		check(store.getState());
		return store.subscribe(check);
	}, [store]);

	const dismiss = () => {
		const top = rewards.at(-1);
		if (top !== undefined) {
			shown.current = top.level;
			writeShownLevel(top.level);
		}
		setRewards([]);
	};

	return { rewards, dismiss };
}

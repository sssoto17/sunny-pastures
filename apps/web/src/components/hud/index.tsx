"use client";

import { Coins } from "lucide-react";
import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import {
	selectCoins,
	selectLevelProgress,
	selectStorage,
	type FarmStore,
	type LevelProgress,
} from "@/client/store";
import { Meter, Panel } from "@/components/ui";

import { useRefusalToasts } from "./refusals";
import { Storage } from "./storage";

/**
 * The HUD (ADR-0010; #600): the farm's coins, its Level with the XP toward the next one, and how
 * full the silo and the barn are, each read from the store through its selector so the clock tick
 * redraws only what changed. It also shows each refusal as a toast. It sits over the map, so its
 * place is inline `style` like the map's controls; its looks are the design-system strand's.
 */
export interface HudProps {
	readonly store: StoreApi<FarmStore>;
}

const hudStyle: CSSProperties = { position: "fixed", top: 16, left: 16, zIndex: 1000 };

export function Hud({ store }: HudProps) {
	const coins = useStore(store, selectCoins);
	const progress = useStore(store, selectLevelProgress);
	const storage = useStore(store, selectStorage);
	useRefusalToasts(store);

	if (coins === null || progress === null || storage === null) return null;

	return (
		<div style={hudStyle}>
			<Panel label="Farm status">
				<p>
					<Coins aria-hidden /> {coins.toLocaleString("en")} coins
				</p>
				<LevelMeter progress={progress} />
				<Storage storage={storage} />
			</Panel>
		</div>
	);
}

interface LevelMeterProps {
	readonly progress: LevelProgress;
}

/** The XP gained since this Level's threshold, toward the next one; full at the top Level. */
function LevelMeter({ progress }: LevelMeterProps) {
	const { level, xp, levelXp, nextLevelXp } = progress;
	const label = `Level ${String(level)}`;
	if (nextLevelXp === null) {
		return <Meter label={label} value={1} max={1} valueLabel={`${String(xp)} XP, the top Level`} />;
	}

	const gained = xp - levelXp;
	const needed = nextLevelXp - levelXp;
	return (
		<Meter
			label={label}
			value={gained}
			max={needed}
			valueLabel={`${String(gained)} of ${String(needed)} XP to Level ${String(level + 1)}`}
		/>
	);
}

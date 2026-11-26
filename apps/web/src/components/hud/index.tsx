"use client";

import { Coins } from "lucide-react";
import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { sliceContent } from "@sunny-pastures/sim";

import { selectCoins, selectLevel, selectStorage, type FarmStore } from "@/client/store";
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
	const level = useStore(store, selectLevel);
	const xp = useStore(store, (s) => s.predicted?.xp ?? null);
	const storage = useStore(store, selectStorage);
	useRefusalToasts(store);

	if (coins === null || level === null || xp === null || storage === null) return null;

	return (
		<div style={hudStyle}>
			<Panel label="Farm status">
				<p>
					<Coins aria-hidden /> {coins.toLocaleString("en")} coins
				</p>
				<LevelMeter level={level} xp={xp} />
				<Storage storage={storage} />
			</Panel>
		</div>
	);
}

interface LevelMeterProps {
	readonly level: number;
	readonly xp: number;
}

/** The XP gained since this Level's threshold, toward the next one; full at the top Level. */
function LevelMeter({ level, xp }: LevelMeterProps) {
	const from = sliceContent.levels[level - 1]?.xp ?? 0;
	const next = sliceContent.levels[level];
	const label = `Level ${String(level)}`;
	if (next === undefined) {
		return <Meter label={label} value={1} max={1} valueLabel={`${String(xp)} XP, the top Level`} />;
	}

	const gained = xp - from;
	const needed = next.xp - from;
	return (
		<Meter
			label={label}
			value={gained}
			max={needed}
			valueLabel={`${String(gained)} of ${String(needed)} XP to Level ${String(level + 1)}`}
		/>
	);
}

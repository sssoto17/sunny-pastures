"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { Action } from "@sunny-pastures/sim";

import { createApi } from "@/client/api";
import { getBrowserSession } from "@/client/session";
import { createFarmStore, selectLevel, type FarmStore } from "@/client/store";
import { Button, ToastRegion } from "@/components/ui";

import { FacilityPopover } from "../facilities";
import { Hud } from "../hud";
import { LevelUp } from "../levelUp";
import { FarmMap } from "../map";
import { OrderBoard } from "../orderBoard";
import { PlotPopover } from "../plots";

/**
 * The game's client root (ADR-0010): it owns loading the farm through `src/client/` and shows the
 * loading and error states; once the farm is ready, the map fills the screen with the HUD over it
 * (#600), the order board's button (#606) and the toast region the HUD's refusals show in. A test
 * passes its own `store`; the app builds the real one.
 */
export interface GameProps {
	readonly store?: StoreApi<FarmStore>;
}

/** Top right, over the map like the HUD at the top left (#600), until a HUD row hosts it. */
const ordersStyle: CSSProperties = { position: "fixed", top: 16, right: 16, zIndex: 1000 };

export default function Game({ store }: GameProps) {
	const [farmStore] = useState(() => store ?? createBrowserStore());
	const status = useStore(farmStore, (s) => s.status);
	const error = useStore(farmStore, (s) => s.error);
	const predicted = useStore(farmStore, (s) => s.predicted);
	const level = useStore(farmStore, selectLevel);

	useEffect(() => {
		void farmStore.getState().load();
		return () => {
			farmStore.getState().stop();
		};
	}, [farmStore]);

	const handleBuy = (action: Action) => {
		farmStore.getState().act(action);
	};

	const handleRetry = () => {
		farmStore.setState({ status: "loading", error: null });
		void farmStore.getState().load();
	};

	if (status === "error") {
		return (
			<div>
				<p role="alert">{error}</p>
				<Button onPress={handleRetry}>Try again</Button>
			</div>
		);
	}

	if (status === "loading" || predicted === null || level === null) {
		return <p role="status">Loading your farm…</p>;
	}

	return (
		<>
			<FarmMap
				farm={predicted}
				level={level}
				onBuy={handleBuy}
				renderLot={(lot, button) => {
					if (lot.kind === "plot") {
						return (
							<PlotPopover store={farmStore} index={lot.index} label={lot.label} trigger={button} />
						);
					}

					return lot.kind === "facility" ? (
						<FacilityPopover
							store={farmStore}
							index={lot.index}
							label={lot.label}
							trigger={button}
						/>
					) : (
						button
					);
				}}
			/>
			<Hud store={farmStore} />
			<ToastRegion />
			<LevelUp store={farmStore} />
			<div style={ordersStyle}>
				<OrderBoard store={farmStore} />
			</div>
		</>
	);
}

/** The real store, over the game API and the browser's session; both are read only once it loads. */
function createBrowserStore(): StoreApi<FarmStore> {
	return createFarmStore({
		api: createApi({
			fetch: (path, init) => fetch(path, init),
			session: {
				getAccessToken: () => getBrowserSession().getAccessToken(),
				refreshAccessToken: () => getBrowserSession().refreshAccessToken(),
			},
		}),
	});
}

"use client";

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { createApi } from "@/client/api";
import { getBrowserSession } from "@/client/session";
import { createFarmStore, type FarmStore } from "@/client/store";
import { Button } from "@/components/ui";

import { FarmMap } from "../map";
import { OrderBoard } from "../orderBoard";

/**
 * The game's client root (ADR-0010): it owns loading the farm through `src/client/` and shows the
 * loading and error states; once the farm is ready, the map fills the screen with the order board's
 * button over it. The HUD mounts here later. A test passes its own `store`; the app builds the
 * real one.
 */
export interface GameProps {
	readonly store?: StoreApi<FarmStore>;
}

export default function Game({ store }: GameProps) {
	const [farmStore] = useState(() => store ?? createBrowserStore());
	const status = useStore(farmStore, (s) => s.status);
	const error = useStore(farmStore, (s) => s.error);
	const predicted = useStore(farmStore, (s) => s.predicted);

	useEffect(() => {
		void farmStore.getState().load();
		return () => {
			farmStore.getState().stop();
		};
	}, [farmStore]);

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

	if (status === "loading" || predicted === null) return <p role="status">Loading your farm…</p>;

	return (
		<>
			<FarmMap farm={predicted} />
			{/* Above the fixed map until the HUD (#600) hosts the Orders button. */}
			<div style={{ position: "fixed", top: 16, right: 16 }}>
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

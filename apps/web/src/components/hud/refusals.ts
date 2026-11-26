import { useEffect } from "react";
import type { StoreApi } from "zustand/vanilla";

import type { FarmStore } from "@/client/store";
import { showToast } from "@/components/ui";

/**
 * Shows each `lastRefusal` as a toast, then clears it, so the same refusal given twice shows twice
 * (#600). It listens to the store rather than to a render, so two refusals between renders both
 * show; one already set when the HUD mounts shows at once. Clearing makes this hook the one reader
 * of `lastRefusal`: mount it once.
 */
export function useRefusalToasts(store: StoreApi<FarmStore>): void {
	useEffect(() => {
		const show = ({ lastRefusal }: FarmStore) => {
			if (lastRefusal === null) return;

			showToast(lastRefusal);
			store.setState({ lastRefusal: null });
		};
		show(store.getState());
		return store.subscribe(show);
	}, [store]);
}

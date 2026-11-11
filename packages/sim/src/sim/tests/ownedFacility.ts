import type { Job, OwnedFacility } from "../../index.js";

/** A bought facility at tier 1 holding `jobs`, with no add-ons unless `more` says otherwise. */
export function ownedFacility(
	jobs: readonly Job[] = [],
	more: Partial<OwnedFacility> = {},
): OwnedFacility {
	return {
		tier: 1,
		jobs,
		lastRecipe: null,
		addOns: { loop: false, collector: false },
		...more,
	};
}

// A registry with a version upgrade in it, so the rules-version check runs its assertions on a
// boundary before the game has one (#154). Version 1 is the slice, released; version 2 is a tuning
// that grows wheat 30 s longer and adds a second feed mill (a third facility), so its `upgrade`
// fills the new entry.
import { sliceContent, stateHash } from "../../index.js";
import type { Content } from "../../index.js";
import type { Registry } from "../index.js";

const [feedMill] = sliceContent.facilities;

/** Version 2's content: slower wheat, and a second feed mill at Level 5. */
export const tunedContent: Content = {
	...sliceContent,
	crops: {
		...sliceContent.crops,
		wheat: { ...sliceContent.crops.wheat, growSeconds: sliceContent.crops.wheat.growSeconds + 30 },
	},
	levels: sliceContent.levels.map((row, i) =>
		i === 4 ? { ...row, facilities: [...row.facilities, "secondMill"] } : row,
	),
	facilities: [...sliceContent.facilities, { ...feedMill, id: "secondMill" }],
};

export const twoVersions: Registry = {
	first: { content: sliceContent, contentHash: stateHash(sliceContent) },
	later: [
		{
			content: tunedContent,
			contentHash: null,
			// The default version upgrade (ADR-0006, section 6): the new facility, not yet bought.
			upgrade: (farm) => ({ ...farm, facilities: [...farm.facilities, null] }),
			changes: [],
		},
	],
};

// The slice's facilities and recipes (#84), written out for the job and add-on tests rather than
// read from content, so the expected values don't recompute what the rules do.

/** Chicken feed takes 2 wheat and 60 s for 2 feed and 1 XP; bread 3 wheat and 300 s for 1 and 2 XP. */
export const feedMs = 60_000;
export const breadMs = 300_000;

export const feedMill = 0;
export const bakery = 1;
export const startFeed = { type: "startJob", facility: feedMill, recipe: "chickenFeed" } as const;
export const startBread = { type: "startJob", facility: bakery, recipe: "bread" } as const;

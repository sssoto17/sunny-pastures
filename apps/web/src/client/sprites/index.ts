// The sprite manifest (ADR-0010, section 7): every picture the map and the panels draw has an id
// here, and the id maps to one file name. The same name is the placeholder's file in git and the
// real sprite's file in the art bucket, so swapping the art needs no code change.

/** A picture the game draws: the content ids the slice lists, plus the map's own pieces. */
export type SpriteId =
	| "plotEmpty"
	| "plotGrowing"
	| "plotReady"
	| "wheat"
	| "chickenFeed"
	| "egg"
	| "bread"
	| "cookies"
	| "chickenPen"
	| "chicken"
	| "feedMill"
	| "bakery"
	| "lotForSale"
	| "coins"
	| "xp";

/** Each sprite's file name, relative to the art base URL or to `/sprites/placeholder/`. */
export const spriteManifest = {
	plotEmpty: "plot-empty.svg",
	plotGrowing: "plot-growing.svg",
	plotReady: "plot-ready.svg",
	wheat: "wheat.svg",
	chickenFeed: "chicken-feed.svg",
	egg: "egg.svg",
	bread: "bread.svg",
	cookies: "cookies.svg",
	chickenPen: "chicken-pen.svg",
	chicken: "chicken.svg",
	feedMill: "feed-mill.svg",
	bakery: "bakery.svg",
	lotForSale: "lot-for-sale.svg",
	coins: "coins.svg",
	xp: "xp.svg",
} as const satisfies Record<SpriteId, `${string}.svg`>;

/**
 * Where a sprite's file is served from: `NEXT_PUBLIC_ART_BASE_URL/<file>` when that variable is set
 * and not empty, else the placeholder committed under `public/sprites/placeholder/`. A trailing
 * slash on the base URL is ignored. Next inlines the variable into the browser bundle at build time.
 */
export function spriteUrl(id: SpriteId): string {
	const file = spriteManifest[id];
	const base = process.env["NEXT_PUBLIC_ART_BASE_URL"];
	if (base === undefined || base === "") return `/sprites/placeholder/${file}`;

	return `${base.replace(/\/$/, "")}/${file}`;
}

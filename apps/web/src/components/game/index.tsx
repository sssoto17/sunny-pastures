"use client";

/**
 * The game's client root (ADR-0010): the farm map, the HUD and the order board mount here, and it
 * owns loading the farm through `src/client/`. Until that lands it shows the loading state only.
 * No styling: the design-system strand fills `components/ui/` (ADR-0010, section 6).
 */
export function Game() {
	return <p role="status">Loading your farm…</p>;
}

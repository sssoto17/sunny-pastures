// The map's camera (ADR-0010, "Rendering: DOM map"): a pan and a scale applied to the map's
// content as one CSS transform. Pure functions, so the gestures and the keys share one rule.

/** Where the content's origin sits in the container, in px, and how large the content is drawn. */
export interface View {
	readonly x: number;
	readonly y: number;
	readonly scale: number;
}

export interface Point {
	readonly x: number;
	readonly y: number;
}

/** The zoom range: the smallest and largest `scale`. */
export const zoomRange = { min: 0.4, max: 3 } as const;
/** What one press of a zoom button or key multiplies the scale by. */
export const zoomStep = 1.25;
/** How far an arrow key pans, in px. */
export const panStep = 60;
/** How far a pointer travels before a press becomes a drag, in px. */
export const dragThreshold = 4;

function clampScale(scale: number): number {
	return Math.min(zoomRange.max, Math.max(zoomRange.min, scale));
}

export function panBy(view: View, dx: number, dy: number): View {
	return { ...view, x: view.x + dx, y: view.y + dy };
}

/** Scales by `factor` (clamped) so the content under `around`, a point in the container, stays put. */
export function zoomAt(view: View, factor: number, around: Point): View {
	const scale = clampScale(view.scale * factor);
	const ratio = scale / view.scale;
	return {
		scale,
		x: around.x - (around.x - view.x) * ratio,
		y: around.y - (around.y - view.y) * ratio,
	};
}

/** Puts the content point `center` in the middle of a container of `size`, at scale 1. */
export function recentre(size: Point, center: Point): View {
	return { scale: 1, x: size.x / 2 - center.x, y: size.y / 2 - center.y };
}

export function toTransform(view: View): string {
	return `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.scale)})`;
}

import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

import { dragThreshold, panBy, zoomAt, type Point, type View } from "./view";

// The pointer gestures (ADR-0010, "Rendering: DOM map"): drag to pan, wheel and pinch to zoom
// around the pointer. They only compute the next view; the component owns the state.

type SetView = (update: (view: View) => View) => void;

/** How much a wheel notch zooms: the scale multiplies by `exp(-deltaY * wheelSensitivity)`. */
const wheelSensitivity = 0.0015;

/** Firefox reports wheel notches in lines; this converts them to px. */
const lineHeight = 16;

export interface Gestures {
	onPointerDown(event: PointerEvent<HTMLElement>): void;
	onPointerMove(event: PointerEvent<HTMLElement>): void;
	onPointerUp(event: PointerEvent<HTMLElement>): void;
	onPointerCancel(event: PointerEvent<HTMLElement>): void;
}

/** Wires the wheel (a native, non-passive listener, so the page doesn't scroll) and the pointers. */
export function useGestures(container: RefObject<HTMLElement | null>, setView: SetView): Gestures {
	const pointers = useRef(new Map<number, Point>());
	const isDragging = useRef(false);

	useEffect(() => {
		const element = container.current;
		if (element === null) return;

		const handleWheel = (event: WheelEvent) => {
			event.preventDefault();
			const around = relativeTo(element, event);
			const pixels =
				event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? lineHeight : 1);
			setView((view) => zoomAt(view, Math.exp(-pixels * wheelSensitivity), around));
		};
		element.addEventListener("wheel", handleWheel, { passive: false });
		return () => {
			element.removeEventListener("wheel", handleWheel);
		};
	}, [container, setView]);

	const release = (event: PointerEvent<HTMLElement>) => {
		pointers.current.delete(event.pointerId);
		if (pointers.current.size === 0) isDragging.current = false;
	};

	return {
		onPointerDown: (event) => {
			pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
			isDragging.current = pointers.current.size > 1;
		},
		onPointerMove: (event) => {
			const previous = pointers.current.get(event.pointerId);
			if (previous === undefined) return;

			const next = { x: event.clientX, y: event.clientY };
			const others = [...pointers.current].filter(([id]) => id !== event.pointerId);
			pointers.current.set(event.pointerId, next);

			const other = others[0]?.[1];
			if (other !== undefined) {
				pinch(container.current, setView, { previous, next, other });
				return;
			}

			if (
				!isDragging.current &&
				Math.hypot(next.x - previous.x, next.y - previous.y) < dragThreshold
			) {
				return;
			}

			// Capture only once the press is a drag, so a plain press still reaches the lot under it.
			if (!isDragging.current) event.currentTarget.setPointerCapture(event.pointerId);
			isDragging.current = true;
			setView((view) => panBy(view, next.x - previous.x, next.y - previous.y));
		},
		onPointerUp: release,
		onPointerCancel: release,
	};
}

interface PinchMove {
	readonly previous: Point;
	readonly next: Point;
	/** The other finger, which stayed where it was. */
	readonly other: Point;
}

/** Zooms by the change in the fingers' distance, around their midpoint. */
function pinch(element: HTMLElement | null, setView: SetView, move: PinchMove): void {
	if (element === null) return;

	const before = Math.hypot(move.previous.x - move.other.x, move.previous.y - move.other.y);
	const after = Math.hypot(move.next.x - move.other.x, move.next.y - move.other.y);
	if (before === 0) return;

	const middle = { x: (move.next.x + move.other.x) / 2, y: (move.next.y + move.other.y) / 2 };
	const around = relativeTo(element, { clientX: middle.x, clientY: middle.y });
	setView((view) => zoomAt(view, after / before, around));
}

/** A client point as a point in `element`. */
function relativeTo(
	element: HTMLElement,
	client: { readonly clientX: number; readonly clientY: number },
): Point {
	const rect = element.getBoundingClientRect();
	return { x: client.clientX - rect.left, y: client.clientY - rect.top };
}

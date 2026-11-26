"use client";

import { LocateFixed, ZoomIn, ZoomOut } from "lucide-react";
import {
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
} from "react";

import type { FarmState } from "@sunny-pastures/sim";

import { spriteUrl } from "@/client/sprites";
import { Button, IconButton } from "@/components/ui";

import { useGestures } from "./gestures";
import { describeLot, lotDepth, lotPosition, lots, mapCenter, tileSize, type Lot } from "./lots";
import { panBy, panStep, recentre, toTransform, zoomAt, zoomStep, type View } from "./view";

/**
 * The farm map (ADR-0010, "Rendering: DOM map"): one container that fills the viewport, in any
 * orientation, holding every lot as a `Button` placed by its isometric coordinates. The content
 * moves by one CSS transform, so panning and zooming never reflow it. Pattern: a camera (`View`)
 * over a fixed scene, with the keys, the buttons and the pointer all producing the next `View`.
 * Rejected: a canvas, which would need its own hit-testing and accessibility tree.
 */
export interface FarmMapProps {
	readonly farm: FarmState;
}

const containerStyle: CSSProperties = {
	position: "fixed",
	inset: 0,
	overflow: "hidden",
	// The map handles every touch gesture itself, so the browser doesn't scroll or zoom the page.
	touchAction: "none",
};

const contentStyle: CSSProperties = {
	position: "absolute",
	left: 0,
	top: 0,
	transformOrigin: "0 0",
};

export function FarmMap({ farm }: FarmMapProps) {
	const container = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
	const gestures = useGestures(container, setView);

	const containerCenter = useCallback(() => {
		const rect = container.current?.getBoundingClientRect();
		return { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
	}, []);
	const handleRecentre = useCallback(() => {
		const size = containerCenter();
		setView(recentre({ x: size.x * 2, y: size.y * 2 }, mapCenter()));
	}, [containerCenter]);
	const handleZoom = (factor: number) => {
		setView((v) => zoomAt(v, factor, containerCenter()));
	};

	// Once, before the first paint, so the farm opens in the middle of the screen.
	useLayoutEffect(() => {
		handleRecentre();
	}, [handleRecentre]);

	const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		// Leave browser shortcuts (Ctrl/Cmd +, -, 0 zoom; Alt+arrows history) alone.
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const next = keyToView(event.key);
		if (next === null) return;

		event.preventDefault();
		if (next === "recentre") handleRecentre();
		else if (next.type === "zoom") handleZoom(next.factor);
		else setView((v) => panBy(v, next.dx, next.dy));
	};

	return (
		<div
			ref={container}
			role="group"
			aria-label="Farm map"
			// Focusable, so the keys work before the player has tabbed to a lot (ADR-0010, accessibility bar).
			tabIndex={0}
			style={containerStyle}
			onKeyDown={handleKeyDown}
			{...gestures}
		>
			<div style={{ ...contentStyle, transform: toTransform(view) }}>
				{lots.map((lot) => (
					<LotButton key={`${lot.kind}-${String(lot.index)}`} lot={lot} farm={farm} />
				))}
			</div>
			<div style={{ position: "absolute", right: 16, bottom: 16, zIndex: 1000 }}>
				<IconButton
					label="Zoom in"
					onPress={() => {
						handleZoom(zoomStep);
					}}
				>
					<ZoomIn aria-hidden />
				</IconButton>
				<IconButton
					label="Zoom out"
					onPress={() => {
						handleZoom(1 / zoomStep);
					}}
				>
					<ZoomOut aria-hidden />
				</IconButton>
				<IconButton label="Recentre" onPress={handleRecentre}>
					<LocateFixed aria-hidden />
				</IconButton>
			</div>
		</div>
	);
}

type KeyMove =
	| "recentre"
	| { readonly type: "zoom"; readonly factor: number }
	| { readonly type: "pan"; readonly dx: number; readonly dy: number };

/** What a key does to the view: `+`, `-`, `0` and the arrow keys; null for any other key. */
function keyToView(key: string): KeyMove | null {
	switch (key) {
		case "+":
		case "=":
			return { type: "zoom", factor: zoomStep };
		case "-":
			return { type: "zoom", factor: 1 / zoomStep };
		case "0":
			return "recentre";
		case "ArrowLeft":
			return { type: "pan", dx: panStep, dy: 0 };
		case "ArrowRight":
			return { type: "pan", dx: -panStep, dy: 0 };
		case "ArrowUp":
			return { type: "pan", dx: 0, dy: panStep };
		case "ArrowDown":
			return { type: "pan", dx: 0, dy: -panStep };
		default:
			return null;
	}
}

interface LotButtonProps {
	readonly lot: Lot;
	readonly farm: FarmState;
}

/** One lot: its sprite in a `Button` named for what stands there, stacked back to front. */
function LotButton({ lot, farm }: LotButtonProps) {
	const { name, sprite } = describeLot(lot, farm);
	const { x, y } = lotPosition(lot);
	return (
		<div
			style={{
				position: "absolute",
				left: x,
				top: y,
				width: tileSize.width,
				zIndex: lotDepth(lot),
			}}
		>
			<Button variant="quiet">
				<img src={spriteUrl(sprite)} alt={name} width={tileSize.width} draggable={false} />
			</Button>
		</div>
	);
}

"use client";

import { LocateFixed, ZoomIn, ZoomOut } from "lucide-react";
import {
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
} from "react";

import type { Action, FarmState } from "@sunny-pastures/sim";

import { spriteUrl } from "@/client/sprites";
import { Button, IconButton } from "@/components/ui";

import { useGestures } from "./gestures";
import { describeLot, lotDepth, lotPosition, lots, mapCenter, tileSize, type Lot } from "./lots";
import { LotSale } from "./sale";
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
	/**
	 * Wraps a lot's `Button`, so a screen can open its own UI from it (a plot's popover, #601);
	 * by default the button stands alone.
	 */
	readonly renderLot?: (lot: Lot, button: ReactElement) => ReactNode;
	/** The farm's Level, from 1: what decides whether a lot for sale can be bought (#602). */
	readonly level: number;
	/** Called with the action a lot's "Buy" sends (`buyPen`, `buyFacility`). */
	readonly onBuy: (action: Action) => void;
	/**
	 * Called when a bought lot is pressed, to open the building's own UI (F10, F11); left out
	 * until those exist.
	 */
	readonly onOpen?: (lot: Lot) => void;
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

export function FarmMap({ farm, level, onBuy, onOpen, renderLot = showButton }: FarmMapProps) {
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
					<LotButton
						key={`${lot.kind}-${String(lot.index)}`}
						lot={lot}
						farm={farm}
						level={level}
						onBuy={onBuy}
						onOpen={onOpen}
						renderLot={renderLot}
					/>
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

/**
 * A lot's hit area (#699): the tile's diamond, in the middle of the sprite's square where the tile
 * is drawn. It sits inside the lot's button, so a press on it presses the button, while the rest
 * of the lot, its sprite included, lets presses through to the lot behind. Diamonds of
 * neighbouring tiles meet edge to edge, so every point on the farm belongs to one lot. Rejected:
 * `clip-path` on the button itself, which would also clip its focus ring.
 */
const tileHitStyle: CSSProperties = {
	position: "absolute",
	left: 0,
	top: (tileSize.width - tileSize.height) / 2,
	width: tileSize.width,
	height: tileSize.height,
	clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
	pointerEvents: "auto",
};

interface LotButtonProps {
	readonly lot: Lot;
	readonly farm: FarmState;
	readonly level: number;
	readonly onBuy: (action: Action) => void;
	readonly onOpen: ((lot: Lot) => void) | undefined;
	readonly renderLot: NonNullable<FarmMapProps["renderLot"]>;
}

function showButton(_lot: Lot, button: ReactElement): ReactNode {
	return button;
}

/**
 * One lot: its sprite in a `Button` named for what stands there, stacked back to front. A lot for
 * sale opens its purchase popover; a bought one calls `onOpen`, wrapped by `renderLot`.
 */
function LotButton({ lot, farm, level, onBuy, onOpen, renderLot }: LotButtonProps) {
	const { name, sprite, isForSale } = describeLot(lot, farm);
	const handleOpen = () => {
		onOpen?.(lot);
	};
	const sign = (
		<Button variant="quiet" {...(isForSale ? {} : { onPress: handleOpen })}>
			<img src={spriteUrl(sprite)} alt={name} width={tileSize.width} draggable={false} />
			<span aria-hidden data-lot-tile="" style={tileHitStyle} />
		</Button>
	);
	const { x, y } = lotPosition(lot);
	return (
		<div
			style={{
				position: "absolute",
				left: x,
				top: y,
				width: tileSize.width,
				zIndex: lotDepth(lot),
				// The sprite's square reaches over the lots behind it, so only the tile takes a press (#699).
				pointerEvents: "none",
			}}
		>
			{isForSale ? (
				<LotSale lot={lot} farm={farm} level={level} trigger={sign} onBuy={onBuy} />
			) : (
				renderLot(lot, sign)
			)}
		</div>
	);
}

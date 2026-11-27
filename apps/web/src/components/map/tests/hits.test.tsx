import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createSim, sliceContent } from "@sunny-pastures/sim";

import { FarmMap } from "../index";
import { lotPosition, lots, tileSize, type Lot } from "../lots";

// #699: a lot's sprite is a square over a tile half as tall, so it reaches over the lots behind it.
// jsdom has no layout, so these tests hit-test the map the way a browser would from what it
// renders: every element that takes pointer events, with its box from its inline styles, the
// topmost (by the lot's z-index) containing the point winning.

const sim = createSim(sliceContent);
const farm = sim.newFarm("farm-hits");

interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface Hittable {
	readonly element: HTMLElement;
	/** The lot's place in the stack: its wrapper's z-index. */
	readonly depth: number;
	readonly box: Box;
	readonly isDiamond: boolean;
}

function renderMap(onOpen = vi.fn()) {
	render(<FarmMap farm={farm} level={1} onBuy={vi.fn()} onOpen={onOpen} />);
	const map = screen.getByRole("group", { name: "Farm map" });
	return { map, onOpen };
}

/** The pointer-events an element ends up with: its own inline value, else its nearest ancestor's. */
function readPointerEvents(element: HTMLElement): string {
	for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
		if (node.style.pointerEvents !== "") return node.style.pointerEvents;
	}

	return "auto";
}

/** Every element on the lots that takes pointer events, with its box in the content's px. */
function findHittables(map: HTMLElement): Hittable[] {
	const content = map.firstElementChild as HTMLElement;
	const wrappers = [...content.children] as HTMLElement[];
	return wrappers.flatMap((wrapper) =>
		[wrapper, ...wrapper.querySelectorAll<HTMLElement>("*")]
			.filter((element) => readPointerEvents(element) !== "none")
			.map((element) => ({
				element,
				depth: Number(wrapper.style.zIndex),
				box: {
					x: readPx(wrapper.style.left) + readPx(element.style.left),
					y: readPx(wrapper.style.top) + readPx(element.style.top),
					width: readPx(element.style.width),
					height: readPx(element.style.height),
				},
				isDiamond: element.style.clipPath === "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
			})),
	);
}

function readPx(value: string): number {
	return value === "" ? 0 : Number(value.replace(/px$/, ""));
}

/** Whether `point` falls inside the diamond inscribed in `box`. */
function isInDiamond(box: Box, point: { x: number; y: number }): boolean {
	const dx = Math.abs(point.x - (box.x + box.width / 2)) / (box.width / 2);
	const dy = Math.abs(point.y - (box.y + box.height / 2)) / (box.height / 2);
	return dx + dy <= 1;
}

/** The middle of the lot's tile: the middle of its sprite's square, where the tile is drawn. */
function findTileCentre(lot: Lot): { x: number; y: number } {
	const { x, y } = lotPosition(lot);
	return { x: x + tileSize.width / 2, y: y + tileSize.width / 2 };
}

function hitTest(map: HTMLElement, point: { x: number; y: number }): HTMLElement {
	const hits = findHittables(map)
		.filter((h) => isInDiamond(h.box, point))
		.sort((a, b) => b.depth - a.depth);
	const [top, next] = hits;
	if (top === undefined) throw new Error(`Nothing takes a press at ${JSON.stringify(point)}.`);

	// The tiles tile the plane, so no two lots' hit areas share a tile's centre.
	expect(next).toBeUndefined();
	return top.element;
}

describe("FarmMap hit areas", () => {
	it("takes pointer events only on each lot's tile diamond, never on its sprite's square", () => {
		const { map } = renderMap();

		const hittables = findHittables(map);
		expect(hittables).toHaveLength(lots.length);
		for (const hittable of hittables) {
			expect(hittable.isDiamond).toBe(true);
			expect(hittable.box.width).toBe(tileSize.width);
			expect(hittable.box.height).toBe(tileSize.height);
			expect(hittable.element.closest("button")).not.toBeNull();
		}
	});

	it.each(lots.map((lot) => [lot.label, lot] as const))(
		"opens %s on a press at the centre of its tile",
		async (_label, lot) => {
			const { map, onOpen } = renderMap();

			await userEvent.click(hitTest(map, findTileCentre(lot)));

			if (lot.kind === "plot") {
				expect(onOpen).toHaveBeenCalledExactlyOnceWith(lot);
			} else {
				expect(screen.getByRole("dialog", { name: lot.label })).toBeTruthy();
				expect(onOpen).not.toHaveBeenCalled();
			}
		},
	);
});

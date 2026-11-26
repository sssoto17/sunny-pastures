import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createSim, sliceContent } from "@sunny-pastures/sim";

import { FarmMap } from "../index";
import { lots } from "../lots";
import { zoomRange } from "../view";

const sim = createSim(sliceContent);
const farm = sim.newFarm("farm-map");

// jsdom has no pointer capture; the drag asks for it once a press becomes a drag.
beforeAll(() => {
	HTMLElement.prototype.setPointerCapture = vi.fn();
});

function renderMap(state = farm) {
	render(<FarmMap farm={state} />);
	return screen.getByRole("group", { name: "Farm map" });
}

/** The moving content: the container's only child that isn't the controls. */
function readTransform(map: HTMLElement): string {
	return (map.firstElementChild as HTMLElement).style.transform;
}

function readScale(map: HTMLElement): number {
	return Number(/scale\(([\d.]+)\)/.exec(readTransform(map))?.[1]);
}

describe("FarmMap lots", () => {
	it("puts every lot in the Tab order, each with an accessible name", async () => {
		renderMap();

		const buttons = screen.getAllByRole("button").filter((b) => b.querySelector("img") !== null);
		expect(buttons).toHaveLength(lots.length);

		await userEvent.tab();
		expect(document.activeElement).toBe(screen.getByRole("group", { name: "Farm map" }));
		await userEvent.tab();
		expect(document.activeElement).toBe(buttons[0]);
		for (const button of buttons) {
			expect(button.querySelector("img")?.getAttribute("alt")).toMatch(/\S/);
		}
	});

	it("names a plot by its crop and state, and a lot not yet bought as for sale", () => {
		const planted = sim.apply(farm, { type: "plant", plot: 2, crop: "wheat" }, 0);
		if (!planted.ok) throw new Error(planted.reason);
		renderMap({ ...planted.state, pens: [], facilities: [] });

		expect(screen.getByRole("button", { name: "Plot 3: wheat, growing" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Plot 1: empty" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Chicken pen: for sale" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Bakery: for sale" })).toBeTruthy();
	});

	it("stacks lots back to front by their coordinates", () => {
		renderMap();

		const zIndex = (name: string) =>
			Number(screen.getByRole("button", { name }).parentElement?.style.zIndex);
		expect(zIndex("Plot 6: empty")).toBeGreaterThan(zIndex("Plot 1: empty"));
	});
});

describe("FarmMap camera", () => {
	it("zooms with the buttons and the keys, within the range", async () => {
		const map = renderMap();
		const start = readScale(map);

		await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		const zoomedIn = readScale(map);
		expect(zoomedIn).toBeGreaterThan(start);

		await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
		expect(readScale(map)).toBeCloseTo(start);

		fireEvent.keyDown(map, { key: "+" });
		expect(readScale(map)).toBeGreaterThan(start);
		fireEvent.keyDown(map, { key: "-" });
		expect(readScale(map)).toBeCloseTo(start);

		for (let i = 0; i < 30; i++) fireEvent.keyDown(map, { key: "+" });
		expect(readScale(map)).toBe(zoomRange.max);
		for (let i = 0; i < 60; i++) fireEvent.keyDown(map, { key: "-" });
		expect(readScale(map)).toBe(zoomRange.min);
	});

	it("pans with the arrow keys and recentres with 0 or the button", async () => {
		const map = renderMap();
		const start = readTransform(map);

		fireEvent.keyDown(map, { key: "ArrowLeft" });
		expect(readTransform(map)).not.toBe(start);

		fireEvent.keyDown(map, { key: "0" });
		expect(readTransform(map)).toBe(start);

		fireEvent.keyDown(map, { key: "ArrowDown" });
		await userEvent.click(screen.getByRole("button", { name: "Recentre" }));
		expect(readTransform(map)).toBe(start);
	});

	it("leaves browser shortcuts alone when a modifier key is held", () => {
		const map = renderMap();
		const start = readTransform(map);

		for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
			for (const key of ["-", "+", "0", "ArrowLeft"]) {
				fireEvent.keyDown(map, { key, [modifier]: true });
			}
		}
		expect(readTransform(map)).toBe(start);
	});

	it("zooms in on a wheel up and out on a wheel down", () => {
		const map = renderMap();
		const start = readScale(map);

		fireEvent.wheel(map, { deltaY: -100 });
		expect(readScale(map)).toBeGreaterThan(start);

		fireEvent.wheel(map, { deltaY: 300 });
		expect(readScale(map)).toBeLessThan(start);
	});

	it("pans when the pointer is dragged", () => {
		const map = renderMap();
		const start = readTransform(map);

		fireEvent.pointerDown(map, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerMove(map, { pointerId: 1, clientX: 140, clientY: 120 });
		fireEvent.pointerUp(map, { pointerId: 1 });

		expect(readTransform(map)).not.toBe(start);
	});

	it("zooms when two pointers pinch apart", () => {
		const map = renderMap();
		const start = readScale(map);

		fireEvent.pointerDown(map, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerDown(map, { pointerId: 2, clientX: 140, clientY: 100 });
		fireEvent.pointerMove(map, { pointerId: 2, clientX: 220, clientY: 100 });

		expect(readScale(map)).toBeGreaterThan(start);
	});
});

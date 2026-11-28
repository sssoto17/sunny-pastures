import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSim, sliceContent, type Action, type FarmState } from "@sunny-pastures/sim";

import { useFarmHarness } from "@/client/store/tests/clock";

import { getLotTile } from "../../map/tests/press";
import Game from "../index";

const sim = createSim(sliceContent);
const hour = 3_600_000;
const away = 8 * hour;
const confirmedAt = 1_000_000;
const harness = useFarmHarness(confirmedAt + away);

/** A farm with a crop planted, a job started and a chicken fed at `confirmedAt`: all take under 8 h. */
function buildBusyFarm(): FarmState {
	const start: FarmState = {
		...sim.newFarm("farm-cues"),
		silo: { wheat: 10 },
		barn: { chickenFeed: 1 },
		pens: [{ trough: 0, animals: [{ status: "idle" }], products: 0 }],
		facilities: [
			{ tier: 1, jobs: [], lastRecipe: null, addOns: { loop: false, collector: false } },
			{ tier: 2, jobs: [], lastRecipe: null, addOns: { loop: false, collector: false } },
		],
	};
	const actions: Action[] = [
		{ type: "plant", plot: 0, crop: "wheat" },
		{ type: "startJob", facility: 0, recipe: "chickenFeed" },
		{ type: "feed", pen: 0 },
	];
	return actions.reduce((state, action) => {
		const result = sim.apply(state, action, confirmedAt);
		if (!result.ok) throw new Error(result.reason);
		return result.state;
	}, start);
}

async function loadAwayFarm() {
	render(<Game store={harness.store} />);
	const state = buildBusyFarm();
	await act(() =>
		harness.fake.loads[0]?.answer({
			ok: true,
			farm: { seq: 0, at: confirmedAt, state, rulesVersion: 1 },
		}),
	);
}

function stubMotion(isReduced: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: isReduced && query === "(prefers-reduced-motion: reduce)",
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("attention cues", () => {
	it("shows every cue on load for a farm confirmed 8 hours ago, with no pop-up", async () => {
		stubMotion(false);
		await loadAwayFarm();

		for (const [name, text] of [
			[/^Plot 1: wheat, ready$/, "ready"],
			[/^Feed mill: 1 ready$/, "1 ready"],
			[/^Chicken pen: 1 egg waiting$/, "1 egg waiting"],
		] as const) {
			const lot = screen.getByRole("button", { name });
			const cue = lot.parentElement?.querySelector("[data-tone='attention']");
			expect(cue?.textContent).toBe(text);
			expect(cue?.hasAttribute("data-pulse")).toBe(true);
		}

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("removes a cue once it is collected", async () => {
		stubMotion(false);
		await loadAwayFarm();
		const user = userEvent.setup();

		await user.click(getLotTile(/^Chicken pen/));
		await user.click(screen.getByRole("button", { name: "Collect eggs" }));

		// The popover hides the map from the accessibility tree while it is open.
		const lots = { hidden: true } as const;
		expect(screen.queryByRole("button", { ...lots, name: /^Chicken pen: / })).toBeNull();
		expect(screen.getByRole("button", { ...lots, name: "Chicken pen" })).toBeTruthy();
		expect(screen.queryByText("1 egg waiting")).toBeNull();
		expect(screen.getByText("ready")).toBeTruthy();
		expect(screen.getByText("1 ready")).toBeTruthy();
	});

	it("sets no data-pulse under reduced motion, but still shows the cues", async () => {
		stubMotion(true);
		await loadAwayFarm();

		// The order board's own badge is not a lot's cue.
		const map = screen.getByRole("group", { name: "Farm map" });
		const cues = map.querySelectorAll("[data-tone='attention']");
		expect(cues).toHaveLength(3);
		for (const cue of cues) expect(cue.hasAttribute("data-pulse")).toBe(false);
	});
});

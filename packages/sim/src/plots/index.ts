// Plots: buying, planting, ripening and harvesting crops (MUST-01, MUST-06.1).
import { assertTime } from "../advance/index.js";
import type { AutomatedStep, StepSource } from "../advance/index.js";
import type { Content } from "../content/index.js";
import { cropLocked, gainXp, prepareProgressRules, purchase } from "../progress/index.js";
import type { ProgressRules } from "../progress/index.js";
import { mulberry32 } from "../random/index.js";
import { refuse } from "../state/index.js";
import type { ApplyResult, FarmState } from "../state/index.js";

/** One plot of the farm's state (ADR-0005, section 3: the plots module owns it). */
export type Plot =
	| { readonly status: "empty" }
	/** Ripens as an automated step at `readyAt`, in ms (MUST-01.2). */
	| { readonly status: "growing"; readonly crop: string; readonly readyAt: number }
	| { readonly status: "ready"; readonly crop: string };

/** The actions on plots (MUST-01, MUST-06.1). `plot` is an index in content order. */
export type PlotAction =
	| { readonly type: "plant"; readonly plot: number; readonly crop: string }
	| { readonly type: "harvest"; readonly plot: number }
	/**
	 * Buys the next plot. `plot` names it and must be the farm's plot count, so an action sent
	 * twice buys one plot, not two.
	 */
	| { readonly type: "buyPlot"; readonly plot: number };

/** The plot rules for one content, prepared once in createSim. */
export interface PlotRules {
	readonly crops: ReadonlyMap<string, CropRules>;
	readonly siloCapacity: number;
	/** The plots a new farm starts with. */
	readonly startPlots: number;
	/** The plots beyond the start, in the order they are bought: the Level and price of each. */
	readonly extraPlots: readonly ExtraPlot[];
	readonly progress: ProgressRules;
}

/** Prepares the content once: grow times in ms (D7) and bonus odds as a draw threshold (D16). */
export function preparePlotRules(content: Content): PlotRules {
	const crops = Object.entries(content.crops).map(([id, crop]): [string, CropRules] => [
		id,
		{
			id,
			seedPrice: crop.seedPrice,
			growMs: crop.growSeconds * 1000,
			baseYield: crop.baseYield,
			// A draw is a uniform uint32, so it falls under this with odds bonusPerMille / 1000.
			bonusBelow: Math.floor((crop.bonusPerMille * uint32End) / 1000),
			bonusYield: crop.bonusYield,
			xp: crop.xp,
		},
	]);
	return {
		crops: new Map(crops),
		siloCapacity: content.silo.capacity,
		startPlots: content.start.plots,
		extraPlots: prepareExtraPlots(content),
		progress: prepareProgressRules(content),
	};
}

/**
 * Buys the next plot for its price, once the farm's Level unlocks it, through the purchase rule
 * (MUST-06.1, spec decision 1). The plot is added empty, at the end.
 */
export function buyPlot(farm: FarmState, index: number, rules: PlotRules): ApplyResult {
	const count = farm.plots.length;
	const extra = rules.extraPlots[count - rules.startPlots];
	if (extra === undefined) {
		const most = rules.startPlots + rules.extraPlots.length;
		return refuse(`The farm can't have more than ${String(most)} plots.`);
	}

	if (index !== count) return refuse(`The next plot to buy is plot ${formatPlotNumber(count)}.`);

	const bought = purchase(
		farm,
		{ what: `Plot ${formatPlotNumber(count)}`, ...extra },
		rules.progress,
	);
	if (!bought.ok) return bought;

	return { ok: true, state: { ...bought.state, plots: [...farm.plots, { status: "empty" }] } };
}

/**
 * Plants an unlocked crop on an empty plot at the farm's time, for its seed price (MUST-01.1,
 * 01.2).
 */
export function plant(
	farm: FarmState,
	index: number,
	cropId: string,
	rules: PlotRules,
): ApplyResult {
	const plot = findPlot(farm, index);
	if (plot === null) return refuse(`There is no plot ${formatPlotNumber(index)}.`);

	const crop = rules.crops.get(cropId);
	if (crop === undefined) return refuse(`There is no crop ${cropId}.`);
	const locked = cropLocked(crop.id, farm.xp, rules.progress);
	if (locked !== null) return refuse(locked);

	if (plot.status !== "empty") return refuse(`Plot ${formatPlotNumber(index)} isn't empty.`);
	if (farm.coins < crop.seedPrice) {
		return refuse(
			`Planting ${crop.id} costs ${String(crop.seedPrice)} coins, and the farm has ${String(farm.coins)}.`,
		);
	}

	const readyAt = farm.time + crop.growMs;
	assertTime(readyAt);
	const growing = { status: "growing", crop: crop.id, readyAt } as const;
	return {
		ok: true,
		state: { ...replacePlot(farm, index, growing), coins: farm.coins - crop.seedPrice },
	};
}

/**
 * Harvests a ready plot: the base yield plus a bonus drawn from the yields stream goes into the
 * silo, and the harvest gives XP, with the level-up coins of any Level it reaches (MUST-01.3, 01.4,
 * 05.4). Refused if the silo can't hold it all.
 */
export function harvest(farm: FarmState, index: number, rules: PlotRules): ApplyResult {
	const plot = findPlot(farm, index);
	if (plot === null) return refuse(`There is no plot ${formatPlotNumber(index)}.`);
	if (plot.status !== "ready") {
		return refuse(`Plot ${formatPlotNumber(index)} isn't ready to harvest.`);
	}

	const crop = rules.crops.get(plot.crop);
	if (crop === undefined) return refuse(`There is no crop ${plot.crop}.`);

	const draw = mulberry32(farm.streams.yields);
	const amount = crop.baseYield + (draw.value < crop.bonusBelow ? crop.bonusYield : 0);
	const room = rules.siloCapacity - sumSilo(farm.silo);
	if (amount > room) {
		return refuse(
			`The silo has room for ${String(room)} more crop${room === 1 ? "" : "s"}, and the harvest is ${String(amount)} ${crop.id}.`,
		);
	}

	const harvested = {
		...replacePlot(farm, index, { status: "empty" }),
		silo: { ...farm.silo, [crop.id]: (farm.silo[crop.id] ?? 0) + amount },
		streams: { ...farm.streams, yields: draw.next },
	};
	return { ok: true, state: gainXp(harvested, crop.xp, rules.progress) };
}

/** Ripening: a growing plot becomes ready at its `readyAt` (MUST-01.2). */
export const ripening: StepSource<FarmState> = {
	steps: (farm) =>
		farm.plots.flatMap((plot, index): AutomatedStep[] =>
			plot.status === "growing" ? [{ at: plot.readyAt, kind: "ripen", index, slot: 0 }] : [],
		),
	run: (farm, step) => {
		const plot = farm.plots[step.index];
		if (plot?.status !== "growing") return farm;

		return replacePlot(farm, step.index, { status: "ready", crop: plot.crop });
	},
};

const uint32End = 2 ** 32;

interface ExtraPlot {
	/** The Level that unlocks it. */
	readonly level: number;
	readonly price: number;
}

/**
 * Each Level unlocks its `plots` after the ones before it, and each plot costs growthPerMille /
 * 1000 times the one before, rounded down: integer steps, never Math.pow (D16).
 */
function prepareExtraPlots(content: Content): ExtraPlot[] {
	const { first, growthPerMille } = content.plotPrice;
	const levels = content.levels.flatMap((row, i) => Array.from({ length: row.plots }, () => i + 1));
	let price = first;
	return levels.map((level) => {
		const extra = { level, price };
		price = Math.floor((price * growthPerMille) / 1000);
		return extra;
	});
}

interface CropRules {
	readonly id: string;
	readonly seedPrice: number;
	readonly growMs: number;
	readonly baseYield: number;
	readonly bonusBelow: number;
	readonly bonusYield: number;
	readonly xp: number;
}

function findPlot(farm: FarmState, index: number): Plot | null {
	return Number.isSafeInteger(index) && index >= 0 ? (farm.plots[index] ?? null) : null;
}

/** Players count plots from 1. */
function formatPlotNumber(index: number): string {
	return String(index + 1);
}

/** The silo's fill. A sum, so the order of the goods' keys can't matter (MUST-10.6). */
function sumSilo(silo: FarmState["silo"]): number {
	return Object.values(silo).reduce((total, count) => total + count, 0);
}

function replacePlot(farm: FarmState, index: number, plot: Plot): FarmState {
	return { ...farm, plots: farm.plots.map((current, i) => (i === index ? plot : current)) };
}

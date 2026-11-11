// The rules as a function of content (ADR-0003, section 1, D5): createSim closes over the content,
// so keeping an old rules version means keeping an old content object (#31).
import { advanceFarm, assertTime } from "../advance/index.js";
import type { StepSource } from "../advance/index.js";
import type { Content } from "../content/index.js";
import {
	buyPen,
	collectProducts,
	createProducing,
	feed,
	newPens,
	preparePenRules,
} from "../pens/index.js";
import { buyPlot, harvest, plant, preparePlotRules, ripening } from "../plots/index.js";
import { prepareProgressRules } from "../progress/index.js";
import { streamSeed } from "../random/index.js";
import { refuse } from "../state/index.js";
import type { Action, ApplyResult, FarmState } from "../state/index.js";
import { prepareStorageRules } from "../storage/index.js";

/** The simulation for one content. Pure: time arrives as an argument (ADR-0003, "The interface"). */
export interface Sim {
	/** A new farm (spec decision 5) at time 0, its streams seeded from `farmId` (D9). */
	newFarm(farmId: string): FarmState;
	/**
	 * Advances the farm to `at`, then applies `action`. A refusal is returned, never thrown, and
	 * carries no state (D15); an `at` before the farm's time is refused (D7, MUST-14.7). Throws a
	 * RangeError if `at` isn't a safe integer.
	 */
	apply(state: FarmState, action: Action, at: number): ApplyResult;
	/**
	 * Runs every automated step up to and including `to` (D6). Returns `state` itself if `to` is
	 * before its time (D7). Throws a RangeError if `to` isn't a safe integer.
	 */
	advance(state: FarmState, to: number): FarmState;
}

export function createSim(content: Content): Sim {
	const progress = prepareProgressRules(content);
	const storage = prepareStorageRules(content);
	const plotRules = preparePlotRules(content, progress, storage);
	const penRules = preparePenRules(content, progress, storage);
	// Every feature's automated steps. advance/'s tie key orders them, and this list's order never
	// matters: two steps with the same key are a programmer error, which advanceFarm throws on as a
	// RangeError. Each new kind must keep its keys unique (MUST-10.6).
	const sources: readonly StepSource<FarmState>[] = [ripening, createProducing(penRules)];
	const advance = (state: FarmState, to: number): FarmState => advanceFarm(state, to, sources);

	return {
		newFarm: (farmId) => ({
			time: 0,
			coins: content.start.coins,
			xp: 0,
			silo: {},
			barn: { ...content.start.barn },
			plots: Array.from({ length: content.start.plots }, () => ({ status: "empty" }) as const),
			pens: newPens(penRules),
			streams: { yields: streamSeed(farmId, "yields"), orders: streamSeed(farmId, "orders") },
		}),
		apply: (state, action, at) => {
			assertTime(at);
			if (at < state.time) {
				return refuse(
					`The action is at ${String(at)} ms, before the farm's time of ${String(state.time)} ms.`,
				);
			}

			const farm = advance(state, at);
			switch (action.type) {
				case "plant":
					return plant(farm, action.plot, action.crop, plotRules);
				case "harvest":
					return harvest(farm, action.plot, plotRules);
				case "buyPlot":
					return buyPlot(farm, action.plot, plotRules);
				case "buyPen":
					return buyPen(farm, action.pen, penRules);
				case "feed":
					return feed(farm, action.pen, penRules);
				case "collectProducts":
					return collectProducts(farm, action.pen, penRules);
			}
		},
		advance,
	};
}

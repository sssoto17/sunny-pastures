// The rules as a function of content (ADR-0003, section 1, D5): createSim closes over the content,
// so keeping an old rules version means keeping an old content object (#31).
import { advanceFarm, assertTime } from "../advance/index.js";
import type { StepSource } from "../advance/index.js";
import type { Content } from "../content/index.js";
import {
	buyAddOn,
	buyFacility,
	collect,
	createCollecting,
	createLooping,
	jobFinishing,
	newFacilities,
	prepareFacilityRules,
	startJob,
} from "../facilities/index.js";
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
	 * Advances the farm to `at`, applies `action`, then runs any automated step it made due at `at`.
	 * A refusal is returned, never thrown, and carries no state (D15); an `at` before the farm's time
	 * is refused (D7, MUST-14.7). Throws a RangeError if `at` isn't a safe integer.
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
	const facilityRules = prepareFacilityRules(content, progress, storage);
	const penRules = preparePenRules(content, progress, storage);
	// Every feature's automated steps. advance/'s tie key orders them, and this list's order never
	// matters: two steps with the same key are a programmer error, which advanceFarm throws on as a
	// RangeError. Each new kind must keep its keys unique (MUST-10.6).
	const sources: readonly StepSource<FarmState>[] = [
		ripening,
		jobFinishing,
		createProducing(penRules),
		createCollecting(facilityRules),
		createLooping(facilityRules),
	];
	const advance = (state: FarmState, to: number): FarmState => advanceFarm(state, to, sources);

	return {
		newFarm: (farmId) => ({
			time: 0,
			coins: content.start.coins,
			xp: 0,
			silo: {},
			barn: {},
			plots: Array.from({ length: content.start.plots }, () => ({ status: "empty" }) as const),
			facilities: newFacilities(facilityRules),
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

			// An action can make a step due at its own time, such as a Collector moving goods that
			// waited, once it is bought or feeding frees room, or a Loop restarting into the slot a
			// collect freed; advancing again runs it, so every farm the rules return has run its steps
			// up to its time (D6), and advancing it to that time changes nothing.
			const result = act(advance(state, at), action);
			return result.ok ? { ok: true, state: advance(result.state, at) } : result;
		},
		advance,
	};

	function act(farm: FarmState, action: Action): ApplyResult {
		switch (action.type) {
			case "plant":
				return plant(farm, action.plot, action.crop, plotRules);
			case "harvest":
				return harvest(farm, action.plot, plotRules);
			case "buyPlot":
				return buyPlot(farm, action.plot, plotRules);
			case "buyFacility":
				return buyFacility(farm, action.facility, facilityRules);
			case "startJob":
				return startJob(farm, action.facility, action.recipe, facilityRules);
			case "buyPen":
				return buyPen(farm, action.pen, penRules);
			case "feed":
				return feed(farm, action.pen, penRules);
			case "collectProducts":
				return collectProducts(farm, action.pen, penRules);
			case "collect":
				return collect(farm, action.facility, facilityRules);
			case "buyAddOn":
				return buyAddOn(farm, action.facility, action.addOn, facilityRules);
		}
	}
}

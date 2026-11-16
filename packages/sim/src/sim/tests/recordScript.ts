// The determinism gate's scripted player (#48; ADR-0001, step 0): a fixed seed gives the same 500
// steps every time. It plays a shadow farm, so most steps are ones the rules accept, at times 5 to
// 40 s apart, and about one in 20 is a step the rules refuse. From step 250 it waits for a moment
// with crops growing and a job running, then is away for 8 hours, so the gap's offline progress
// runs ripening and jobs, not only order refills (#48's review). The gate replays the recording in
// determinismScript.json, not this player: `node .github/scripts/determinism-gate.mjs --record`
// writes it. #154 owns recordings per release.
import { createSim, sliceContent } from "../../index.js";
import type { Action, Content } from "../../index.js";
import { mulberry32 } from "../../random/index.js";
import { isBusy } from "./playScript.js";
import type { Script, ScriptStep } from "./playScript.js";

const steps = 500;
const gapFrom = 250;
const gapMs = 8 * 3_600_000;
const refusedPerMille = 50;
/** The player's own mulberry32 stream, apart from the farm's. */
const seed = 0x6a7e;

/** Records the gate's script over the slice: the same steps every time. */
export function recordScript(): Script {
	const sim = createSim(sliceContent);
	const farmId = "determinism-gate";
	const actions = listActions(sliceContent);
	let stream = seed;
	const draw = (below: number): number => {
		const { next, value } = mulberry32(stream);
		stream = next;
		return value % below;
	};

	let farm = sim.newFarm(farmId);
	let at = 0;
	let hasGapped = false;
	const script: ScriptStep[] = [];
	while (script.length < steps) {
		const isGap: boolean = !hasGapped && script.length >= gapFrom && isBusy(farm, at);
		hasGapped ||= isGap;
		at += isGap ? gapMs : (5 + draw(36)) * 1_000;
		const results = actions.map((action) => ({ action, result: sim.apply(farm, action, at) }));
		const isRefusal = draw(1_000) < refusedPerMille;
		const choices = results.filter(({ result }) => result.ok !== isRefusal);
		// A kind of action first, then one of that kind, so the many order slots don't crowd out
		// the rarer actions (buying a tier or an add-on).
		const kinds = [...new Set(choices.map(({ action }) => action.type))];
		const kind = kinds[draw(Math.max(kinds.length, 1))];
		const ofKind = choices.filter(({ action }) => action.type === kind);
		const chosen = ofKind[draw(Math.max(ofKind.length, 1))];
		// Nothing to do yet: wait a little longer.
		if (chosen === undefined) continue;

		if (chosen.result.ok) farm = chosen.result.state;
		script.push({ action: chosen.action, at });
	}
	return { farmId, steps: script };
}

/** Every action `content` names, and one more index of each kind, which the rules refuse. */
function listActions(content: Content): Action[] {
	const sum = (pick: (row: Content["levels"][number]) => number): number =>
		content.levels.reduce((total, row) => total + pick(row), 0);
	const upTo = (count: number): number[] => Array.from({ length: count + 1 }, (_item, i) => i);
	const crops = Object.keys(content.crops);
	const addOns = Object.keys(content.addOns) as (keyof Content["addOns"])[];

	const plots = upTo(content.start.plots + sum((row) => row.plots)).flatMap((plot): Action[] => [
		...crops.map((crop): Action => ({ type: "plant", plot, crop })),
		{ type: "harvest", plot },
		{ type: "buyPlot", plot },
	]);
	const facilities = upTo(content.facilities.length).flatMap((facility): Action[] => {
		const { recipes = {}, tiers = [] } = content.facilities[facility] ?? {};
		return [
			{ type: "buyFacility", facility },
			{ type: "collect", facility },
			...Object.keys(recipes).map((recipe): Action => ({ type: "startJob", facility, recipe })),
			...addOns.map((addOn): Action => ({ type: "buyAddOn", facility, addOn })),
			...tiers.map((_row, i): Action => ({ type: "buyTier", facility, tier: i + 2 })),
		];
	});
	const pens = upTo(content.pens.length).flatMap((pen): Action[] => [
		{ type: "buyPen", pen },
		{ type: "feed", pen },
		{ type: "collectProducts", pen },
	]);
	const slots = upTo(sum((row) => row.orderSlots)).flatMap((slot): Action[] => [
		{ type: "deliver", slot },
		{ type: "discard", slot },
	]);
	return [...plots, ...facilities, ...pens, ...slots];
}

// The sim's public interface (ADR-0003, "The interface"). Exports land here as the tickets under
// #72 build them; each new export meets CONSTRAINTS.md's "Interface change" row.
export { sliceContent } from "./content/index.js";
export type {
	Content,
	Crop,
	Facility,
	GoodCount,
	LevelRow,
	OrderGood,
	Pen,
	Recipe,
} from "./content/index.js";
export type { FacilityAction, Job, OwnedFacility } from "./facilities/index.js";
export { stateHash } from "./hash/index.js";
export type { Order, OrderSlot } from "./orders/index.js";
export { createSim } from "./sim/index.js";
export type { Sim } from "./sim/index.js";
export type { Animal, OwnedPen, PenAction } from "./pens/index.js";
export type { Plot, PlotAction } from "./plots/index.js";
export type { Action, ApplyResult, FarmState } from "./state/index.js";

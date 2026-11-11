// The sim's public interface (ADR-0003, "The interface"). Exports land here as the tickets under
// #72 build them; each new export meets CONSTRAINTS.md's "Interface change" row.
export { sliceContent } from "./content/index.js";
export type { Content, Crop } from "./content/index.js";
export { stateHash } from "./hash/index.js";
export { createSim } from "./sim/index.js";
export type { Sim } from "./sim/index.js";
export type { Action, ApplyResult, FarmState, Plot } from "./state/index.js";

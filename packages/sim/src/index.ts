// The sim's public interface (ADR-0003, "The interface"). Exports land here as the tickets under
// #72 build them; each new export meets CONSTRAINTS.md's "Interface change" row.
export { mulberry32, streamSeed, type Draw, type StreamPurpose } from './random.js';
export { stateHash } from './state-hash.js';

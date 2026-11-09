// Seeded randomness (ADR-0003, section 7, D9): one mulberry32 stream per purpose, so a new draw in
// one rule doesn't shift the draws in another. A stream's state is one unsigned 32-bit integer
// that lives in the farm state; 32-bit maths here is by design, not on a time (section 10).
import { stateHash } from '../hash/index.js';

/** The purposes that draw random numbers, each from its own stream. */
export type StreamPurpose = 'yields' | 'orders';

/** One draw: a uniform unsigned 32-bit `value`, and the stream's `next` state. */
export interface Draw {
  readonly next: number;
  readonly value: number;
}

/**
 * The first state of a farm's stream for `purpose`: the first 8 hex digits of
 * `stateHash(farmId + ":" + purpose)`, read as a big-endian unsigned 32-bit integer. The same
 * on every server, so a new farm is too (MUST-10.3).
 */
export function streamSeed(farmId: string, purpose: StreamPurpose): number {
  return Number.parseInt(stateHash(`${farmId}:${purpose}`).slice(0, 8), 16);
}

/** One mulberry32 step from `state`, an unsigned 32-bit integer. */
export function mulberry32(state: number): Draw {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { next, value: (t ^ (t >>> 14)) >>> 0 };
}

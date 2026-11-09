import { describe, expect, test } from 'vitest';
import { mulberry32, streamSeed } from './index.js';

/** The values of `count` draws from a stream that starts at `state`. */
const draws = (state: number, count: number): number[] => {
  const values: number[] = [];
  let current = state;
  for (let i = 0; i < count; i++) {
    const draw = mulberry32(current);
    values.push(draw.value);
    current = draw.next;
  }
  return values;
};

describe('streamSeed', () => {
  // node:crypto over the JSON-encoded string, first 8 hex digits read big-endian (D9).
  test.each([
    ['farm-1', 'yields', 0x4e9eae85],
    ['farm-1', 'orders', 0xe8550433],
    ['ø"\\🐄', 'yields', 0xd4e406b1],
  ] as const)('seeds %s:%s from its state hash', (farmId, purpose, seed) => {
    expect(streamSeed(farmId, purpose)).toBe(seed);
  });

  test('gives each purpose its own stream', () => {
    expect(streamSeed('farm-1', 'yields')).not.toBe(streamSeed('farm-1', 'orders'));
  });
});

describe('mulberry32', () => {
  // The reference implementation (bryc, github.com/bryc/code, jshash/PRNGs.md), scaled to uint32.
  test.each([
    [0, [1144304738, 1416247, 958946056]],
    [1, [2693262067, 11749833, 2265367787]],
    [0xdeadbeef, [4043151706, 1147597007, 3315858022]],
    [0xffffffff, [3850105811, 813802916, 3073704848]],
    [0x4e9eae85, [2163667215, 3635186879, 2185879706]],
  ])('matches the reference implementation from state %i', (state, values) => {
    expect(draws(state, 3)).toEqual(values);
  });

  test('steps the state by 0x6d2b79f5, wrapping at 2^32', () => {
    expect(mulberry32(0).next).toBe(0x6d2b79f5);
    expect(mulberry32(0xffffffff).next).toBe(0x6d2b79f4);
  });

  test('is a pure function of the state', () => {
    expect(mulberry32(0xdeadbeef)).toEqual(mulberry32(0xdeadbeef));
  });
});

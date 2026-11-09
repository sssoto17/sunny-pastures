import fc from 'fast-check';
import { describe, expect, inject, test } from 'vitest';
import { assertSafeIntegers } from '../index.js';

const params = inject('fastCheck');

/** Plain JSON trees whose numbers are all safe integers. */
const safeTree = fc.anything({
  values: [fc.maxSafeInteger(), fc.boolean(), fc.string({ unit: 'binary' }), fc.constant(null)],
});

/** Numbers that are not safe integers. */
const unsafeNumber = fc.oneof(
  fc.constantFrom(NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 0.5, -0),
  fc.double({ noNaN: true }).filter((n) => !Number.isSafeInteger(n)),
);

describe('assertSafeIntegers', () => {
  test('accepts a state whose numbers are all safe integers', () => {
    const state = { time: 2 ** 31 + 5, coins: 0, rng: 0, plots: [{ grownAt: Number.MAX_SAFE_INTEGER }] };
    expect(() => {
      assertSafeIntegers(state);
    }).not.toThrow();
  });

  test.each([
    ['a fraction', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['2^53', 2 ** 53],
    ['-(2^53)', -(2 ** 53)],
    ['-0, which a JSON round trip turns into 0', -0],
  ])('throws on %s, naming where it is', (_name, bad) => {
    expect(() => {
      assertSafeIntegers({ plots: [{ ok: 1 }, { grownAt: bad }] });
    }).toThrow('$.plots[1].grownAt');
  });

  test('property: accepts any tree of safe integers, strings, booleans and null', () => {
    fc.assert(
      fc.property(safeTree, (tree) => {
        assertSafeIntegers(tree);
      }),
      params,
    );
  });

  test('property: throws when one number anywhere is not a safe integer', () => {
    fc.assert(
      fc.property(fc.array(safeTree), fc.nat(), unsafeNumber, (trees, index, bad) => {
        const state = [...trees];
        state.splice(index % (trees.length + 1), 0, { deep: [bad] });
        expect(() => {
          assertSafeIntegers({ state });
        }).toThrow(/not a safe integer/);
      }),
      params,
    );
  });
});

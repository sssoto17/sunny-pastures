import fc from 'fast-check';
import { describe, expect, inject, test } from 'vitest';
import { stateHash } from '../../index.js';
import { mulberry32 } from '../../random/index.js';

const params = inject('fastCheck');

/** JSON values with keys and strings over all of Unicode, astral characters included. */
const jsonValue = fc.jsonValue({ stringUnit: 'binary' });

/** A copy of `value` with the keys of every object in a shuffled insertion order. */
const shuffleKeys = (value: unknown, seed: number): unknown => {
  let state = seed;
  const draw = (): number => {
    const step = mulberry32(state);
    state = step.next;
    return step.value;
  };
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (typeof v !== 'object' || v === null) return v;
    const keyed = Object.entries(v).map((entry) => ({ entry, order: draw() }));
    keyed.sort((p, q) => p.order - q.order);
    return Object.fromEntries(keyed.map(({ entry: [key, inner] }) => [key, visit(inner)]));
  };
  return visit(value);
};

// Recorded once from node:crypto over the JSON text named in each row (#81, ADR-0003 section 6).
describe('stateHash', () => {
  test.each([
    [55, 'The quick brown fox jumps over the lazy dog, 01234567', '39a8f757b6bbd516dabde29509b4aae7e6dbf21328f805d7ff33ff6dc247ec40'],
    [56, 'The quick brown fox jumps over the lazy dog, 012345678', '2b65f2f0a76bc9398211a7fd58fd630bb0b23b954beeadf6c2fbd91691caa6b3'],
    [63, 'The quick brown fox jumps over the lazy dog, 0123456789 abcde', '6efe14722ece4b32b6ca867b19030abdbaedb124d82b1fdf62b017535a824c07'],
    [64, 'The quick brown fox jumps over the lazy dog, 0123456789 abcdef', '5a1fe963c2f3f61ad6ea58cb8ecfae669ce9a17668c138d25a200e8e8784fce0'],
    [65, 'The quick brown fox jumps over the lazy dog, 0123456789 abcdefg', '2be4258922d33eabc556cd57f3a00e2573132fc640661302261b0e348f18af84'],
  ])('matches node:crypto at the block boundary: %i bytes of ASCII', (bytes, value, digest) => {
    expect(JSON.stringify(value).length).toBe(bytes); // ASCII: one byte per character, quotes included
    expect(stateHash(value)).toBe(digest);
  });

  // "é€😀" is 2 + 3 + 4 bytes of UTF-8; the 😀 is a surrogate pair in UTF-16.
  test.each([
    [55, 44, '15b4664614523c0a4199a786df797d824b4ff7ef1957f2ce80e774e5803a645f'],
    [56, 45, '57d05e1f7743974b2f255b15b879d6a171663feb7f786578bade4efabecf426c'],
    [63, 52, '2c3be05a1e52d0485fb2378b8ca42d30e848af0070b2e72bf143a0ca747e08f6'],
    [64, 53, '1f46e59ab8a192e8053ad5567d1800ae4bd20caeedf23cafec7a9e88f3f50506'],
    [65, 54, '0cef70371e679fc896ed9ad93317fd7da879e37bd13416351c2ca9db8179b3ac'],
  ])('matches node:crypto at the block boundary: %i bytes with 2-, 3- and 4-byte characters', (bytes, xs, digest) => {
    expect(2 + 3 + 4 + xs + 2).toBe(bytes); // "é€😀", the x's, and the two quotes
    expect(stateHash(`é€😀${'x'.repeat(xs)}`)).toBe(digest);
  });

  test('hashes the canonical JSON of an object', () => {
    // node:crypto over '{"a":true,"b":[1,{"c":null,"d":"é"}],"z":-5}'.
    const digest = '41855bf4938101cf544146f3bc2dc4055f2bcc356d7a27039bdd395389b5bb39';
    expect(stateHash({ z: -5, b: [1, { d: 'é', c: null }], a: true })).toBe(digest);
    expect(stateHash({ a: true, z: -5, b: [1, { c: null, d: 'é' }] })).toBe(digest);
  });

  test('keeps a time beyond 2^31 ms (about 24.9 days) unchanged', () => {
    // node:crypto over '{"time":2147483653}'; a 32-bit truncation would give 5 or -2147483643.
    expect(stateHash({ time: 2 ** 31 + 5 })).toBe('a476a6ef2022dc2b53c98d4166e2d8ca03b7465a7718a76cc1f9bb70a20b947e');
  });

  test('hashes -0 as 0', () => {
    // node:crypto over '0'.
    expect(stateHash(-0)).toBe('5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9');
  });

  test('throws on a non-finite number', () => {
    expect(() => stateHash({ coins: NaN })).toThrow(/finite/);
  });

  test('property: key order does not change the hash', () => {
    fc.assert(
      fc.property(jsonValue, fc.nat(), (value, seed) => {
        expect(stateHash(shuffleKeys(value, seed))).toBe(stateHash(value));
      }),
      params,
    );
  });

  test('property: a JSON round trip does not change the hash', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(stateHash(JSON.parse(JSON.stringify(value)))).toBe(stateHash(value));
      }),
      params,
    );
  });

  test('property: is 64 lowercase hex digits', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(stateHash(value)).toMatch(/^[0-9a-f]{64}$/);
      }),
      params,
    );
  });
});

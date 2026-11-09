import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../sha256.js';

// FIPS 180-2 examples (NIST), checked against node:crypto when recorded (#81).
describe('sha256Hex', () => {
  test.each([
    ['the empty message', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'the 448-bit message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'the 896-bit message',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
    ['one million "a"', 'a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ])('matches the NIST vector for %s', (_name, message, digest) => {
    expect(sha256Hex(message)).toBe(digest);
  });

  test('throws on a lone surrogate, which has no UTF-8 encoding', () => {
    expect(() => sha256Hex('a\uD83D')).toThrow(/surrogate/);
    expect(() => sha256Hex('\uDE00a')).toThrow(/surrogate/);
    expect(() => sha256Hex('\uD83Da')).toThrow(/surrogate/);
  });
});

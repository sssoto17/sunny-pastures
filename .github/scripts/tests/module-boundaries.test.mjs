// The module privacy rules in eslint.config.mjs (ADR-0005, sections 1 and 4), linted against
// snippets placed at real-looking paths. In the sim they share no-restricted-imports with the
// purity ban, and a later block's options replace an earlier block's, so each sim case also
// checks that the purity ban still fires (#125).
import { describe, expect, it } from 'vitest';
import { lintSnippet } from './lint-snippet.mjs';

const RULES = new Set(['no-restricted-imports']);

/** The lines of `cases` that no-restricted-imports reports for a file at `filePath`, each once. */
const reported = async (cases, filePath) => {
  const code = cases.map(([line]) => line).join('\n');
  const lines = (await lintSnippet(code, filePath, RULES)).map((finding) => Number(finding.split(' ')[0]));
  return [...new Set(lines)];
};

/** The 1-based line numbers of the cases marked banned. */
const banned = (cases) => cases.flatMap(([, verdict], i) => (verdict === 'banned' ? [i + 1] : []));

// Imports from a module's source file, `src/plots/index.ts`.
const SOURCE = [
  ["import { a } from '../hash/index.js';", 'ok'],
  ["import { b } from '../hash/sha256.js';", 'banned'], // past another module's entry
  ["import { c } from '../facilities/addOns/index.js';", 'banned'], // into another module's child
  ["import { d } from './helpers.js';", 'ok'], // a private sibling
  ["import { e } from './addOns/index.js';", 'ok'], // its own child, through the entry
  ["import { f } from './addOns/inner.js';", 'banned'], // past its child's entry
  ["import { g } from '../state/tests/farms.js';", 'banned'], // source into tests/
  ["import { h } from './tests/helpers.js';", 'banned'], // source into its own tests/
  ["import { i } from './a/../../hash/sha256.js';", 'banned'], // a path that walks around
  ["import { j } from '../hash//sha256.js';", 'banned'],
  ["export { k } from '../hash/sha256.js';", 'banned'], // a re-export reaches in too
  ["import type { L } from '../hash/sha256.js';", 'banned'], // and a type import
  ["import { m } from '../index.js';", 'ok'], // the package entry
];

// Imports from a module's test file, `src/plots/tests/index.test.ts`.
const TEST = [
  ["import { a } from '../index.js';", 'ok'], // its own module
  ["import { b } from '../helpers.js';", 'ok'], // its own module's private sibling
  ["import { c } from '../../hash/index.js';", 'ok'],
  ["import { d } from '../../hash/sha256.js';", 'banned'],
  ["import { e } from '../../state/tests/farms.js';", 'ok'], // another module's test helpers
  ["import { f } from '../../facilities/addOns/tests/x.js';", 'banned'], // a child's, from outside
  ["import { g } from '../../index.js';", 'ok'], // the package entry, as the harness does
  ["import { h } from './farms.js';", 'ok'],
  ["import { i } from '../../state/tests/../index.js';", 'banned'],
];

// The purity ban, which outside packages/sim doesn't apply.
const PURITY = [
  ["import { readFileSync } from 'node:fs';", 'banned'],
  ["import { thing } from 'some-package';", 'banned'],
];
const TEST_TOOLS = [
  ["import { it } from 'vitest';", 'ok'],
  ["import fc from 'fast-check';", 'ok'],
];
const outsideSim = (cases) => cases.map(([line]) => [line, 'ok']);

describe('module privacy', () => {
  it('lets source reach other modules only through their index.js, and never a tests/ folder', async () => {
    expect(await reported(SOURCE, 'packages/other/src/plots/index.ts')).toEqual(banned(SOURCE));
  });

  it("lets tests reach other modules through their index.js or their tests/ folder", async () => {
    expect(await reported(TEST, 'packages/other/src/plots/tests/index.test.ts')).toEqual(banned(TEST));
  });

  it('treats every file in a tests/ folder as test code, helpers included', async () => {
    expect(await reported(TEST, 'packages/other/src/plots/tests/generators.ts')).toEqual(banned(TEST));
  });

  it('leaves package imports alone outside packages/sim', async () => {
    const cases = outsideSim([...PURITY, ...TEST_TOOLS]);
    expect(await reported(cases, 'packages/other/src/plots/index.ts')).toEqual([]);
  });
});

describe('module privacy in packages/sim, merged with the purity ban', () => {
  it('applies both to sim source', async () => {
    const cases = [...PURITY, ...TEST_TOOLS.map(([line]) => [line, 'banned']), ...SOURCE];
    expect(await reported(cases, 'packages/sim/src/plots/index.ts')).toEqual(banned(cases));
  });

  it.each(['packages/sim/src/plots/tests/index.test.ts', 'packages/sim/src/state/tests/farms.ts'])(
    'applies both to sim test code, which may also import vitest and fast-check: %s',
    async (filePath) => {
      const cases = [...PURITY, ...TEST_TOOLS, ...TEST];
      expect(await reported(cases, filePath)).toEqual(banned(cases));
    },
  );
});

describe('file and folder names (ADR-0005, section 5)', () => {
  const NAMES = new Set(['check-file/filename-naming-convention', 'check-file/filename-blocklist', 'check-file/folder-naming-convention']);
  const named = async (filePath) => (await lintSnippet('export const a = 1;\n', filePath, NAMES)).length;

  it.each([
    'packages/sim/src/hash/index.ts',
    'packages/sim/src/hash/canonicalJson.ts',
    'packages/sim/src/facilities/addOns/index.ts',
    'packages/sim/src/hash/tests/canonicalJson.test.ts',
  ])('accept %s', async (filePath) => {
    expect(await named(filePath)).toBe(0);
  });

  it.each([
    'packages/sim/src/hash/canonical-json.ts',
    'packages/sim/src/hash/CanonicalJson.ts',
    'packages/sim/src/add-ons/index.ts',
    'packages/sim/src/hash/tests/sha256.spec.ts',
    'packages/sim/src/hash/hash.types.ts',
  ])('reject %s', async (filePath) => {
    expect(await named(filePath)).toBeGreaterThan(0);
  });
});

describe('lintSnippet', () => {
  it('throws on a snippet ESLint cannot parse, rather than report no findings', async () => {
    await expect(lintSnippet('import {', 'packages/sim/src/plots/index.ts', RULES)).rejects.toThrow('could not lint');
  });
});

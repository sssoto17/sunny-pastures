// The sim purity rules in eslint.config.mjs (#81, MUST-10.1): each banned construct is reported
// in a file inside packages/sim and none of the rules fire outside it. It lives here because the
// root Vitest include already runs .github/scripts tests, and it can't sit inside packages/sim:
// it imports eslint and node:*.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });
const PURITY_RULES = new Set(['no-restricted-imports', 'no-restricted-properties', 'no-restricted-syntax']);

/** The purity findings for `code` linted as if it were the file at `filePath`, as "line rule". */
const purityFindings = async (code, filePath) => {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => PURITY_RULES.has(m.ruleId)).map((m) => `${m.line} ${m.ruleId}`);
};

// One banned construct per line, so each finding names its line.
const BANNED = [
  "import { readFileSync } from 'node:fs';",
  "import { thing } from 'some-package';",
  "export { other } from '@scope/pkg';",
  'export const a = Date.now();',
  'export const b = Math.random();',
  'export const c = new Date();',
  'export const d = new Date;',
  'export const e = Date();',
  "export const f = import('./lazy.js');",
].join('\n');

const BANNED_FINDINGS = [
  '1 no-restricted-imports',
  '2 no-restricted-imports',
  '3 no-restricted-imports',
  '4 no-restricted-properties',
  '5 no-restricted-properties',
  '6 no-restricted-syntax',
  '7 no-restricted-syntax',
  '8 no-restricted-syntax',
  '9 no-restricted-syntax',
];

// D16: 32-bit operators truncate times above 2^31 ms. Lint sees a time by its name only.
const TIME_BITWISE = [
  'export const g = (s) => s.time | 0;',
  'export const h = (at) => at >>> 0;',
  'export const i = (startTime) => startTime << 1;',
  'export const j = (s) => s.readyAt & 0xff;',
  'export const k = (to) => ~to;',
  'export const l = (x, s) => { x |= s.time; return x; };',
  'export const m = (to) => 7 ^ to;',
].join('\n');

const TIME_BITWISE_FINDINGS = [1, 2, 3, 4, 5, 6, 7].map((line) => `${line} no-restricted-syntax`);

// Code the sim needs and the rules must leave alone: relative imports, a date from a value, and
// mulberry32's 32-bit maths on a stream state (ADR-0003, sections 7 and 10).
const ALLOWED = [
  "import { stateHash } from './hash.js';",
  "import { other } from '../other.js';",
  'export const n = new Date(0);',
  'export const o = (state) => (state + 0x6d2b79f5) >>> 0;',
  'export const p = (t) => Math.imul(t ^ (t >>> 15), t | 1);',
  'export const q = (s) => s.time + 1;',
  'export const r = (atlas, timer) => atlas | timer;',
].join('\n');

describe('sim purity rules', () => {
  test('report every banned construct in a packages/sim source file', async () => {
    expect(await purityFindings(BANNED, 'packages/sim/src/snippet.ts')).toEqual(BANNED_FINDINGS);
  });

  test('report 32-bit operators on time values in packages/sim', async () => {
    expect(await purityFindings(TIME_BITWISE, 'packages/sim/src/snippet.ts')).toEqual(TIME_BITWISE_FINDINGS);
  });

  test('leave relative imports, dates from a value and stream maths alone', async () => {
    expect(await purityFindings(ALLOWED, 'packages/sim/src/snippet.ts')).toEqual([]);
  });

  test('do not fire outside packages/sim', async () => {
    expect(await purityFindings(`${BANNED}\n${TIME_BITWISE}`, 'scripts/snippet.ts')).toEqual([]);
    expect(await purityFindings(`${BANNED}\n${TIME_BITWISE}`, 'packages/other/src/snippet.ts')).toEqual([]);
  });

  test('let sim tests import vitest and fast-check, and nothing else', async () => {
    const code = [
      "import { test } from 'vitest';",
      "import fc from 'fast-check';",
      "import { stateHash } from './hash.js';",
      "import { readFileSync } from 'node:fs';",
      "import { thing } from 'some-package';",
      "import { x } from 'vitest/node';",
      'export const a = Date.now();',
      'export const b = Math.random();',
      'export const c = new Date();',
    ].join('\n');
    expect(await purityFindings(code, 'packages/sim/src/hash.test.ts')).toEqual([
      '4 no-restricted-imports',
      '5 no-restricted-imports',
      '6 no-restricted-imports',
      '7 no-restricted-properties',
      '8 no-restricted-properties',
      '9 no-restricted-syntax',
    ]);
  });

  test('make sim property tests pass the shared fast-check settings (D10)', async () => {
    const code = [
      "import fc from 'fast-check';",
      "import { inject } from 'vitest';",
      "const params = inject('fastCheck');",
      'const p = fc.property(fc.nat(), () => true);',
      'fc.assert(p);',
      'fc.check(p);',
      'fc.assert(p, params);',
      "fc.check(p, inject('fastCheck'));",
      'export const a = Date.now();',
      'export const b = new Date();',
    ].join('\n');
    expect(await purityFindings(code, 'packages/sim/src/hash.test.ts')).toEqual([
      '5 no-restricted-syntax',
      '6 no-restricted-syntax',
      '9 no-restricted-properties',
      '10 no-restricted-syntax',
    ]);
  });
});

// The other half of the guard: the sim's tsconfigs keep timers, fetch, crypto, performance and
// node:* types out by compiling against ES2022 only, with no ambient types (#81). The floor guard
// watches strict options, not `lib` or `types`, so adding "DOM" or "node" would otherwise pass.
describe('sim tsconfigs', () => {
  /** The compiler options after `extends` is resolved, as tsc sees them. */
  const resolvedOptions = (file) => {
    const host = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    };
    return ts.getParsedCommandLineOfConfigFile(join(root, file), {}, host).options;
  };

  test.each(['packages/sim/tsconfig.json', 'packages/sim/tsconfig.test.json'])(
    '%s compiles against ES2022 only, with no ambient types',
    (file) => {
      const options = resolvedOptions(file);
      expect(options.lib).toEqual(['lib.es2022.d.ts']);
      expect(options.types).toEqual([]);
      expect(options.noLib).toBeUndefined();
    },
  );
});

import { rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { enclosingKey, globToRegExp, parseDate } from './floor-guard.mjs';
import { makeRepo } from './test-repo.mjs';

const SCRIPT = fileURLToPath(new URL('./floor-guard.mjs', import.meta.url));
const TODAY = { FLOOR_GUARD_TODAY: '2026-11-10' };

const CONSTRAINTS = `# Constraints

## Floor

- Secrets in source: blocked.

| Dimension | Rule | Runs at | Required check |
|---|---|---|---|
| Coverage | Changed lines ≥ 90% covered | task end, CI | \`ci / test\` |
| Speed | \`advance()\` ≤ 50 ms | task end, CI | \`ci / bench\` |
| Mutation | Score ≥ 60% | CI | \`ci / mutation\` |

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
| _none_ | | | | | |
`;
const BASE = {
  'CONSTRAINTS.md': CONSTRAINTS,
  'packages/sim/src/a.ts': 'export const a = 1;\n',
  'packages/sim/src/a.test.ts': "it('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(2);\n});\n",
  'tsconfig.base.json': '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
  'vitest.config.mts': "export default {\n  test: {\n    coverage: {\n      exclude: [\n        '**/*.test.ts',\n      ],\n    },\n  },\n};\n",
};
const row = (id, path, expires) => `| ${id} | silenced checker | \`${path}\` | reason | Soto | ${expires} |`;
const withException = (r) => CONSTRAINTS.replace('| _none_ | | | | | |', r);

let repo;
afterEach(() => repo?.cleanup());
const setup = () => (repo = makeRepo(BASE));
const guard = (env = TODAY) => repo.run(SCRIPT, [], env);

describe('floor guard, end to end', () => {
  it('passes a clean change, committed or not', () => {
    setup();
    repo.write({ 'packages/sim/src/b.ts': 'export const b = 2;\n' });
    expect(guard()).toMatchObject({ code: 0 });
    repo.commit();
    expect(guard()).toMatchObject({ code: 0 });
  });

  it('exits 2, never 0, when there is no merge base', () => {
    setup();
    expect(repo.run(SCRIPT, ['--base', 'no-such-ref'], TODAY).code).toBe(2);
  });

  it('blocks a suppression in code and reports the location, never the text', () => {
    setup();
    repo.write({ 'packages/sim/src/a.ts': 'export const a = 1;\n// @ts-ignore hunter2-value\n' });
    const r = guard();
    expect(r.code).toBe(1);
    expect(r.out).toContain('[silenced-checker] packages/sim/src/a.ts:2');
    expect(r.out).not.toContain('hunter2');
  });

  it.each(['eslint-disable-next-line', 'v8 ignore next', '@ts-nocheck', 'fallow-ignore-file', '# noqa'])('blocks %s', (s) => {
    setup();
    repo.write({ 'packages/sim/src/c.ts': `// ${s}\n` });
    expect(guard().code).toBe(1);
  });

  it('ignores suppressions mentioned in prose', () => {
    setup();
    repo.write({ 'docs/x.md': 'Never add @ts-ignore or a TODO.\n' });
    expect(guard().code).toBe(0);
  });

  it('blocks a skipped or focused test', () => {
    setup();
    repo.write({ 'packages/sim/src/a.test.ts': "it.skip('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(2);\n});\n" });
    expect(guard().out).toContain('[test-made-easier]');
    repo.write({ 'packages/sim/src/a.test.ts': "it.only('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(2);\n});\n" });
    expect(guard().code).toBe(1);
  });

  it('blocks a deleted test file but not a moved one', () => {
    setup();
    rmSync(join(repo.dir, 'packages/sim/src/a.test.ts'));
    expect(guard().out).toContain('[test-deleted]');
    repo.write({ 'packages/sim/src/a.test.ts': BASE['packages/sim/src/a.test.ts'] });
    renameSync(join(repo.dir, 'packages/sim/src/a.test.ts'), join(repo.dir, 'packages/sim/src/renamed.test.ts'));
    expect(guard().code).toBe(0); // unstaged move
    repo.commit();
    expect(guard().code).toBe(0); // committed move, found by git's rename detection
  });

  it('blocks removed assertions, not edited ones', () => {
    setup();
    repo.write({ 'packages/sim/src/a.test.ts': "it('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(3);\n});\n" });
    expect(guard().code).toBe(0);
    repo.write({ 'packages/sim/src/a.test.ts': "it('a', () => {\n  expect(a).toBe(1);\n});\n" });
    expect(guard().out).toContain('[assertion-removed]');
  });

  it('blocks a cut property run count', () => {
    setup();
    repo.write({ 'packages/sim/src/p.test.ts': 'fc.assert(prop, { numRuns: 1000 });\n' });
    repo.commit();
    repo.git('switch', '-q', '-C', 'main');
    repo.git('switch', '-q', '-c', 'cut');
    repo.write({ 'packages/sim/src/p.test.ts': 'fc.assert(prop, { numRuns: 10 });\n' });
    expect(guard().out).toContain('[property-runs-cut]');
  });

  it.each([
    ['a TODO', '// TODO\n'],
    ['a not-implemented stub', "throw new Error('Not implemented');\n"],
    ['an empty catch', 'try { f(); } catch {}\n'],
    ['an empty multi-line catch', 'try {\n  f();\n} catch (e) {\n}\n'],
  ])('always blocks %s', (_, code) => {
    setup();
    repo.write({ 'packages/sim/src/s.ts': code, 'CONSTRAINTS.md': withException(row('E1', 'packages/sim/**', '2026-11-20')) });
    expect(guard().out).toContain('[unfinished-work]');
  });

  it.each([
    ['a lowered minimum', ['≥ 90%', '≥ 80%'], 'threshold-loosened'],
    ['a raised maximum', ['≤ 50 ms', '≤ 80 ms'], 'threshold-loosened'],
    ['a removed rule', ['| Mutation | Score ≥ 60% | CI | `ci / mutation` |\n', ''], 'rule-removed'],
    ['a dropped severity', ['Score ≥ 60% |', 'Score ≥ 60% _(warn)_ |'], 'severity-dropped'],
    ['a check moved to a later stage', ['≤ 50 ms | task end, CI', '≤ 50 ms | CI'], 'stage-moved'],
  ])('blocks %s in CONSTRAINTS.md', (_, [from, to], rule) => {
    setup();
    repo.write({ 'CONSTRAINTS.md': CONSTRAINTS.replace(from, to) });
    const r = guard();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`[${rule}] CONSTRAINTS.md`);
  });

  it('stays silent when CONSTRAINTS.md is tightened', () => {
    setup();
    repo.write({ 'CONSTRAINTS.md': CONSTRAINTS.replace('≥ 90%', '≥ 95%').replace('≤ 50 ms', '≤ 40 ms') });
    expect(guard().code).toBe(0);
  });

  it.each([
    ['a strict option turned off', 'tsconfig.base.json', '{\n  "compilerOptions": {\n    "strict": false\n  }\n}\n'],
    ['a strict option removed', 'tsconfig.base.json', '{\n  "compilerOptions": {\n  }\n}\n'],
    ['a coverage exclusion added', 'vitest.config.mts', BASE['vitest.config.mts'].replace("'**/*.test.ts',", "'**/*.test.ts',\n        'packages/sim/src/**',")],
    ['a lint rule turned off', 'eslint.config.mjs', "export default [{ rules: {\n  'no-unused-vars': 'off',\n} }];\n"],
    ['a gitleaks ignore entry', '.gitleaksignore', 'abc123:src/x.ts:generic-api-key:1\n'],
    ['a Fallow ignore', '.fallow.toml', 'ignorePatterns = ["packages/sim/**"]\n'],
  ])('blocks %s', (_, path, content) => {
    setup();
    repo.write({ [path]: content });
    expect(guard().out).toContain('[config-loosened]');
  });

  it('accepts exclusions in a config that did not exist at the merge base, and tighter lint settings', () => {
    setup();
    repo.write({
      'packages/web/vitest.config.mts': "export default { test: { exclude: [\n  'e2e/**',\n] } };\n",
      'eslint.config.mjs': "export default [{ linterOptions: {\n  maxWarnings: 0,\n}, rules: {\n  'no-console': 'error',\n} }];\n",
    });
    expect(guard().code).toBe(0);
  });

  it('waives a weakened bar when the same change adds an Exceptions row for its path', () => {
    setup();
    repo.write({
      'packages/sim/src/a.ts': '// @ts-expect-error legacy\n',
      'CONSTRAINTS.md': withException(row('E1', 'packages/sim/src/a.ts', '2026-11-30')),
    });
    const r = guard();
    expect(r.code).toBe(0);
    expect(r.out).toContain('waived by E1');
  });

  it('does not waive a finding outside the row\'s path', () => {
    setup();
    repo.write({
      'packages/sim/src/a.ts': '// @ts-expect-error legacy\n',
      'CONSTRAINTS.md': withException(row('E1', 'apps/web/**', '2026-11-30')),
    });
    expect(guard().code).toBe(1);
  });

  it('blocks an exception that runs too long or past the freeze, or has no date', () => {
    setup();
    repo.write({ 'CONSTRAINTS.md': withException(row('E1', 'x', '2026-12-15')) });
    expect(guard().out).toContain('[exception-too-long]'); // more than 30 days after 10 Nov
    repo.write({ 'CONSTRAINTS.md': withException(row('E1', 'x', '2026-12-21')) });
    expect(guard({ FLOOR_GUARD_TODAY: '2026-12-01' }).out).toContain('[exception-too-long]');
    repo.write({ 'CONSTRAINTS.md': withException(row('E1', 'x', 'soon')) });
    expect(guard().out).toContain('[exception-invalid]');
  });

  it('fails every change once an Exceptions row has expired', () => {
    repo = makeRepo({ ...BASE, 'CONSTRAINTS.md': withException(row('E1', 'x', '20 Nov 2026')) });
    expect(guard().code).toBe(0);
    const r = guard({ FLOOR_GUARD_TODAY: '2026-11-21' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('[exception-expired] CONSTRAINTS.md');
  });
});

describe('floor guard helpers', () => {
  it('finds the array a line sits in', () => {
    const lines = ['x: {', '  exclude: [', "    'a',", '    [1, 2],', "    'b',", '  ],', "  include: ['c'],", '}'];
    expect(enclosingKey(lines, 3)).toBe('exclude');
    expect(enclosingKey(lines, 5)).toBe('exclude');
    expect(enclosingKey(lines, 7)).toBe('include');
    expect(enclosingKey(lines, 8)).toBe(null);
  });

  it('matches exception paths as globs', () => {
    expect(globToRegExp('packages/sim/**').test('packages/sim/src/a.ts')).toBe(true);
    expect(globToRegExp('packages/*/src/a.ts').test('packages/sim/src/a.ts')).toBe(true);
    expect(globToRegExp('packages/*/a.ts').test('packages/sim/src/a.ts')).toBe(false);
    expect(globToRegExp('packages/sim/').test('packages/sim/src/a.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('b/a.ts')).toBe(false);
  });

  it('reads ISO and written dates', () => {
    expect(parseDate('2026-12-20')).toBe(Date.UTC(2026, 11, 20));
    expect(parseDate('20 Dec 2026')).toBe(Date.UTC(2026, 11, 20));
    expect(parseDate('next week')).toBe(null);
  });
});

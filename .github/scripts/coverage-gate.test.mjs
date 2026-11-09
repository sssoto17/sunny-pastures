import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluate, parseLcov, recordedProjectCoverage } from './coverage-gate.mjs';
import { makeRepo } from './test-repo.mjs';

const SCRIPT = fileURLToPath(new URL('./coverage-gate.mjs', import.meta.url));
const ratchets = (today) => `| Metric | Today |\n|---|---|\n| Project coverage | ${today} |\n`;

// A changed file whose lines 1..n were added, and an lcov entry with `covered` of them hit.
const change = (path, n) => ({ path, status: 'added', added: Array.from({ length: n }, (_, i) => ({ line: i + 1, text: '' })) });
const lcovOf = (entries) => new Map(entries.map(([path, n, covered]) => [path, new Map(Array.from({ length: n }, (_, i) => [i + 1, i < covered ? 1 : 0]))]));

describe('coverage gate', () => {
  it('needs 90% of changed lines in packages/sim', () => {
    const changes = [change('packages/sim/src/a.ts', 10)];
    expect(evaluate({ changes, lcov: lcovOf([['packages/sim/src/a.ts', 10, 9]]), recorded: null }).failures).toEqual([]);
    expect(evaluate({ changes, lcov: lcovOf([['packages/sim/src/a.ts', 10, 8]]), recorded: null }).failures).toHaveLength(1);
  });

  it('needs 80% of changed lines in the rest of apps/ and packages/', () => {
    const changes = [change('apps/web/src/a.ts', 10)];
    expect(evaluate({ changes, lcov: lcovOf([['apps/web/src/a.ts', 10, 8]]), recorded: null }).failures).toEqual([]);
    expect(evaluate({ changes, lcov: lcovOf([['apps/web/src/a.ts', 10, 7]]), recorded: null }).failures).toHaveLength(1);
  });

  it('counts only executable lines and files in the lcov', () => {
    const changes = [change('packages/sim/src/a.ts', 10), change('packages/sim/src/a.test.ts', 50), change('docs/x.md', 5)];
    const lcov = new Map([['packages/sim/src/a.ts', new Map([[3, 1], [4, 1]])]]);
    expect(evaluate({ changes, lcov, recorded: null }).failures).toEqual([]);
  });

  it('passes a change with no executable changed lines', () => {
    const r = evaluate({ changes: [change('README.md', 3)], lcov: new Map(), recorded: null });
    expect(r.failures).toEqual([]);
    expect(r.report).toContain('packages/sim: no executable changed lines');
  });

  it('fails when project coverage falls more than 0.5 points below the recorded value', () => {
    const lcov = lcovOf([['packages/sim/src/a.ts', 1000, 795]]);
    expect(evaluate({ changes: [], lcov, recorded: 80 }).failures).toEqual([]);
    expect(evaluate({ changes: [], lcov, recorded: 80.1 }).failures).toHaveLength(1);
  });

  it('reads the recorded ratchet value, or null while it says "not yet"', () => {
    expect(recordedProjectCoverage(ratchets('not yet: recorded after the first `packages/sim` PR'))).toBe(null);
    expect(recordedProjectCoverage(ratchets('92.5%'))).toBe(92.5);
    expect(() => recordedProjectCoverage('no table')).toThrow();
  });

  // #99: only "not yet" means no ratchet; anything else it can't read can't run.
  it.each(['about 92%', 'TBD', '', '92.5', 'n/a', 'not yet 90%', 'not yet, ratchet at 92%', 'not yet-92%'])('cannot run on a Today cell it cannot read: %j', (today) => {
    expect(() => recordedProjectCoverage(ratchets(today))).toThrow(/Project coverage/);
  });

  it('reads lcov with absolute or relative paths', () => {
    const lcov = parseLcov('SF:/repo/packages/sim/src/a.ts\nDA:1,3\nDA:2,0\nend_of_record\nSF:apps/web/src/b.ts\nDA:5,1\nend_of_record\n', '/repo');
    expect([...lcov.keys()]).toEqual(['packages/sim/src/a.ts', 'apps/web/src/b.ts']);
    expect(lcov.get('packages/sim/src/a.ts')).toEqual(new Map([[1, 3], [2, 0]]));
  });
});

describe('coverage gate, end to end', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  it('passes without an lcov when no source changed, and cannot run when one did', () => {
    repo = makeRepo({ 'CONSTRAINTS.md': ratchets('not yet') });
    repo.write({ 'docs/x.md': 'text\n' });
    expect(repo.run(SCRIPT).code).toBe(0);
    repo.write({ 'packages/sim/src/a.ts': 'export const a = 1;\n' });
    expect(repo.run(SCRIPT).code).toBe(2);
  });

  it('reads the real "not yet" cell as no ratchet, end to end', () => {
    repo = makeRepo({ 'CONSTRAINTS.md': ratchets('not yet: recorded after the first `packages/sim` PR') });
    repo.write({ 'coverage/lcov.info': 'SF:packages/sim/src/a.ts\nDA:1,1\nend_of_record\n' });
    const r = repo.run(SCRIPT);
    expect(r.code).toBe(0);
    expect(r.out).toContain('project coverage ratchet: no value recorded yet');
  });

  it('exits 2 when the Today cell is unreadable', () => {
    repo = makeRepo({ 'CONSTRAINTS.md': ratchets('TBD') });
    repo.write({ 'coverage/lcov.info': 'SF:packages/sim/src/a.ts\nDA:1,1\nend_of_record\n' });
    expect(repo.run(SCRIPT).code).toBe(2);
  });

  // #99: `check:task` runs only the related tests, so the lcov counts every untested file at 0%
  // and the project figure reads low. It skips the ratchet; CI's full run checks it.
  it('skips the project ratchet with --skip-ratchet, and says so', () => {
    repo = makeRepo({ 'CONSTRAINTS.md': ratchets('95%') });
    repo.write({ 'coverage/lcov.info': 'SF:packages/sim/src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n' });
    expect(repo.run(SCRIPT).code).toBe(1);
    const r = repo.run(SCRIPT, ['--skip-ratchet']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('project coverage ratchet: skipped (--skip-ratchet');
  });

  it('intersects the lcov with the changed lines', () => {
    repo = makeRepo({ 'CONSTRAINTS.md': ratchets('not yet'), 'packages/sim/src/a.ts': 'export const a = 1;\n' });
    repo.write({ 'packages/sim/src/a.ts': 'export const a = 1;\nexport const b = 2;\n' });
    repo.write({ 'coverage/lcov.info': 'SF:packages/sim/src/a.ts\nDA:1,0\nDA:2,1\nend_of_record\n' });
    expect(repo.run(SCRIPT).code).toBe(0); // line 1 is unchanged, so its 0 hits don't count
    repo.write({ 'coverage/lcov.info': 'SF:packages/sim/src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n' });
    const r = repo.run(SCRIPT);
    expect(r.code).toBe(1);
    expect(r.out).toContain('packages/sim changed-line coverage 0.0% < 90%');
  });
});

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, renameSync } from 'node:fs';
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

## Exceptions

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

  // This file is scanned for skipped tests too, so the modifiers are assembled, never written out.
  const modified = (m) => `it.${m}('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(2);\n});\n`;

  it.each(['skip', 'only', 'todo'])('blocks a test marked %s', (m) => {
    setup();
    repo.write({ 'packages/sim/src/a.test.ts': modified(m) });
    expect(guard().out).toContain('[test-made-easier]');
  });

  describe("the guard's own files", () => {
    const SELF_TEST = '.github/scripts/floor-guard.test.mjs';
    const selfSetup = () => (repo = makeRepo({ ...BASE, [SELF_TEST]: "it('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n" }));

    it('are checked for skipped tests', () => {
      selfSetup();
      repo.write({ [SELF_TEST]: modified('skip') });
      expect(guard().out).toContain(`[test-made-easier] ${SELF_TEST}`);
    });

    it('are checked for removed assertions and deletion', () => {
      selfSetup();
      repo.write({ [SELF_TEST]: "it('a', () => {\n  expect(1).toBe(1);\n});\n" });
      expect(guard().out).toContain(`[assertion-removed] ${SELF_TEST}`);
      rmSync(join(repo.dir, SELF_TEST));
      expect(guard().out).toContain(`[test-deleted] ${SELF_TEST}`);
    });

    it('may still spell out suppression and stub patterns', () => {
      selfSetup();
      repo.write({ '.github/scripts/floor-guard.mjs': '// @ts-ignore, TODO and an empty catch {} are patterns here\n' });
      expect(guard().code).toBe(0);
    });
  });

  describe('workflows', () => {
    const CI = '.github/workflows/ci.yml';
    const STEPS = 'jobs:\n  test:\n    steps:\n      - run: pnpm test\n  floor:\n    steps:\n      - run: git show "origin/$BASE_REF:x" > "$dir/x"\n      - run: node guard.mjs\n';

    it.each([
      ['a removed check step', STEPS.replace('      - run: pnpm test\n', '      - run: echo skipped\n')],
      ['a changed line in the floor job', STEPS.replace('node guard.mjs', 'true')],
      ['a job allowed to fail', STEPS.replace('  test:\n', '  test:\n    continue-on-error: true\n')],
    ])('block %s', (_, content) => {
      repo = makeRepo({ ...BASE, [CI]: STEPS });
      repo.write({ [CI]: content });
      expect(guard().out).toContain(`[check-removed] ${CI}`);
    });

    // Runs the real step from ci.yml, so the test breaks if the step changes shape.
    const takeGuardStep = () => {
      const lines = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8').split('\n');
      const start = lines.findIndex((l) => l.includes('name: Take the guard from the base branch')) + 2;
      const end = lines.findIndex((l, i) => i >= start && !l.startsWith('          '));
      return lines.slice(start, end).map((l) => l.slice(10)).join('\n');
    };
    const runTakeGuard = () => {
      const temp = join(repo.dir, '.runner-temp');
      const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', takeGuardStep()], {
        cwd: repo.dir,
        env: { ...process.env, BASE_REF: 'main', RUNNER_TEMP: temp },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      return readFileSync(join(temp, 'floor-guard', 'floor-guard.mjs'), 'utf8');
    };

    it("make guard / floor run the base branch's guard, not the PR's", () => {
      repo = makeRepo({ ...BASE, '.github/scripts/floor-guard.mjs': 'base guard\n', '.github/scripts/diff.mjs': 'base diff\n' });
      repo.git('update-ref', 'refs/remotes/origin/main', 'main');
      repo.write({ '.github/scripts/floor-guard.mjs': 'process.exit(0);\n' });
      repo.commit();
      expect(runTakeGuard()).toBe('base guard\n');
    });

    it("make guard / floor fall back to the PR's guard while the base has none", () => {
      setup();
      repo.git('update-ref', 'refs/remotes/origin/main', 'main');
      repo.write({ '.github/scripts/floor-guard.mjs': 'new guard\n', '.github/scripts/diff.mjs': 'new diff\n' });
      repo.commit();
      expect(runTakeGuard()).toBe('new guard\n');
    });

    it('accept unrelated workflow edits, and a floor job or workflow that is new', () => {
      repo = makeRepo({ ...BASE, [CI]: STEPS });
      repo.write({ [CI]: `name: ci\n${STEPS}` });
      expect(guard().code).toBe(0);
      repo.write({ [CI]: 'jobs:\n  test:\n    steps:\n      - run: pnpm test\n', '.github/workflows/new.yml': "jobs:\n  x:\n    if: github.actor != 'bot'\n" });
      repo.commit();
      repo.git('switch', '-q', '-C', 'main');
      repo.git('switch', '-q', '-c', 'add-floor');
      repo.write({ [CI]: STEPS });
      expect(guard().code).toBe(0);
    });
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

  // The cases the stack review of #94–#97 found passing clean, run against the real file.
  describe('the real CONSTRAINTS.md', () => {
    const REAL = readFileSync(fileURLToPath(new URL('../../CONSTRAINTS.md', import.meta.url)), 'utf8');
    const edit = (text, from, to) => {
      if (!text.includes(from)) throw new Error(`CONSTRAINTS.md no longer contains: ${from}`);
      return text.replace(from, to);
    };
    const realRepo = (text = REAL) => (repo = makeRepo({ 'CONSTRAINTS.md': text }));
    // The line a passage starts on in the real file, so the tests survive edits above it.
    const lineOf = (needle) => {
      const n = REAL.split('\n').findIndex((l) => l.includes(needle)) + 1;
      if (!n) throw new Error(`CONSTRAINTS.md no longer contains: ${needle}`);
      return n;
    };
    const PURITY = lineOf('| Boundaries: sim purity');

    it.each([
      ['the split size raised in a paragraph', 'at most **400 changed lines**', 'at most **800 changed lines**', 'threshold-loosened'],
      ['the exception limit raised in a paragraph', 'no more than 30 days out', 'no more than 90 days out', 'threshold-loosened'],
      ['a suppression dropped from a continuation line', '`fallow-ignore-next-line`, `fallow-ignore-file`, ', '', 'rule-narrowed'],
      ['the floor guard dropped from a stage', 'lint on changed files, floor guard, boundaries', 'lint on changed files, boundaries', 'rule-narrowed'],
    ])('blocks %s', (_, from, to, rule) => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, from, to) });
      const r = guard();
      expect(r.code).toBe(1);
      expect(r.out).toContain(`[${rule}] CONSTRAINTS.md`);
    });

    // Re-review of #97: tightenings with no direction words, and a comma-only edit.
    it.each([
      ['the split size lowered in the interview record', '- **Split size:** 400 changed lines', '- **Split size:** 300 changed lines'],
      ['the ratchet tolerance lowered', '| must not fall | 0.5 points |', '| must not fall | 0.2 points |'],
      ['a comma removed from an unlabelled list item', '- **Every failing check blocks the merge**, except', '- **Every failing check blocks the merge** except'],
    ])('stays silent for %s', (_, from, to) => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, from, to) });
      expect(guard()).toMatchObject({ code: 0 });
    });

    it.each([
      ['the split size raised in the interview record', '- **Split size:** 400 changed lines', '- **Split size:** 500 changed lines'],
      ['the ratchet tolerance raised', '| must not fall | 0.5 points |', '| must not fall | 1 points |'],
    ])('blocks %s', (_, from, to) => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, from, to) });
      expect(guard().out).toContain('[threshold-loosened] CONSTRAINTS.md');
    });

    // Re-review of #97: a second Exceptions table smuggled in under another heading.
    it.each([
      ['a level-3 Exceptions heading', '###'],
      ['a second level-2 Exceptions heading', '##'],
    ])('ignores an exception row under %s', (_, hashes) => {
      realRepo();
      repo.write({
        'packages/sim/src/a.ts': '// @ts-ignore\n',
        'CONSTRAINTS.md': `${REAL}\n${hashes} Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${row('E1', 'packages/sim/src/a.ts', '2026-11-30')}\n`,
      });
      const r = guard();
      expect(r.code).toBe(1);
      expect(r.out).toContain('[silenced-checker] packages/sim/src/a.ts');
      expect(r.out).not.toContain('waived by');
    });

    it('waives through the real Exceptions table', () => {
      realRepo();
      repo.write({ 'packages/sim/src/a.ts': '// @ts-ignore\n', 'CONSTRAINTS.md': edit(REAL, '| _none_ | | | | | |', row('E1', 'packages/sim/src/a.ts', '2026-11-30')) });
      expect(guard().out).toContain('waived by E1');
    });

    it('is clean when unchanged, and when only an issue reference changes', () => {
      realRepo();
      expect(guard().code).toBe(0);
      repo.write({ 'CONSTRAINTS.md': edit(REAL, '| Types | 0 type errors | Any error is a bug or a lie | `tsc -b` (incremental) | edit, CI | `ci / typecheck` | #40 |', '| Types | 0 type errors | Any error is a bug or a lie | `tsc -b` (incremental) | edit, CI | `ci / typecheck` | #41 |') });
      expect(guard().code).toBe(0);
    });

    // #122: PR #121 added the test allowance behind a `;`, so every old item survived (830ac11).
    const ALLOWANCE = '; test files in `packages/sim` (`*.test.ts`) may also import `vitest` and `fast-check` and nothing else from outside the sim, and stay banned from `node:*` and from the calls above (admin, 9 Nov, #81)';

    // A narrowing is a warning for the admin, never a failure (admin, 9 Nov): the guard can't tell
    // an approved carve-out from an unapproved one, and a red required check has no bypass.
    const warned = (r, head) => {
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('floor-guard: clean');
      const lines = r.out.split('\n');
      const at = lines.findIndex((l) => l.includes(head));
      expect(at, `no report entry for ${head}`).toBeGreaterThan(-1);
      expect(lines[at + 1]).toContain('warning [rule-narrowed]: ');
      return lines[at + 1];
    };

    it("warns on PR #121's real rewording of the purity row", () => {
      realRepo(edit(REAL, ALLOWANCE, ''));
      repo.write({ 'CONSTRAINTS.md': REAL });
      const warning = warned(guard(), `changed: CONSTRAINTS.md:${PURITY} (rule "Boundaries: sim purity (MUST-10.1)")`);
      expect(warning).toContain('adds "may"');
      expect(warning).toContain('adds a clause to a list cell');
    });

    const SECRETS = '- Secrets in source. Read them from env vars and keep placeholders in `.env.example`.';
    it.each([
      ['added to a list item', SECRETS, SECRETS.replace('in source.', 'in source, except in test fixtures.'), `changed: CONSTRAINTS.md:${lineOf(SECRETS)}`, 'except'],
      ['added to a paragraph', 'Each blocking CI job is a required status check on `main`.', 'Each blocking CI job is a required status check on `main`, unless it runs on preview deploys.', `changed: CONSTRAINTS.md:${lineOf('Each blocking CI job')}`, 'unless'],
      ['added as a new list item', SECRETS, `${SECRETS}\n- Test files may use \`@ts-ignore\`.`, `added: CONSTRAINTS.md:${lineOf(SECRETS) + 1}`, 'may'],
    ])('warns on a carve-out %s', (_, from, to, head, word) => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, from, to) });
      expect(warned(guard(), head)).toContain(`adds "${word}"`);
    });

    const PURITY_TAIL = '`new Date()` with no arguments is banned too;';
    it.each([
      ['a clause of several words', '; sim tests import `vitest` freely;'],
      ['a two-word clause', ', tests aside;'.replace('aside', 'excused')],
    ])('warns on %s added to a list cell, even without a narrowing word', (_, tail) => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, PURITY_TAIL, `\`new Date()\` with no arguments is banned too${tail}`) });
      expect(warned(guard(), `changed: CONSTRAINTS.md:${PURITY}`)).toContain('adds a clause to a list cell');
    });

    it('warns on a dropped negation', () => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, 'One automatic retry, never more.', 'One automatic retry, more.') });
      expect(warned(guard(), 'changed: CONSTRAINTS.md:')).toContain('drops "never"');
    });

    // CONSTRAINTS.md, "Guarding the bar", names this as what the guard can't catch: it passes, but
    // it's in the report.
    it('passes a meaning change it cannot judge, and still reports it', () => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, 'Only the admin loosens anything.', 'Only the agent loosens anything.') });
      const r = guard();
      expect(r.code).toBe(0);
      expect(r.out).toContain('Only the {+agent+} loosens anything.');
      expect(r.out).not.toContain('rule-narrowed');
    });

    // Review of #122: splitting list cells at full stops let a new sentence in between two items.
    it('still fails a sentence slipped in before a full stop', () => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, '`setImmediate`. `new Date()`', '`setImmediate`. Tests are fine. `new Date()`') });
      const r = guard();
      expect(r.code).toBe(1);
      expect(r.out).toContain(`[rule-narrowed] CONSTRAINTS.md:${PURITY}`);
    });

    // Each case: [the text at the merge base, the text in the PR], as edits of the real file.
    const typo = (right, wrong) => [edit(REAL, right, wrong), REAL];
    const tighten = (from, to) => [REAL, edit(REAL, from, to)];
    it.each([
      ['a typo fixed in a list item', typo('keep placeholders in', 'keep placehodlers in')],
      ['a typo fixed in a prose cell', typo('| Any error is a bug or a lie |', '| Any eror is a bug or a lie |')],
      ['an item added to a list cell', tighten('`fetch`, `setTimeout`,', '`fetch`, `queueMicrotask`, `setTimeout`,')],
      ['an item added to a list', tighten('`fallow-ignore-file`, `# noqa`', '`fallow-ignore-file`, `fallow-ignore-next-file`, `# noqa`')],
      ['a suppression named with a narrowing word', tighten('`gitleaks:allow`,', '`gitleaks:allow`, `trufflehog:allow`,')],
    ])('does not flag %s as narrowing', (_, [base, change]) => {
      realRepo(base);
      repo.write({ 'CONSTRAINTS.md': change });
      const r = guard();
      expect(r.code).toBe(0);
      expect(r.out).toContain('changed: CONSTRAINTS.md:');
      expect(r.out).not.toContain('rule-narrowed');
    });

    // #122: every changed rule goes in front of the admin, even when nothing is flagged.
    describe('the change report', () => {
      const summaryOf = (env = {}) => {
        const file = join(repo.dir, '.summary.md');
        const r = guard({ ...TODAY, GITHUB_STEP_SUMMARY: file, ...env });
        return { ...r, summary: readFileSync(file, 'utf8') };
      };

      it('shows a clean change with its old and new text, the edit marked', () => {
        const [base, change] = typo('| Any error is a bug or a lie |', '| Any eror is a bug or a lie |');
        realRepo(base);
        repo.write({ 'CONSTRAINTS.md': change });
        const r = summaryOf();
        expect(r.code).toBe(0);
        expect(r.out).toContain(`changed: CONSTRAINTS.md:${lineOf('| Types |')} (rule "Types")`);
        expect(r.out).toContain('was: Any [-eror-] is a bug or a lie');
        expect(r.out).toContain('now: Any {+error+} is a bug or a lie');
        expect(r.summary).toContain(`CONSTRAINTS.md:${lineOf('| Types |')}`);
        expect(r.summary).toContain('now: Any {+error+} is a bug or a lie');
      });

      it("marks #121's added clause, and reports added and removed rules", () => {
        const SPARE = '| Spare | 1 spare row | n/a | `spare` | CI | `ci / spare` | #1 |\n';
        realRepo(edit(edit(REAL, ALLOWANCE, ''), '| Lint |', `${SPARE}| Lint |`));
        // The new list item moves every later line down by one.
        repo.write({ 'CONSTRAINTS.md': edit(REAL, SECRETS, `${SECRETS}\n- New rule: blocked.`) });
        const r = summaryOf({ GITHUB_ACTIONS: 'true' });
        expect(r.out).toContain('banned too{+; test files in');
        // The spare row sat where Lint sits now.
        expect(r.out).toContain(`removed: CONSTRAINTS.md:${lineOf('| Lint |')} (old) (rule "Spare")`);
        expect(r.out).toContain(`added: CONSTRAINTS.md:${lineOf(SECRETS) + 1} (rule "New rule")`);
        expect(r.out).toContain('now: {+New rule: blocked.+}');
        const purity = r.out.split('\n').find((l) => l.startsWith(`::warning file=CONSTRAINTS.md,line=${PURITY + 1},`));
        expect(purity).toMatch(/title=CONSTRAINTS\.md rule may be narrowed \(admin reads\)::.*banned too\{\+; test files in/);
      });

      it('shows changed text that is no rule: comments, fences, headings', () => {
        realRepo();
        repo.write({ 'CONSTRAINTS.md': edit(edit(REAL, '## Stages\n', '## Stages\n\n<!-- agents may skip the bench -->\n\n```\nskip it\n```\n'), '### Timing checks', '### Timing') });
        // Renaming a heading also unpairs its rules (rule-removed, a failure); only the report is checked here.
        const r = guard();
        expect(r.out).toMatch(/other: CONSTRAINTS\.md:\d+ \(not a rule\)\n +warning \[rule-narrowed\]: adds "may".*\n +now: \{\+<!-- agents may skip the bench -->\+\}/);
        expect(r.out).toContain('now: {+skip it+}');
        expect(r.out).toContain('was: [-### Timing checks-]');
        expect(r.out).toContain('now: {+### Timing+}');
      });

      // GitHub keeps 10 warning annotations per step (REST docs, check runs, checked 9 Nov).
      it('fits GitHub\'s 10 annotations, pointing to the summary for the rest', () => {
        realRepo();
        repo.write({ 'CONSTRAINTS.md': REAL.replaceAll('| #40 |', '| #140 |').replaceAll('| #41 |', '| #141 |').replaceAll('| #43 |', '| #143 |') });
        const notes = guard({ ...TODAY, GITHUB_ACTIONS: 'true' }).out.split('\n').filter((l) => l.startsWith('::warning'));
        expect(notes).toHaveLength(10);
        expect(notes[9]).toMatch(/^::warning file=CONSTRAINTS\.md,title=[^:]+::\d+ more changed rules are in the job summary/);
      });

      // The report quotes text a PR wrote, so under Actions it must not run as a workflow command.
      it('prints quoted text inside a stop-commands block, and the annotations after it', () => {
        realRepo();
        // A rule's own text, and a table header that the report prints on a line of its own (review
        // of #122: the runner trims leading spaces before it reads a command).
        const header = edit(REAL, '| Required check | Enforced by |\n|---', '| Required check | ::error file=x.ts::pwned |\n|---');
        const injected = edit(edit(header, '| `ci / typecheck` | #40 |', '| `ci / typecheck` | #41 |'), SECRETS, `${SECRETS}\n- Injected:\n::error::pwned\n\n::add-mask::x`);
        repo.write({ 'CONSTRAINTS.md': injected });
        const lines = guard({ ...TODAY, GITHUB_ACTIONS: 'true' }).out.split('\n');
        const open = lines.findIndex((l) => l.startsWith('::stop-commands::'));
        const token = lines[open]?.slice('::stop-commands::'.length);
        expect(token).toMatch(/^[0-9a-f-]{36}$/);
        const close = lines.indexOf(`::${token}::`);
        expect(close).toBeGreaterThan(open);
        const outside = lines.filter((l, i) => (i < open || i > close) && l.trim().startsWith('::'));
        expect(outside.length).toBeGreaterThan(0);
        expect(outside.every((l) => l.startsWith('::warning file=CONSTRAINTS.md'))).toBe(true);
        const inside = lines.slice(open + 1, close);
        expect(inside.join('\n')).toContain('::error::pwned');
        expect(inside.some((l) => l.trim().startsWith('::error file=x.ts::pwned'))).toBe(true);
      });

      it('redacts key-like text it quotes', () => {
        realRepo();
        const key = `ghp_${'a1B2'.repeat(9)}`; // assembled, so no scanner reads a key in this file
        repo.write({ 'CONSTRAINTS.md': edit(REAL, SECRETS, `${SECRETS}\n- Example key: ${key}.`) });
        const r = summaryOf({ GITHUB_ACTIONS: 'true' });
        expect(r.out).toContain('Example key: [redacted]');
        expect(r.out + r.summary).not.toContain(key);
      });

      it('stays out of the log when CONSTRAINTS.md is unchanged', () => {
        setup();
        repo.write({ 'packages/sim/src/b.ts': 'export const b = 2;\n' });
        expect(guard().out).not.toContain('was:');
      });
    });

    const NOT_YET = 'not yet: recorded after the first `packages/sim` PR';
    it('lets the coverage ratchet get its first value, then holds it', () => {
      realRepo();
      repo.write({ 'CONSTRAINTS.md': edit(REAL, NOT_YET, '92.5%') });
      expect(guard().code).toBe(0);
      realRepo(edit(REAL, NOT_YET, '92.5%'));
      repo.write({ 'CONSTRAINTS.md': edit(REAL, NOT_YET, '90%') });
      expect(guard().out).toContain('[threshold-loosened] CONSTRAINTS.md');
      repo.write({ 'CONSTRAINTS.md': edit(REAL, NOT_YET, '93%') });
      expect(guard().code).toBe(0);
    });
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

  it.each([
    ['in a code fence', (r) => CONSTRAINTS.replace('## Floor\n', `## Floor\n\n\`\`\`\n${r}\n\`\`\`\n`)],
    ['in another section', (r) => CONSTRAINTS.replace('- Secrets in source: blocked.\n', `- Secrets in source: blocked.\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${r}\n`)],
    ['in an HTML comment', (r) => `${CONSTRAINTS}\n<!--\n${r}\n-->\n`],
  ])('does not waive with a row-shaped line %s', (_, place) => {
    setup();
    repo.write({
      'packages/sim/src/a.ts': '// @ts-expect-error legacy\n',
      'CONSTRAINTS.md': place(row('E1', 'packages/sim/src/a.ts', '2026-11-30')),
    });
    expect(guard().out).toContain('[silenced-checker] packages/sim/src/a.ts');
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

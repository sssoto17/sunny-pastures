#!/usr/bin/env node
// coverage-gate.mjs: coverage of changed lines, and the project coverage ratchet
// (CONSTRAINTS.md, "Enforced with numbers" and "Ratchets"). Reads the lcov the test run already
// wrote and intersects it with the diff against the merge base; it never runs the tests again.
//
// Usage: node .github/scripts/coverage-gate.mjs [--base <ref>] [--lcov <path>] [--skip-ratchet]
// Exit codes: 0 pass, 1 below a threshold, 2 could not run. A 2 never reads as a pass.
//
// lcov decides which files count: vitest.config.* holds the include and exclude lists, and with
// `coverage.include` set, Vitest reports untested files at 0%. A changed file that isn't in the
// lcov isn't a source file under coverage, so it doesn't count.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CannotRun, baseArg, enterRepo, readChange } from './diff.mjs';

// The changed-line thresholds, in percent. First match wins.
export const THRESHOLDS = [
  { name: 'packages/sim', test: (f) => f.startsWith('packages/sim/'), min: 90 },
  { name: 'rest of apps/ and packages/', test: (f) => /^(apps|packages)\//.test(f), min: 80 },
];
export const RATCHET_TOLERANCE = 0.5;

// lcov → Map(file → Map(line → hits)). Paths become repo-relative.
export const parseLcov = (text, root) => {
  const files = new Map();
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      cur = new Map();
      files.set(relative(root, resolve(root, line.slice(3))).split('\\').join('/'), cur);
    } else if (line.startsWith('DA:') && cur) {
      const [n, hits] = line.slice(3).split(',');
      cur.set(Number(n), (cur.get(Number(n)) ?? 0) + Number(hits));
    } else if (line === 'end_of_record') {
      cur = null;
    }
  }
  return files;
};

// The recorded project coverage from the "Ratchets" table, or null while it says "not yet". Only
// "not yet" means no ratchet: any other cell it can't read can't run (exit 2), so a typo can't
// switch the ratchet off (#99).
export const recordedProjectCoverage = (constraints) => {
  const row = constraints.split('\n').find((l) => /^\|\s*Project coverage\s*\|/.test(l));
  if (!row) throw new CannotRun('CONSTRAINTS.md has no "Project coverage" row under Ratchets');
  const today = row.split('|')[2]?.trim() ?? '';
  if (/^not yet\b/i.test(today)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(today);
  if (!m) throw new CannotRun(`the Project coverage "Today" cell is neither a percentage nor "not yet": ${JSON.stringify(today)}`);
  return Number(m[1]);
};

export const evaluate = ({ changes, lcov, recorded, skipRatchet = false }) => {
  const groups = THRESHOLDS.map((t) => ({ ...t, executable: 0, covered: 0 }));
  for (const f of changes) {
    const lines = lcov.get(f.path);
    if (!lines || f.status === 'deleted') continue;
    const group = groups.find((g) => g.test(f.path));
    if (!group) continue;
    for (const { line } of f.added) {
      if (!lines.has(line)) continue; // not an executable line
      group.executable++;
      if (lines.get(line) > 0) group.covered++;
    }
  }
  const failures = [];
  const report = [];
  for (const g of groups) {
    if (g.executable === 0) {
      report.push(`${g.name}: no executable changed lines`);
      continue;
    }
    const pct = (100 * g.covered) / g.executable;
    report.push(`${g.name}: ${pct.toFixed(1)}% of ${g.executable} changed lines (needs ≥ ${g.min}%)`);
    if (pct < g.min) failures.push(`${g.name} changed-line coverage ${pct.toFixed(1)}% < ${g.min}%`);
  }
  let found = 0;
  let hit = 0;
  for (const lines of lcov.values()) {
    for (const hits of lines.values()) {
      found++;
      if (hits > 0) hit++;
    }
  }
  if (skipRatchet) {
    report.push('project coverage ratchet: skipped (--skip-ratchet: a run of related tests only; CI checks it)');
  } else if (recorded === null) {
    report.push('project coverage ratchet: no value recorded yet');
  } else if (found === 0) {
    failures.push(`project coverage ratchet: ${recorded}% recorded, but the lcov has no lines`);
  } else {
    const pct = (100 * hit) / found;
    report.push(`project coverage: ${pct.toFixed(2)}% (recorded ${recorded}%, tolerance ${RATCHET_TOLERANCE} points)`);
    if (pct < recorded - RATCHET_TOLERANCE) {
      failures.push(`project coverage ${pct.toFixed(2)}% fell more than ${RATCHET_TOLERANCE} points below ${recorded}%`);
    }
  }
  return { failures, report };
};

// Changed files that look like source under coverage, used only when the lcov is missing.
const looksLikeSource = (f) =>
  /^(apps|packages)\/[^/]+\/src\/.*\.(ts|tsx)$/.test(f.path) && !/\.(test|spec)\.|\.d\.ts$/.test(f.path) && f.status !== 'deleted';

const main = () => {
  const argv = process.argv;
  const i = argv.indexOf('--lcov');
  const lcovArg = i > -1 && argv[i + 1] ? argv[i + 1] : 'coverage/lcov.info';
  const lcovPath = resolve(lcovArg);
  const mergeBase = enterRepo(baseArg(argv));
  const changes = readChange(mergeBase);
  const root = process.cwd();
  const recorded = recordedProjectCoverage(readFileSync('CONSTRAINTS.md', 'utf8'));
  if (!existsSync(lcovPath)) {
    if (changes.some(looksLikeSource) || recorded !== null) {
      throw new CannotRun(`no lcov at ${relative(root, lcovPath)}: run the tests with --coverage first`);
    }
    console.log('coverage-gate: no lcov and no changed source files: pass');
    return 0;
  }
  // `check:task` runs only the tests related to the change (`vitest --changed`), so the lcov counts
  // every other file at 0% and the project figure reads low. It passes --skip-ratchet; CI runs the
  // whole suite and checks the ratchet (#99).
  const skipRatchet = argv.includes('--skip-ratchet');
  const { failures, report } = evaluate({ changes, lcov: parseLcov(readFileSync(lcovPath, 'utf8'), root), recorded, skipRatchet });
  for (const r of report) console.log(`coverage-gate: ${r}`);
  if (failures.length === 0) return 0;
  for (const f of failures) console.error(`coverage-gate: FAIL ${f}`);
  console.error('Add tests for the changed lines. Exclusions live in vitest.config.*, and widening them is a moved threshold.');
  return 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`coverage-gate: cannot run: ${e instanceof CannotRun ? e.message : e?.stack ?? e}`);
    process.exitCode = 2;
  }
}

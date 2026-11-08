#!/usr/bin/env node
// floor-guard.mjs: diff-scoped enforcement of the CONSTRAINTS.md floor (`guard / floor`, #40).
// Adapted from .agents/skills/constraint-driven-development/references/floor-guard.md; the
// contract is the reference's:
//   - input: the diff from the merge base to the working tree, plus untracked files;
//   - exit codes: 0 clean, 1 floor violation, 2 could not run (a 2 never reads as clean);
//   - it reports the rule and the location, never the matched text;
//   - tightening is silent, loosening is loud.
//
// Usage: node .github/scripts/floor-guard.mjs [--base <ref>]   (default base: origin/main)
//
// This part scans the changed lines. Changes to CONSTRAINTS.md itself, and the Exceptions rows
// that let a weakened bar through, come in the next part of #40.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CannotRun, baseArg, enterRepo, oldContent, readChange } from './diff.mjs';

// This file and its tests spell out every pattern they look for, so the line scans skip them.
// Both sit under .github/, which is code-owned (ADR-0002, appendix A3).
const SELF = new Set(['.github/scripts/floor-guard.mjs', '.github/scripts/floor-guard.test.mjs']);

// CONSTRAINTS.md, Floor: the suppression comments.
const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|istanbul ignore|c8 ignore|v8 ignore|Stryker disable|nosemgrep|gitleaks:allow|fallow-ignore-next-line|fallow-ignore-file|#\s*noqa|#\s*type:\s*ignore/;
const SKIPS = /\.(skip|only|todo|skipIf|runIf)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
const STUBS = /throw new \w*Error\(\s*['"`][^'"`]*[Nn]ot [Ii]mplemented|catch\s*(\([^)]*\))?\s*\{\s*\}|\bTODO\b/;
// An ESLint rule turned off or down to a warning: `'rule': 'off'`, `'rule': 0`, `'rule': ['warn', …]`.
const RULE_OFF = /(["'][\w@/-]+["']|\w+)\s*:\s*\[?\s*["'](off|warn)["']|["'][\w@/-]+["']\s*:\s*\[?\s*[01]\b/;
const OPEN_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*$/;
const ASSERTION = /\b(expect|assert)\b/;
const ASSERTIONS = /\b(expect|assert)\b/g;
const RUN_COUNT = /\b(numRuns|SIM_PROPERTY_RUNS)\b\D{0,20}?(\d+)/;
const STRICT_KEYS =
  /"(strict\w*|noImplicit\w+|noUnused\w+|noUnchecked\w+|noFallthroughCasesInSwitch|noPropertyAccessFromIndexSignature|exactOptionalPropertyTypes|alwaysStrict|useUnknownInCatchVariables|allowUnreachableCode|allowUnusedLabels)"\s*:\s*(true|false)/;

const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests)\//.test(f);
const isProse = (f) => /\.(md|mdx|txt)$/i.test(f);

// The key of the array a line sits in (`exclude: [`, `"exclude": [`), or null.
export const enclosingKey = (lines, n) => {
  const keyBefore = (s) => /["']?(\w+)["']?\s*:\s*$/.exec(s)?.[1] ?? null;
  const own = lines[n - 1] ?? '';
  const open = own.lastIndexOf('[');
  if (open > -1 && keyBefore(own.slice(0, open))) return keyBefore(own.slice(0, open));
  let depth = 0;
  for (let i = n - 2; i >= 0; i--) {
    const l = lines[i] ?? '';
    for (let j = l.length - 1; j >= 0; j--) {
      if (l[j] === ']') depth++;
      else if (l[j] === '[') {
        if (depth === 0) return keyBefore(l.slice(0, j));
        depth--;
      }
    }
  }
  return null;
};

// Tool configs that can weaken a check (CONSTRAINTS.md, Floor, last bullet). Returns the lines
// of one changed file that loosen it. A config that didn't exist at the merge base has no bar
// to lower, so only an explicit "off" or "false" counts there.
const configLoosening = (f, mergeBase) => {
  const name = basename(f.path);
  const hits = [];
  const newLines = () => readFileSync(f.path, 'utf8').split('\n');
  if (name === '.gitleaksignore' || name === '.semgrepignore') {
    for (const a of f.added) if (a.text.trim() && !a.text.trim().startsWith('#')) hits.push(a.line);
  } else if (/^(\.gitleaks\.toml|osv-scanner\.toml|stryker\.(conf|config)\..+|\.?lighthouserc(\..+)?|\.?fallowrc(\..+)?|\.?fallow\.(toml|json|jsonc))$/.test(name)) {
    for (const a of f.added) if (/allowlist|ignore|exclude|disable|skip|\boff\b|["']warn["']/i.test(a.text)) hits.push(a.line);
  } else if (/^vitest\.config\./.test(name)) {
    if (f.status !== 'added') {
      const now = newLines();
      for (const a of f.added) if (enclosingKey(now, a.line) === 'exclude') hits.push(a.line);
      const before = oldContent(mergeBase, f.oldPath) ?? [];
      for (const r of f.removed) if (enclosingKey(before, r.line) === 'include') hits.push(`${r.line} (old)`);
    }
  } else if (/^eslint\.config\./.test(name)) {
    for (const a of f.added) if (RULE_OFF.test(a.text)) hits.push(a.line);
    if (f.status !== 'added') {
      const now = newLines();
      for (const a of f.added) if (enclosingKey(now, a.line) === 'ignores') hits.push(a.line);
      for (const r of f.removed) if (/configs\.|["']error["']/.test(r.text)) hits.push(`${r.line} (old)`);
    }
  } else if (/^tsconfig.*\.json$/.test(name)) {
    const addedTrue = new Set(f.added.map((a) => STRICT_KEYS.exec(a.text)).filter((m) => m?.[2] === 'true').map((m) => m[1]));
    for (const a of f.added) {
      const m = STRICT_KEYS.exec(a.text);
      const loosens = m && (/^allowUnre|^allowUnused/.test(m[1]) ? m[2] === 'true' : m[2] === 'false');
      if (loosens) hits.push(a.line);
    }
    for (const r of f.removed) {
      const m = STRICT_KEYS.exec(r.text);
      if (m?.[2] === 'true' && !/^allow/.test(m[1]) && !addedTrue.has(m[1])) hits.push(`${r.line} (old)`);
    }
    if (f.status !== 'added') {
      const now = newLines();
      for (const a of f.added) if (enclosingKey(now, a.line) === 'exclude') hits.push(a.line);
    }
  }
  if (!isProse(f.path)) for (const a of f.added) if (/\bdisableRules\b/.test(a.text)) hits.push(a.line);
  return hits;
};

export const guard = (changes, { mergeBase }) => {
  const findings = []; // { rule, file, line, waivable }
  const push = (waivable) => (rule, file, line, key) => findings.push({ rule, file, line, key, waivable });
  const weak = push(true);
  const always = push(false);

  for (const f of changes) {
    if (f.status === 'deleted') {
      if (isTest(f.path)) weak('test-deleted', f.path, 'file');
      continue;
    }
    const scan = !SELF.has(f.path) && !isProse(f.path);
    if (scan) {
      const byLine = new Map(f.added.map((a) => [a.line, a.text]));
      for (const { line, text } of f.added) {
        if (SUPPRESSIONS.test(text)) weak('silenced-checker', f.path, line);
        if (isTest(f.path) && SKIPS.test(text)) weak('test-made-easier', f.path, line);
        if (STUBS.test(text)) always('unfinished-work', f.path, line);
        else if (OPEN_CATCH.test(text) && /^\s*\}/.test(byLine.get(line + 1) ?? '')) always('unfinished-work', f.path, line);
      }
      if (isTest(f.path)) {
        const count = (ls) => ls.reduce((n, l) => n + (l.text.match(ASSERTIONS)?.length ?? 0), 0);
        if (count(f.removed) > count(f.added)) weak('assertion-removed', f.path, `${f.removed.find((l) => ASSERTION.test(l.text))?.line} (old)`);
      }
    }
    for (const r of f.removed) {
      const was = RUN_COUNT.exec(r.text);
      if (!was) continue;
      const now = f.added.map((a) => RUN_COUNT.exec(a.text)).find((m) => m?.[1] === was[1]);
      if (now && Number(now[2]) < Number(was[2])) weak('property-runs-cut', f.path, `${r.line} (old)`);
    }
    for (const line of configLoosening(f, mergeBase)) weak('config-loosened', f.path, line);
  }

  return { blocking: findings, notices: [] };
};

const HINTS = {
  'config-loosened': 'A tool config was loosened (CONSTRAINTS.md, Floor, last bullet).',
};

const main = () => {
  const mergeBase = enterRepo(baseArg(process.argv));
  const changes = readChange(mergeBase);
  const { blocking, notices } = guard(changes, { mergeBase });
  for (const n of notices) console.log(`floor-guard: note: ${n}`);
  if (blocking.length === 0) {
    console.log('floor-guard: clean');
    return 0;
  }
  console.error(`floor-guard: ${blocking.length} floor violation(s):`);
  for (const f of blocking) console.error(`  [${f.rule}] ${f.file}:${f.line}${f.key ? ` (rule "${f.key}")` : ''}`);
  for (const rule of new Set(blocking.map((f) => f.rule))) if (HINTS[rule]) console.error(`\n${HINTS[rule]}`);
  console.error('\nEach lowers the bar. Fix the code.');
  return 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`floor-guard: cannot run: ${e instanceof CannotRun ? e.message : e?.stack ?? e}`);
    process.exitCode = 2;
  }
}

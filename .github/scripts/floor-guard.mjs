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
// FLOOR_GUARD_TODAY=YYYY-MM-DD overrides today's date (tests only).
//
// A weakened bar (silenced checker, easier test, moved threshold, loosened tool config) passes
// only when the same PR adds an Exceptions row to CONSTRAINTS.md whose Path covers the file.
// Unfinished work and invalid or expired exceptions always fail.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CannotRun, baseArg, enterRepo, oldContent, readChange } from './diff.mjs';

// This file and its tests spell out the suppression and stub patterns, so those two scans skip
// them; every other check still applies. CI runs the base branch's copy of this guard (ci.yml,
// `guard / floor`), so a PR can't switch it off by editing it.
const SELF = new Set(['.github/scripts/floor-guard.mjs', '.github/scripts/floor-guard.test.mjs']);
// A workflow line that runs a check: removing it, or letting the job fail quietly, weakens the bar.
const WORKFLOW = /^\.github\/(workflows|actions)\/.+\.ya?ml$/;
const CHECK_STEP = /floor-guard\.mjs|coverage-gate\.mjs|pnpm (typecheck|lint|test)\b|SIM_PROPERTY_RUNS/;
const FREEZE = '2026-12-20'; // CONSTRAINTS.md, Exceptions: never past the feature freeze
const MAX_EXCEPTION_DAYS = 30;

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

// The id of the workflow job a line sits in (a two-space-indented key under `jobs:`), or null.
const jobOf = (lines, n) => {
  for (let i = n - 1; i >= 0; i--) {
    const l = lines[i] ?? '';
    const m = /^ {2}([\w-]+):\s*$/.exec(l);
    if (m) return m[1];
    if (/^\S/.test(l)) return null;
  }
  return null;
};

const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests)\//.test(f);
const isProse = (f) => /\.(md|mdx|txt)$/i.test(f);
const isConstraints = (f) => f === 'CONSTRAINTS.md';

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

// CONSTRAINTS.md rules. The file is compared as a whole, before and after: every table row, list
// item (with its continuation lines) and paragraph is a rule. Rows and list items pair by section
// and key (first cell, or the text before the first colon); paragraphs pair with the most similar
// paragraph in the same section. Numbers carry a direction read from the words around them.
export const parseRules = (lines) => {
  const rules = [];
  let section = '';
  let headers = null;
  let cur = null;
  let fence = false;
  let comment = false;
  const flush = () => {
    if (cur) rules.push(cur);
    cur = null;
  };
  lines.forEach((line = '', i) => {
    const n = i + 1;
    // HTML comments hold no rules (and no exceptions).
    if (comment || /^\s*<!--/.test(line)) {
      flush();
      comment = !line.includes('-->');
      return;
    }
    if (/^\s*```/.test(line)) {
      flush();
      fence = !fence;
      return;
    }
    if (fence) return;
    if (/^#{1,6} /.test(line)) {
      flush();
      headers = null;
      section = line.replace(/^#+\s*/, '').trim();
      return;
    }
    if (!line.trim()) {
      flush();
      headers = null;
      return;
    }
    if (line.trim().startsWith('|')) {
      flush();
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) return;
      if (!headers) headers = cells;
      else rules.push({ kind: 'row', section, key: cells[0], line: n, text: line, cells, headers });
      return;
    }
    const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flush();
      cur = { kind: 'item', section, key: item[1].replace(/\*\*/g, '').split(':')[0].trim(), line: n, text: item[1] };
    } else if (cur && (cur.kind === 'para' || /^\s+\S/.test(line))) {
      cur.text += `\n${line}`;
    } else {
      flush();
      cur = { kind: 'para', section, key: null, line: n, text: line };
    }
  });
  flush();
  return rules;
};
// Tokens that contain digits but aren't thresholds: issue refs, dates, versions, IDs such as
// MUST-10.1, BASE-04, E1, v8 or p95, and link targets.
const NOT_NUMBERS = [
  /\(https?:[^)]*\)|https?:\/\/\S+/g,
  /#\d+/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/g,
  /\b\d+(\.\d+){2,}\b/g,
  /\b[A-Za-z][A-Za-z-]*\d[\w.-]*/g,
];
export const numbersOf = (text) => {
  let t = text.replace(/\*\*/g, '').replace(/\s+/g, ' ');
  for (const re of NOT_NUMBERS) t = t.replace(re, ' ');
  return thresholds(t);
};
const PROSE_HEADER = /why|reason|covers|what is checked|notes?/i;
// Numbers are judged by direction (compareNumbers), so list items compare with them masked.
const norm = (s) => s.replace(/[`*]/g, '').replace(/\d+(\.\d+)*/g, 'N').replace(/\s+/g, ' ').replace(/[.:]+$/, '').trim().toLowerCase();
const ticks = (t) => new Set([...t.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
// What a rule lists: backticked tokens, plus the comma-separated items of a table's list cells.
const listed = (r) => {
  if (r.kind !== 'row') return new Set(ticks(r.text));
  const out = new Set();
  r.cells.forEach((c, i) => {
    const h = r.headers[i] ?? '';
    if (i === 0 || PROSE_HEADER.test(h) || /^today$/i.test(h)) return;
    for (const t of ticks(c)) out.add(`\`${norm(t)}\``);
    for (const item of c.split(/[,;]/)) if (norm(item)) out.add(norm(item));
  });
  return out;
};
const cellOf = (r, header) => {
  const i = r.headers?.findIndex((h) => new RegExp(`^${header}$`, 'i').test(h)) ?? -1;
  return i > -1 ? r.cells[i] ?? '' : null;
};
const words = (t) => new Set(t.toLowerCase().match(/[a-z]{3,}/g) ?? []);
const similarity = (a, b) => {
  const A = words(a);
  const B = words(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(1, A.size + B.size - shared);
};
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed|within)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(or more|or higher|must not fall|must not drop)/;
const MAX_AFTER = /^\s*\S*\s*(or less|or lower|must not grow|must not exceed)/;
const thresholds = (t) => {
  const out = [];
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const dir = MIN_BEFORE.test(before) || MIN_AFTER.test(after) ? 'min' : MAX_BEFORE.test(before) || MAX_AFTER.test(after) ? 'max' : null;
    out.push({ n: Number(m[0]), dir });
  }
  return out;
};
const STAGE_CELL = /^(edit|task end|ci|preview|gate)(\s*,\s*(edit|task end|ci|preview|gate))*$/i;
const stages = (t) =>
  new Set(t.split('|').map((c) => c.trim()).filter((c) => STAGE_CELL.test(c)).flatMap((c) => c.toLowerCase().split(/\s*,\s*/)));
const WEAKER_SEVERITY = /_\(warn\)_|\(not required\)/;

const compareNumbers = (was, now) => {
  for (const dir of ['min', 'max', null]) {
    const before = was.filter((x) => x.dir === dir);
    const after = now.filter((x) => x.dir === dir);
    for (const [i, b] of before.entries()) {
      const n = after[i];
      if (!n) return 'threshold-removed';
      if (n.n !== b.n && (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : true)) return dir ? 'threshold-loosened' : 'threshold-changed';
    }
  }
  return null;
};

// The verdict for one rule that changed, or null when it only got stricter or was reworded
// without dropping a number, a listed item, a stage or a severity.
const compareRule = (old, now) => {
  // A ratchet's "Today" cell: "not yet" → a number is its first value; after that it holds.
  const textOf = (r) => (r.kind === 'row' && cellOf(r, 'today') !== null ? r.cells.filter((_, i) => !/^today$/i.test(r.headers[i] ?? '')).join(' | ') : r.text);
  const verdict = compareNumbers(numbersOf(textOf(old)), numbersOf(textOf(now)));
  if (verdict) return verdict;
  if (old.kind === 'row' && cellOf(old, 'today') !== null) {
    const was = numbersOf(cellOf(old, 'today'))[0];
    const is = numbersOf(cellOf(now, 'today') ?? '')[0];
    const grows = /grow|exceed/i.test(cellOf(now, 'direction') ?? '');
    if (was && !is) return 'threshold-removed';
    if (was && is && (grows ? is.n > was.n : is.n < was.n)) return 'threshold-loosened';
  }
  if (WEAKER_SEVERITY.test(now.text) && !WEAKER_SEVERITY.test(old.text)) return 'severity-dropped';
  const nowStages = stages(now.text);
  if ([...stages(old.text)].some((s) => !nowStages.has(s))) return 'stage-moved';
  const nowListed = listed(now);
  if ([...listed(old)].some((x) => !nowListed.has(x))) return 'rule-narrowed';
  return null;
};

const constraintsFindings = (f, mergeBase) => {
  const out = [];
  const before = parseRules(oldContent(mergeBase, f.oldPath ?? f.path) ?? []);
  const after = parseRules(readFileSync(f.path, 'utf8').split('\n'));
  const isException = (r) => r.kind === 'row' && (/^E\d+$/.test(r.key) || r.key === '_none_');
  const unchanged = new Set(after.map((r) => `${r.section}\0${r.text}`));
  const taken = new Set();
  for (const old of before) {
    // Dropping an exception, or the table's `_none_` placeholder, tightens: silent.
    if (isException(old) || unchanged.has(`${old.section}\0${old.text}`)) continue;
    let now;
    if (old.kind === 'para') {
      let best = 0.5;
      for (const r of after) {
        if (r.kind !== 'para' || r.section !== old.section || taken.has(r)) continue;
        const s = similarity(old.text, r.text);
        if (s >= best) [best, now] = [s, r];
      }
    } else {
      now = after.find((r) => r.kind === old.kind && r.section === old.section && r.key === old.key && !taken.has(r));
    }
    const key = old.key ?? `paragraph in "${old.section}"`;
    if (!now) {
      out.push({ rule: 'rule-removed', line: `${old.line} (old)`, key });
      continue;
    }
    taken.add(now);
    const verdict = compareRule(old, now);
    if (verdict) out.push({ rule: verdict, line: now.line, key });
  }
  return out;
};

// Exceptions rows: | ID | Rule | Path | Reason | Owner | Expires |
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export const parseDate = (s) => {
  const t = s.replace(/[`*_]/g, '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/.exec(t);
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  if (m && month !== undefined) return Date.UTC(Number(m[3]), month, Number(m[1]));
  return null;
};
export const parseException = (text) => {
  const cells = text.trim().split('|').slice(1, -1).map((c) => c.trim());
  return { id: cells[0], path: (cells[2] ?? '').replace(/`/g, ''), expires: parseDate(cells[5] ?? '') };
};
export const globToRegExp = (glob) =>
  new RegExp(
    '^' +
      glob
        .split(/(\*\*\/?|\*)/)
        .map((p) => (p.startsWith('**') ? '.*' : p === '*' ? '[^/]*' : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      (glob.endsWith('/') ? '.*' : '') +
      '$',
  );

export const guard = (changes, { mergeBase, today, constraintsNow }) => {
  const findings = []; // { rule, file, line, key?, waivable }
  const notices = [];
  const push = (waivable) => (rule, file, line, key) => findings.push({ rule, file, line, key, waivable });
  const weak = push(true);
  const always = push(false);

  for (const f of changes) {
    if (f.status === 'deleted') {
      if (isTest(f.path)) weak('test-deleted', f.path, 'file');
      continue;
    }
    if (isConstraints(f.path)) {
      for (const c of constraintsFindings(f, mergeBase)) weak(c.rule, f.path, c.line, c.key);
    }
    if (isProse(f.path)) continue;
    const byLine = new Map(f.added.map((a) => [a.line, a.text]));
    for (const { line, text } of f.added) {
      // Only the suppression and stub scans skip the guard's own files (see SELF).
      if (!SELF.has(f.path)) {
        if (SUPPRESSIONS.test(text)) weak('silenced-checker', f.path, line);
        if (STUBS.test(text)) always('unfinished-work', f.path, line);
        else if (OPEN_CATCH.test(text) && /^\s*\}/.test(byLine.get(line + 1) ?? '')) always('unfinished-work', f.path, line);
      }
      if (isTest(f.path) && SKIPS.test(text)) weak('test-made-easier', f.path, line);
    }
    if (isTest(f.path)) {
      const count = (ls) => ls.reduce((n, l) => n + (l.text.match(ASSERTIONS)?.length ?? 0), 0);
      if (count(f.removed) > count(f.added)) weak('assertion-removed', f.path, `${f.removed.find((l) => ASSERTION.test(l.text))?.line} (old)`);
    }
    if (WORKFLOW.test(f.path)) {
      const before = f.oldPath ? oldContent(mergeBase, f.oldPath) ?? [] : [];
      const now = readFileSync(f.path, 'utf8').split('\n');
      const kept = new Set(f.added.map((a) => a.text.trim()));
      const gone = new Set(f.removed.map((r) => r.text.trim()));
      for (const r of f.removed) {
        const guarded = CHECK_STEP.test(r.text) || jobOf(before, r.line) === 'floor';
        if (guarded && !kept.has(r.text.trim())) weak('check-removed', f.path, `${r.line} (old)`);
      }
      // A workflow, or a floor job, that didn't exist at the merge base has no bar to lower.
      const hadFloor = before.some((l) => /^ {2}floor:\s*$/.test(l));
      for (const a of f.added) {
        if (f.status === 'added') break;
        // A skipped required job reports as passing, so a new `if:` counts too.
        const loosens = /continue-on-error:\s*true|^\s*-?\s*if:/.test(a.text) || (hadFloor && jobOf(now, a.line) === 'floor');
        if (loosens && !gone.has(a.text.trim())) weak('check-removed', f.path, a.line);
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

  // Exceptions: added rows waive weak findings on their path; every row must still be valid.
  // Rows come from the parsed Exceptions table only, never from raw diff lines, so a row-shaped
  // line in a code fence, a comment or another table can't waive anything.
  const exceptionRows = (lines) => parseRules(lines).filter((r) => r.kind === 'row' && r.section === 'Exceptions' && /^E\d+$/.test(r.key));
  const constraints = changes.find((f) => isConstraints(f.path));
  const rowsNow = exceptionRows(constraintsNow.split('\n'));
  const rowsBefore = new Set(constraints ? exceptionRows(oldContent(mergeBase, constraints.oldPath ?? constraints.path) ?? []).map((r) => r.text.trim()) : rowsNow.map((r) => r.text.trim()));
  const addedRows = rowsNow.filter((r) => !rowsBefore.has(r.text.trim()));
  const waivers = [];
  const latest = Math.min(today + MAX_EXCEPTION_DAYS * 864e5, Date.parse(FREEZE));
  for (const a of addedRows) {
    const e = parseException(a.text);
    if (e.expires === null || !e.path) always('exception-invalid', 'CONSTRAINTS.md', a.line, e.id);
    else if (e.expires > latest) always('exception-too-long', 'CONSTRAINTS.md', a.line, e.id);
    else {
      waivers.push({ ...e, re: globToRegExp(e.path) });
      notices.push(`new exception ${e.id} on ${e.path}`);
    }
  }
  for (const r of rowsNow) {
    const e = parseException(r.text);
    if (e.expires !== null && e.expires < today) always('exception-expired', 'CONSTRAINTS.md', r.line, e.id);
  }
  const blocking = [];
  for (const f of findings) {
    const w = f.waivable && waivers.find((x) => x.re.test(f.file));
    if (w) notices.push(`${f.rule} at ${f.file}:${f.line} waived by ${w.id}`);
    else blocking.push(f);
  }
  return { blocking, notices };
};

const HINTS = {
  'rule-removed': "A rule-removed finding can also mean the rule's label changed: rename a rule in one commit and change its thresholds in another.",
  'threshold-removed': 'A threshold-removed finding can also mean a number lost its direction words (">= 80%" becoming "80%"): compare the two lines.',
  'rule-narrowed': 'A rule-narrowed finding means a listed item (a backticked token, or an item in a table\'s list cell) is gone from the rule. A rewording that drops one counts too: keep the item, or route it through an exception.',
  'config-loosened': 'A tool config was loosened (CONSTRAINTS.md, Floor, last bullet).',
  'check-removed': 'A workflow step that runs a check was removed, or a job was allowed to fail.',
};

const main = () => {
  const mergeBase = enterRepo(baseArg(process.argv));
  const changes = readChange(mergeBase);
  const todayEnv = process.env.FLOOR_GUARD_TODAY;
  const today = todayEnv ? parseDate(todayEnv) : Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  if (today === null) throw new CannotRun('FLOOR_GUARD_TODAY is not a YYYY-MM-DD date');
  let constraintsNow;
  try {
    constraintsNow = readFileSync('CONSTRAINTS.md', 'utf8');
  } catch {
    throw new CannotRun('CONSTRAINTS.md is missing');
  }
  const { blocking, notices } = guard(changes, { mergeBase, today, constraintsNow });
  for (const n of notices) console.log(`floor-guard: note: ${n}`);
  if (blocking.length === 0) {
    console.log('floor-guard: clean');
    return 0;
  }
  console.error(`floor-guard: ${blocking.length} floor violation(s):`);
  for (const f of blocking) console.error(`  [${f.rule}] ${f.file}:${f.line}${f.key ? ` (rule "${f.key}")` : ''}`);
  for (const rule of new Set(blocking.map((f) => f.rule))) if (HINTS[rule]) console.error(`\n${HINTS[rule]}`);
  console.error('\nEach lowers the bar. Fix the code, or add an Exceptions row to CONSTRAINTS.md in this PR (admin approval).');
  console.error('Unfinished work and invalid or expired exceptions can never be waived.');
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

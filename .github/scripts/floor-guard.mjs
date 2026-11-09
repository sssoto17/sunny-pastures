#!/usr/bin/env node
// floor-guard.mjs: diff-scoped enforcement of the CONSTRAINTS.md floor (`guard / floor`, #40).
// Adapted from .agents/skills/constraint-driven-development/references/floor-guard.md; the
// contract is the reference's:
//   - input: the diff from the merge base to the working tree, plus untracked files;
//   - exit codes: 0 clean, 1 floor violation, 2 could not run (a 2 never reads as clean);
//   - it reports the rule and the location, never the matched text;
//   - tightening is silent, loosening is loud: silent means no finding.
// One addition (#122): when CONSTRAINTS.md changes, the change report quotes every changed rule,
// tightenings included, old and new, with the edit marked, in the log, the job summary
// ($GITHUB_STEP_SUMMARY) and warning annotations, and the guard no longer logs `clean`. It quotes
// only CONSTRAINTS.md, a prose file, never code, with key-like text redacted. A possible carve-out
// (a narrowing word, a negation, a new clause, comment, footnote or rule, a rule moved to another
// list) is marked `warning [rule-narrowed]` there: a warning for the admin's merge review, never a
// failure (admin, 9 Nov; ADR-0004).
//
// Usage: node .github/scripts/floor-guard.mjs [--base <ref>]   (default base: origin/main)
// FLOOR_GUARD_TODAY=YYYY-MM-DD overrides today's date (tests only).
//
// A weakened bar (silenced checker, easier test, moved threshold, loosened tool config) passes
// only when the same PR adds an Exceptions row to CONSTRAINTS.md whose Path covers the file.
// Unfinished work and invalid or expired exceptions always fail.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
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
  // Every heading in order, so a caller can tell the first `## Exceptions` from a later one.
  const headings = [];
  let section = '';
  let sectionNo = 0;
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
      sectionNo = headings.push({ no: headings.length + 1, level: /^#+/.exec(line)[0].length, title: section });
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
      else rules.push({ kind: 'row', section, sectionNo, key: cells[0], line: n, end: n, text: line, cells, headers });
      return;
    }
    const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flush();
      // A label before a colon ("**Split size:** …") keys the item; without one it pairs by
      // similarity, like a paragraph, so a comma edit isn't a removed rule.
      const label = /^([^:\n]{1,60}):/.exec(item[1].replace(/\*\*/g, ''));
      cur = { kind: 'item', section, sectionNo, key: label ? label[1].trim() : null, line: n, end: n, text: item[1] };
    } else if (cur && (cur.kind === 'para' || /^\s+\S/.test(line))) {
      cur.text += `\n${line}`;
      cur.end = n;
    } else {
      flush();
      cur = { kind: 'para', section, sectionNo, key: null, line: n, end: n, text: line };
    }
  });
  flush();
  rules.headings = headings;
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
// A rule's numbers. In a table row each cell is read on its own, takes its column's direction
// when its own words give none, and the ratchet "Today" cell is left to compareRule.
const ruleNumbers = (r) => {
  if (r.kind !== 'row') return numbersOf(r.text);
  return r.cells.flatMap((c, i) => {
    const h = r.headers[i] ?? '';
    if (/^today$/i.test(h)) return [];
    const dir = MAX_HEADER.test(h) ? 'max' : null;
    return numbersOf(c).map((x) => ({ ...x, dir: x.dir ?? dir }));
  });
};
const PROSE_HEADER =/why|reason|covers|what is checked|notes?/i;
// Numbers are judged by direction (compareNumbers), so list items compare with them masked.
const norm = (s) => s.replace(/[`*]/g, '').replace(/\d+(\.\d+)*/g, 'N').replace(/\s+/g, ' ').replace(/[.:]+$/, '').trim().toLowerCase();
const ticks = (t) => new Set([...t.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
// A table's list cells: every cell but the key, prose columns and a ratchet's "Today".
const isListCell = (r, i) => i > 0 && !PROSE_HEADER.test(r.headers[i] ?? '') && !/^today$/i.test(r.headers[i] ?? '');
// A list cell's items, split at `,` and `;` only. Splitting at sentence ends too would let a new
// sentence slip in between two items without removing either, so an item appended right before a
// full stop still reads as a removed item and fails (closed).
const segments = (r) => r.cells.flatMap((c, i) => (isListCell(r, i) ? c.split(/[,;]/) : []));
// What a rule lists: backticked tokens, plus the items of a table's list cells.
const listed = (r) => {
  if (r.kind !== 'row') return new Set(ticks(r.text));
  const out = new Set();
  r.cells.forEach((c, i) => {
    if (isListCell(r, i)) for (const t of ticks(c)) out.add(`\`${norm(t)}\``);
  });
  for (const item of segments(r)) if (norm(item)) out.add(norm(item));
  return out;
};
// The items of a row's list cells that are new in `now` and read as a clause: two or more words
// outside code spans ("not tests"). A new item of one word or none ("`structuredClone`", "and
// `queueMicrotask`") is an addition, which tightens (#122). It only warns, so it errs towards
// warning.
const newClauses = (old, now) => {
  if (now.kind !== 'row') return [];
  const was = new Set(segments(old).map(norm));
  return segments(now).filter((s) => !was.has(norm(s)) && (s.replace(/`[^`]*`/g, ' ').match(/[a-z]{2,}/gi) ?? []).length >= 2);
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
// "400 changed lines" (the split size) and "0.5 points" (a ratchet's tolerance) are caps.
const MAX_AFTER = /^\s*\S*\s*(or less|or lower|must not grow|must not exceed|changed lines|points?\b)/;
// A table column whose numbers are caps even without direction words.
const MAX_HEADER = /^(tolerance|budget|limit)$/i;
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
// Words that carve an exception out of a rule (#122). A rule that gains one may be narrowed, even
// when every listed item survives: "…except in X" keeps them all and still lowers the bar. It's a
// warning for the admin, not a failure (admin, 9 Nov): the list is a tripwire, not a parser, and
// the change report shows every changed rule whether it trips or not.
const NARROWING = /\bexcept\w*|\bunless\b|\bbut not\b|\bonly\b|\bmay\b|\bcan also\b|\bother than\b|\bapart from\b|\baside\b|\bbesides\b|\bsave for\b|\bexclud\w*|\bexempt\w*|\ballow\w*|\bpermit\w*|\bwaive\w*|\boptional\w*|\bwarn\w*|\bskip\w*|\bignor\w*|\boutside\b|\bfine\b|\bno longer\b|\bas long as\b|\bprovided that\b|\b(does not|doesn't|do not|don't|need not|needn't) (apply|count)\b/g;
// A negation added or dropped flips a rule ("is blocked" / "is not blocked"), so both directions warn.
const NEGATION = /\b(not|no|never|none|nothing|nor|cannot|can't|mustn't|isn't|aren't|won't)\b/g;
// Code spans are names (`gitleaks:allow`, `istanbul ignore`), so adding one to a list isn't a
// carve-out; a carve-out hidden in one still shows in the change report.
const wordsMatching = (re, text) => text.replace(/`[^`]*`/g, ' ').replace(/[*_]/g, '').replace(/\s+/g, ' ').toLowerCase().match(re) ?? [];
// The matches `b` has more of than `a`, counted (so a rule that already says "only" can keep it).
const surplus = (re, a, b) => {
  const left = wordsMatching(re, a);
  return wordsMatching(re, b).filter((w) => {
    const i = left.indexOf(w);
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
};
// Places to hide text the rendered file doesn't show, or shows somewhere else.
const HIDING = [
  [/<!--/g, 'adds an HTML comment'],
  [/\[\^[^\]\s]+\]/g, 'adds a footnote'],
];
// A rule's clauses: split at `,`, `;` and full stops. Only the warning uses this split; the
// blocking check (listed) splits list cells at `,` and `;` only.
const clausesOf = (t) => t.split(/[,;]|\.(?=\s|$)/).map((s) => s.trim()).filter(Boolean);
const wordCount = (s) => (s.replace(/`[^`]*`/g, ' ').match(/[a-z]{2,}/gi) ?? []).length;
// Clauses of `nowText` that are new: not in `oldText`, and not an edit of an old clause (as similar
// as a reworded paragraph, and not two or more words longer). A typo fix pairs with its old clause;
// "Fixtures are okay." doesn't pair with anything.
const proseClauses = (oldText, nowText) => {
  const was = clausesOf(oldText);
  const is = clausesOf(nowText);
  const wasSet = new Set(was.map(norm));
  const isSet = new Set(is.map(norm));
  const gone = was.filter((c) => !isSet.has(norm(c)));
  return is.filter((c) => {
    if (wasSet.has(norm(c))) return false;
    const i = gone.findIndex((g) => similarity(g, c) >= 0.5 && wordCount(c) - wordCount(g) < 2);
    if (i > -1) {
      gone.splice(i, 1);
      return false;
    }
    return wordCount(c) >= 2;
  });
};
// Why a change from `oldText` to `nowText` may carve out an exception ('' for a new rule).
const narrowingLabels = (oldText, nowText) => [
  ...new Set([
    ...surplus(NARROWING, oldText, nowText).map((w) => `adds "${w}"`),
    ...surplus(NEGATION, oldText, nowText).map((w) => `adds "${w}"`),
    ...surplus(NEGATION, nowText, oldText).map((w) => `drops "${w}"`),
    ...HIDING.filter(([re]) => surplus(re, oldText, nowText).length).map(([, label]) => label),
  ]),
];

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
  // A ratchet's "Today" cell is judged on its own below: "not yet" → a number is its first value.
  const verdict = compareNumbers(ruleNumbers(old), ruleNumbers(now));
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

const keyOf = (r) => r.key ?? `${r.kind === 'item' ? 'list item' : r.kind === 'row' ? 'row' : 'paragraph'} in "${r.section}"`;

// Compares CONSTRAINTS.md at the merge base with the working tree. Returns the findings, and every
// rule that changed, moved, was removed or was added, and every other changed line, for the change
// report (#122). `narrows` lists why a change may carve out an exception (narrowingLabels, new
// clauses, a new rule, a move to another list).
const constraintsFindings = (f, mergeBase) => {
  const out = [];
  const changes = [];
  const before = parseRules(oldContent(mergeBase, f.oldPath ?? f.path) ?? []);
  const after = parseRules(readFileSync(f.path, 'utf8').split('\n'));
  const isException = (r) => r.kind === 'row' && (/^E\d+$/.test(r.key) || r.key === '_none_');
  const taken = new Set();
  const unchanged = new Map(); // after rule → the old rule with the same section and text
  // Pair unchanged rules first, so a changed rule can't pair with one of them.
  const pending = before.filter((old) => {
    const same = after.find((r) => !taken.has(r) && r.section === old.section && r.text === old.text);
    if (same) {
      taken.add(same);
      unchanged.set(same, old);
    }
    return !same;
  });
  for (const old of pending) {
    const key = keyOf(old);
    // Dropping an exception, or the table's `_none_` placeholder, tightens: no finding, but reported.
    if (isException(old)) {
      changes.push({ kind: 'removed', old, key, narrows: [] });
      continue;
    }
    const candidates = after.filter((r) => !taken.has(r) && r.kind === old.kind && r.section === old.section);
    // Same key first; otherwise the most similar rule of the same kind (a reworded paragraph, an
    // item without a label, or one whose label changed).
    let now = old.key === null ? undefined : candidates.find((r) => r.key === old.key);
    if (!now) {
      let best = 0.5;
      for (const r of candidates) {
        const s = similarity(old.text, r.text);
        if (s >= best) [best, now] = [s, r];
      }
    }
    if (!now) {
      out.push({ rule: 'rule-removed', line: `${old.line} (old)`, key });
      changes.push({ kind: 'removed', old, key, narrows: [] });
      continue;
    }
    taken.add(now);
    const clauses = now.kind === 'row' ? newClauses(old, now).length && 'adds a clause to a list cell' : proseClauses(old.text, now.text).length && 'adds a clause';
    changes.push({ kind: 'changed', old, now, key, narrows: [...narrowingLabels(old.text, now.text), ...(clauses ? [clauses] : [])] });
    const verdict = compareRule(old, now);
    if (verdict) out.push({ rule: verdict, line: now.line, key });
  }
  // A new rule has no old text to lose items from, but it can be a carve-out on its own.
  for (const r of after) {
    if (taken.has(r)) continue;
    changes.push({ kind: 'added', now: r, key: keyOf(r), narrows: isException(r) ? [] : ['adds a rule', ...narrowingLabels('', r.text)] });
  }
  // Every other changed line. A line outside any rule (a heading, a table header, an HTML comment,
  // a fence) holds nothing the guard can compare, but it can still tell an agent something. A line
  // of a rule whose text didn't change means the rule moved, perhaps into another list.
  const ruleAt = (rules, n) => rules.find((r) => r.line <= n && n <= r.end);
  const at = (c, side) => (c[side] ? [c[side].line, c[side].end ?? c[side].line] : null);
  const reported = (side, n) => changes.some((c) => at(c, side) && at(c, side)[0] <= n && n <= at(c, side)[1]);
  const moves = new Set();
  for (const a of f.added) {
    if (!a.text.trim() || reported('now', a.line)) continue;
    const r = ruleAt(after, a.line);
    if (r && unchanged.has(r)) moves.add(r);
    else if (!r) changes.push({ kind: 'other', now: { line: a.line, text: a.text }, narrows: ['adds text outside the rules', ...narrowingLabels('', a.text)] });
  }
  for (const d of f.removed) {
    if (!d.text.trim() || reported('old', d.line)) continue;
    const old = ruleAt(before, d.line);
    const now = old && [...unchanged].find(([, o]) => o === old)?.[0];
    if (now) moves.add(now);
    else if (!old) changes.push({ kind: 'other', old: { line: d.line, text: d.text }, narrows: [] });
  }
  for (const now of moves) {
    const old = unchanged.get(now);
    const from = contextOf(before, old);
    const to = contextOf(after, now);
    changes.push({ kind: 'moved', old, now, key: keyOf(now), from, to, narrows: from === to ? [] : [`moves from "${from}" to "${to}"`] });
  }
  changes.sort((a, b) => (a.now ?? a.old).line - (b.now ?? b.old).line);
  return { findings: out, changes };
};

// What a rule sits under: the last sentence of the paragraph that introduces its list ("Also
// blocked, with no exception possible:"), or its section's title.
const contextOf = (rules, r) => {
  const i = rules.indexOf(r);
  for (let k = i - 1; k >= 0 && rules[k].sectionNo === r.sectionNo; k--) {
    if (rules[k].kind === 'para') return flat(rules[k].text).split(/(?<=[.!?])\s+/).pop().slice(-80);
    if (rules[k].kind !== r.kind) break;
  }
  return r.section;
};

// The change report's marks, in git's --word-diff style. Tokens keep their leading space, so
// joining them gives back the text; `,` and `;` are tokens of their own, so "too" stays "too" when
// "; …" is appended to it.
const tokens = (t) => t.replace(/\s+/g, ' ').trim().match(/ ?[,;]| ?[^\s,;]+/g) ?? [];
const wordDiff = (was, now) => {
  const a = tokens(was);
  const b = tokens(now);
  const same = (x, y) => x.trim() === y.trim();
  // Longest common subsequence, filled from the end so the walk below runs forwards.
  const common = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) common[i][j] = same(a[i], b[j]) ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(a[i], b[j])) ops.push(['=', a[i++], b[j++]]);
    else if (j < b.length && (i === a.length || common[i][j + 1] >= common[i + 1][j])) ops.push(['+', null, b[j++]]);
    else ops.push(['-', a[i++], null]);
  }
  // One side: unchanged tokens as they are, its own changed runs wrapped in marks.
  const render = (pick, mark, open, close) => {
    let out = '';
    let run = '';
    const flush = () => {
      if (run) out += `${/^ */.exec(run)[0]}${open}${run.trimStart()}${close}`;
      run = '';
    };
    for (const op of ops) {
      const t = pick(op);
      if (t === null) continue;
      if (op[0] === mark) run += t;
      else {
        flush();
        out += t;
      }
    }
    flush();
    return out.trim();
  };
  return { was: render((op) => op[1], '-', '[-', '-]'), now: render((op) => op[2], '+', '{+', '+}') };
};

const flat = (t) => t.replace(/\s+/g, ' ').trim();
// One entry per changed rule: a heading line, then was/now lines. A changed row shows only the
// cells that changed, each under its column's name.
const reportEntries = (changes) =>
  changes.map((c) => {
    const where = c.now ? `CONSTRAINTS.md:${c.now.line}` : `CONSTRAINTS.md:${c.old.line} (old)`;
    const head = `${c.kind}: ${where} ${c.kind === 'other' ? '(not a rule)' : `(rule "${c.key}")`}`;
    const warn = c.narrows.length ? [`warning [rule-narrowed]: ${c.narrows.join(', ')}; check it isn't a carve-out`] : [];
    if (!c.now) return { c, head, lines: [`was: [-${flat(c.old.text)}-]`] };
    if (!c.old) return { c, head, lines: [...warn, `now: {+${flat(c.now.text)}+}`] };
    if (c.kind === 'moved') return { c, head, lines: [...warn, `from: CONSTRAINTS.md:${c.old.line} (old), under "${c.from}"`, `to: under "${c.to}"`, `text: ${flat(c.now.text)}`] };
    const lines = [...warn];
    if (c.old.kind === 'row' && c.old.cells.length === c.now.cells.length) {
      c.now.cells.forEach((cell, k) => {
        if (cell === c.old.cells[k]) return;
        const d = wordDiff(c.old.cells[k], cell);
        lines.push(`${c.now.headers[k] || `column ${k + 1}`}:`, `  was: ${d.was}`, `  now: ${d.now}`);
      });
    } else {
      const d = wordDiff(c.old.text, c.now.text);
      lines.push(`was: ${d.was}`, `now: ${d.now}`);
    }
    return { c, head, lines };
  });

// Workflow-command data escapes `%`, CR and LF; property values also escape `:` and `,`.
// The report quotes the file, so a key pasted into it would reach the log. Any unbroken run of 24
// or more key-like characters with both a letter and a digit is replaced; this file's own words
// and paths have no such run. gitleaks (`guard / secrets`, #42) is the check meant for secrets.
const KEY_LIKE = /[A-Za-z0-9_+/=-]{24,}/g;
const redact = (s) => s.replace(KEY_LIKE, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) ? '[redacted]' : m));
const MAX_ANNOTATIONS = 10; // GitHub Actions: 10 warning annotations per step (REST docs, check runs)
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// The report of every changed CONSTRAINTS.md rule: for the log, the job summary, and warning
// annotations, which GitHub shows on the PR's Files changed tab next to the changed line.
const changeReport = (changes) => {
  if (!changes.length) return null;
  const entries = reportEntries(changes).map((e) => ({ ...e, head: redact(e.head), lines: e.lines.map(redact) }));
  const narrowed = changes.filter((c) => c.narrows.length).length;
  const intro = `CONSTRAINTS.md: ${changes.length} rule(s) changed${narrowed ? `, ${narrowed} may narrow a rule` : ''}. The admin reads each one at merge (CONSTRAINTS.md, "Guarding the bar"). {+…+} marks added text, [-…-] removed text.`;
  const log = [`floor-guard: ${intro}`, ...entries.flatMap((e) => [`  ${e.head}`, ...e.lines.map((l) => `    ${l}`)])].join('\n');
  // Every entry sits in one fence, longer than any run of tildes or backticks in the text.
  const body = entries.flatMap((e) => [e.head, ...e.lines.map((l) => `  ${l}`), '']).join('\n');
  const fence = '~'.repeat(Math.max(3, ...[...body.matchAll(/~+/g)].map((m) => m[0].length + 1)));
  const summary = `### floor guard: CONSTRAINTS.md changes\n\n${intro}\n\n${fence}text\n${body}${fence}\n`;
  // GitHub keeps only 10 warning annotations per step, so past 10 the last one points to the
  // summary, and the possible narrowings go first.
  const ranked = [...entries.filter((e) => e.c.narrows.length), ...entries.filter((e) => !e.c.narrows.length)];
  const shown = ranked.length > MAX_ANNOTATIONS ? ranked.slice(0, MAX_ANNOTATIONS - 1) : ranked;
  const annotations = shown.map((e) => {
    const line = e.c.now ? `,line=${e.c.now.line}` : '';
    const title = e.c.narrows.length ? 'CONSTRAINTS.md rule may be narrowed (admin reads)' : `CONSTRAINTS.md rule ${e.c.kind}`;
    return `::warning file=CONSTRAINTS.md${line},title=${escapeProp(title)}::${escapeData([e.head, ...e.lines].join('\n'))}`;
  });
  if (shown.length < ranked.length) {
    annotations.push(`::warning file=CONSTRAINTS.md,title=${escapeProp('CONSTRAINTS.md: more changes')}::${ranked.length - shown.length} more changed rules are in the job summary and the guard's log.`);
  }
  return { log, summary, annotations };
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
  const ruleChanges = []; // CONSTRAINTS.md rules that changed, for the change report
  const push = (waivable) => (rule, file, line, key) => findings.push({ rule, file, line, key, waivable });
  const weak = push(true);
  const always = push(false);

  for (const f of changes) {
    if (f.status === 'deleted') {
      if (isTest(f.path)) weak('test-deleted', f.path, 'file');
      continue;
    }
    if (isConstraints(f.path)) {
      const result = constraintsFindings(f, mergeBase);
      for (const c of result.findings) weak(c.rule, f.path, c.line, c.key);
      ruleChanges.push(...result.changes);
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
  // Only the first level-2 `## Exceptions` heading counts; a later or deeper one is ignored.
  const exceptionRows = (lines) => {
    const rules = parseRules(lines);
    const no = rules.headings.find((h) => h.level === 2 && h.title === 'Exceptions')?.no;
    return no ? rules.filter((r) => r.kind === 'row' && r.sectionNo === no && /^E\d+$/.test(r.key)) : [];
  };
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
  return { blocking, notices, report: changeReport(ruleChanges) };
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
  const { blocking, notices, report } = guard(changes, { mergeBase, today, constraintsNow });
  for (const n of notices) console.log(`floor-guard: note: ${n}`);
  if (report) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      // The report quotes text the PR wrote. Inside a stop-commands block with an unguessable
      // token, no line of it can run as a workflow command; the annotations come after the block.
      const token = randomUUID();
      console.log(`::stop-commands::${token}`);
      console.log(report.log);
      console.log(`::${token}::`);
      for (const a of report.annotations) console.log(a);
    } else {
      console.log(report.log);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.summary);
  }
  if (blocking.length === 0) {
    // A changed CONSTRAINTS.md is never reported as clean: the admin still reads it.
    console.log(report ? 'floor-guard: no floor violations; CONSTRAINTS.md changed, so the admin reads the rules above' : 'floor-guard: clean');
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

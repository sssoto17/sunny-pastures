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
// list) is marked there, `warning [rule-narrowed]` for a strong signal and `note [check]` for a
// weak one: for the admin's merge review, never a failure (admin, 9 Nov; ADR-0004).
//
// Usage: node .github/scripts/floor-guard.mjs [--base <ref>]   (default base: origin/main)
// FLOOR_GUARD_TODAY=YYYY-MM-DD overrides today's date, for tests; it's ignored in CI.
//
// A weakened bar (silenced checker, easier test, moved threshold, loosened tool config) passes
// only when the same PR adds an Exceptions row to CONSTRAINTS.md whose Rule names the finding and
// whose Path, one file or one folder, covers the file. Unfinished work and invalid, too broad or
// expired exceptions always fail, and so does a second `## Exceptions` heading.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CannotRun, baseArg, enterRepo, git, oldContent, readChange } from './diff.mjs';

// This file and its tests spell out the suppression and stub patterns, so those two scans skip
// them; every other check still applies. CI runs the base branch's copy of this guard (ci.yml,
// `guard / floor`), so a PR can't switch it off by editing it.
const SELF = new Set(['.github/scripts/floor-guard.mjs', '.github/scripts/floor-guard.test.mjs']);
// A workflow line that runs a check: removing it, or letting the job fail quietly, weakens the bar.
const WORKFLOW = /^\.github\/(workflows|actions)\/.+\.ya?ml$/;
const CHECK_STEP = /floor-guard\.mjs|coverage-gate\.mjs|pnpm (typecheck|lint|test)\b|SIM_PROPERTY_RUNS/;
// The checks a package.json script runs (#99, review of #134). CI runs the PR's own scripts, so a
// script that loses one of these, or skips the ratchet outside `check:task`, is a removed check.
const SCRIPT_LINE = /^\s*"([\w:.-]+)"\s*:\s*"(.*)",?\s*$/;
const CHECK_CMD = /node \S*(?:floor-guard|coverage-gate|typecheck-reach)\.mjs|\btsc -b\b|\beslint\b|\bvitest run\b|pnpm (?:typecheck|lint|test|guard:floor|coverage:gate|check:fast)\b/g;
const scriptChecks = (f) => {
  const hits = [];
  const byKey = (lines) => new Map(lines.map((l) => [SCRIPT_LINE.exec(l.text), l]).filter(([m]) => m).map(([m, l]) => [m[1], { value: m[2], line: l.line }]));
  const was = byKey(f.removed);
  const now = byKey(f.added);
  for (const [key, old] of was) {
    const value = now.get(key)?.value ?? '';
    if ((old.value.match(CHECK_CMD) ?? []).some((cmd) => !value.includes(cmd))) hits.push(`${old.line} (old)`);
  }
  for (const [key, cur] of now) {
    if (key !== 'check:task' && cur.value.includes('--skip-ratchet') && !(was.get(key)?.value ?? '').includes('--skip-ratchet')) hits.push(cur.line);
  }
  return hits;
};
const FREEZE = '2026-12-20'; // CONSTRAINTS.md, Exceptions: never past the feature freeze
const MAX_EXCEPTION_DAYS = 30;

// CONSTRAINTS.md, Floor: the suppression comments.
const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|istanbul ignore|c8 ignore|v8 ignore|Stryker disable|nosemgrep|gitleaks:allow|fallow-ignore[\w-]*|#\s*noqa|#\s*type:\s*ignore/;
const SKIPS = /\.(skip|only|todo|skipIf|runIf)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
// Unfinished work (#99 added the last four): a not-implemented stub, "not yet implemented" and
// "unimplemented" included; an empty `catch`, or one holding only a comment; an empty `.catch`
// callback; a TODO.
// A block comment that doesn't run past its own `*/`, so it can't swallow code between two
// comments (review of #133).
const BLOCK_COMMENT = String.raw`\/\*(?:(?!\*\/).)*\*\/`;
// An arrow or function callback whose body is empty, holds only comments, or returns nothing.
const EMPTY_CALLBACK = String.raw`(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*(?:\{\s*(?:${BLOCK_COMMENT}\s*)*\}|undefined|void 0|null)|(?:async\s+)?function\s*\w*\s*\([^)]*\)\s*\{\s*\}`;
const STUBS = new RegExp(
  [
    String.raw`catch\s*(\([^)]*\))?\s*\{\s*(?:${BLOCK_COMMENT}\s*)*\}`,
    String.raw`\.catch\(\s*(?:${EMPTY_CALLBACK})\s*\)`,
    String.raw`\.then\([^,()]+(?:\([^)]*\))?,\s*(?:${EMPTY_CALLBACK})\s*\)`,
    String.raw`\bTODO\b`,
  ].join('|'),
);
// A stub that throws instead of doing the work: the message starts with "not implemented", "not
// yet implemented" (spaces or hyphens) or "unimplemented", in any case, with or without `new`.
// A `NotImplementedError` is the same stub by name (independent review of #133).
const STUB_THROW = /throw\s+(?:new\s+)?(?:NotImplemented\w*|\w*Error\(\s*['"`]\s*(?:not[\s-]+(?:yet[\s-]+)?implemented|unimplemented)\b)/i;
// Whether the block opened on line `n` (1-based) holds nothing but blanks and comments before its
// closing `}`. The lines are read together, so a block comment may span several of them, and a
// line that opens a comment and then has code (`/* log */ report(e);`) isn't empty (reviews of
// #133).
const emptyBlockAfter = (lines, n) => {
  let text = '';
  for (let i = n; i < lines.length; i++) {
    text += `${lines[i] ?? ''}\n`;
    if (text.lastIndexOf('/*') > text.lastIndexOf('*/')) continue; // inside a block comment
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
    if (code.trim()) return /^\s*\}/.test(code);
  }
  return false;
};
// An ESLint rule turned off or down to a warning: `'rule': 'off'`, `'rule': 0`, `'rule': ['warn', …]`.
const RULE_OFF = /(["'][\w@/-]+["']|\w+)\s*:\s*\[?\s*["'](off|warn)["']|["'][\w@/-]+["']\s*:\s*\[?\s*[01]\b/;
// A `catch` block, or a `.catch` callback, opened at the end of a line (review of #133).
const OPEN_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*$|\.catch\(\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{\s*$/;
const ASSERTION = /\b(expect|assert)\b/;
const ASSERTIONS = /\b(expect|assert)\b/g;
const RUN_COUNT = /\b(numRuns|SIM_PROPERTY_RUNS)\b(?:\D{0,20}?(\d+))?/;
// A line of JS or TS without its comments.
const stripComments = (t) => t.replace(/\/\*(?:(?!\*\/).)*(?:\*\/|$)/g, ' ').replace(/\/\/.*$/, '');
// A property-test run count on a line of code: its key, and its value, or null when it comes from
// a variable (review of #133). Comments neither hold a count nor hide one.
const runCount = (t) => {
  const m = RUN_COUNT.exec(stripComments(t));
  return m ? { key: m[1], n: m[2] === undefined ? null : Number(m[2]) } : null;
};
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
// #138: formatting-only changes in a guarded config count as unchanged, so a formatter (Prettier,
// #125) doesn't need Exceptions rows. Only JS, TS and JSON configs, where quotes and whitespace
// outside strings carry no meaning.
const FORMATTED_CONFIG = /^(eslint\.config\.|vitest\.config\.|tsconfig.*\.json$|\.?fallowrc\.json|stryker\.(conf|config)\.|\.?lighthouserc)/;
// A line's (or a hunk's) code with its formatting removed: whitespace outside strings, `'…'` read
// as `"…"` when it holds no escape and no other quote, and trailing commas. Template literals are
// kept exactly. Null when the text has a `/` outside strings (a regex or a comment, where quotes
// and spaces can matter) or an unclosed string: those lines only pair when they match exactly.
const normalizeCode = (text) => {
  let out = '';
  let i = 0;
  let gap = false; // whitespace was skipped since the last character kept
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      gap = true;
      i++;
      continue;
    }
    // Whitespace between two word characters is a separator, not formatting (`new Foo` isn't
    // `newFoo`), so one space stays. A trailing comma goes only outside strings, here at the
    // closing bracket (doubt pass on #138).
    if (gap && /[\w$]/.test(c) && /[\w$]$/.test(out)) out += ' ';
    gap = false;
    if (/[\]})]/.test(c) && out.endsWith(',')) out = out.slice(0, -1);
    if (c === '/') return null;
    if (c === "'" || c === '"' || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return null;
      const body = text.slice(i + 1, end);
      if (c === '`' || body.includes('\\') || body.includes(c === "'" ? '"' : "'")) out += text.slice(i, end + 1);
      else out += `"${body}"`;
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  // A comma at the very end sits outside any string, since a string ends with its quote.
  return out.endsWith(',') ? out.slice(0, -1) : out;
};
// Removes the removed and added lines of `f` that differ only in formatting. Pairs stay within one
// diff hunk and in order, so a line moved to another block, past lines that stayed, doesn't pair
// (#138). A whole hunk whose normalized text is equal (a re-wrapped list) pairs as one.
const withoutFormatting = (f) => {
  if (!FORMATTED_CONFIG.test(basename(f.path)) || f.status === 'added') return f;
  const key = (t) => normalizeCode(t) ?? `\0${t.trim()}`; // `\0`: an exact match only
  const paired = new Set();
  for (const hunk of new Set([...f.removed, ...f.added].map((l) => l.hunk))) {
    const was = f.removed.filter((l) => l.hunk === hunk);
    const now = f.added.filter((l) => l.hunk === hunk);
    if (!was.length || !now.length) continue;
    const whole = (ls) => normalizeCode(ls.map((l) => l.text).join('\n'));
    if (whole(was) !== null && whole(was) === whole(now)) {
      for (const l of [...was, ...now]) paired.add(l);
      continue;
    }
    // Longest common subsequence of the lines' normalized keys.
    const a = was.map((l) => key(l.text));
    const b = now.map((l) => key(l.text));
    const common = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (a[i] === b[j]) {
        paired.add(was[i++]);
        paired.add(now[j++]);
      } else if (common[i + 1][j] >= common[i][j + 1]) i++;
      else j++;
    }
  }
  return { ...f, removed: f.removed.filter((l) => !paired.has(l)), added: f.added.filter((l) => !paired.has(l)) };
};
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
    // A new tsconfig that neither extends a shared one nor turns `strict` on compiles a package
    // with TypeScript's loose defaults (#99).
    // Its `extends` must name a file that exists (review of #133): `"./nope.json"` or `[]` extends
    // nothing. A package name (`@tsconfig/node20`) isn't resolved here and counts as an extends.
    if (f.status === 'added') {
      // Read without comments, so `// "strict": true` doesn't count (independent review of #133).
      const text = readFileSync(f.path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"])\/\/.*$/gm, '$1');
      const value = /"extends"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/.exec(text)?.[1];
      const targets = value ? [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]) : [];
      const resolves = (t) => t.trim() !== '' && (!/^\.{1,2}\//.test(t) || [t, `${t}.json`].some((p) => existsSync(join(dirname(f.path), p))));
      const extendsReal = targets.length > 0 && targets.every(resolves);
      if (!extendsReal && !/"strict"\s*:\s*true/.test(text)) hits.push(1);
    }
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
// CommonMark 0.31, HTML blocks: type 6 opens with one of these block tags; type 7 is any other
// complete open or closing tag alone on its line. Both end at a blank line.
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCK_6 = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?=[\\s/>]|$)`, 'i');
const HTML_BLOCK_7 = /^ {0,3}(?:<[A-Za-z][\w-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][\w-]*\s*>)\s*$/;
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
  let rawBlock = null;
  let htmlBlock = false;
  let table = null; // the header line of the table being read: { line, text }
  let pending = null; // a possible header row, until the next line shows a delimiter row
  const flush = () => {
    if (cur) rules.push(cur);
    cur = null;
  };
  lines.forEach((line = '', i) => {
    const n = i + 1;
    // HTML comments hold no rules (and no exceptions), and neither do the raw HTML blocks that
    // CommonMark keeps open across blank lines until their closing tag (`<pre>`, `<script>`,
    // `<style>`, `<textarea>`): a table inside one renders as text.
    if (comment || /^\s*<!--/.test(line)) {
      flush();
      comment = !line.includes('-->');
      return;
    }
    if (rawBlock) {
      if (new RegExp(`</${rawBlock}>`, 'i').test(line)) rawBlock = null;
      return;
    }
    const raw = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i.exec(line)?.[1];
    if (raw) {
      flush();
      if (!new RegExp(`</${raw}>`, 'i').test(line)) rawBlock = raw;
      return;
    }
    // CommonMark HTML blocks of types 6 and 7 run until a blank line: one that opens with a block
    // tag (`<details>`, `<div hidden>`), or a complete tag alone on its line, which can't interrupt
    // a paragraph. A table inside one renders as raw text (review of #131).
    if (htmlBlock) {
      if (!line.trim()) htmlBlock = false;
      return;
    }
    if (HTML_BLOCK_6.test(line) || (cur?.kind !== 'para' && HTML_BLOCK_7.test(line))) {
      flush();
      headers = null;
      htmlBlock = true;
      return;
    }
    // Fences and headings follow CommonMark, so the guard reads the file the way it renders (#99:
    // `~~~` fences and look-alike lines hid Exceptions rows). A fence opens with three or more
    // backticks or tildes, indented at most 3 spaces; a backtick opener's info string has no
    // backtick. It closes only on a line of the same character, at least as long, with nothing
    // after it but spaces.
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = false;
      return;
    }
    if (opener && !(opener[1][0] === '`' && opener[2].includes('`'))) {
      flush();
      fence = opener[1];
      return;
    }
    const heading = (level, title) => {
      flush();
      headers = null;
      section = title;
      sectionNo = headings.push({ no: headings.length + 1, level, title: section, line: n });
    };
    // An ATX heading: up to 3 spaces, 1–6 `#`, then a space or the line's end; a closing run of
    // `#` isn't part of the title.
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      heading(atx[1].length, (atx[2] ?? '').replace(/^#+$/, '').trim());
      return;
    }
    // A setext heading: one line of paragraph text underlined with `=` (level 1) or `-` (level 2).
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && cur?.kind === 'para' && !cur.text.includes('\n')) {
      const title = cur.text.trim();
      cur = null;
      heading(setext[1][0] === '=' ? 1 : 2, title);
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
      const delimiter = cells.every((c) => /^:?-+:?$/.test(c));
      // A table starts only where a header row is followed at once by a delimiter row (GFM);
      // without one, the lines are a paragraph and hold no rows (review of #131).
      if (!headers) {
        if (delimiter && pending) {
          headers = pending.cells;
          table = pending.table;
          pending = null;
        } else {
          pending = delimiter ? null : { cells, table: { line: n, text: line } };
        }
        return;
      }
      if (!delimiter) rules.push({ kind: 'row', section, sectionNo, key: cells[0], line: n, end: n, text: line, cells, headers, table });
      return;
    }
    pending = null;
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
const norm = (s) => s.replace(/[`*]/g, '').replace(/(?<![A-Za-z])\d+(\.\d+)*/g, 'N').replace(/\s+/g, ' ').replace(/[.:]+$/, '').trim().toLowerCase();
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
// Words that qualify a unit rather than name it.
const QUALIFIER = /^(changed|new|added|removed|total|more|extra)$/;
const thresholds = (t) => {
  const out = [];
  const re = /\d+(?:\.\d+)?/g;
  let m;
  let last = null; // the previous number with a direction, and where it ended
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    let dir = MIN_BEFORE.test(before) || MIN_AFTER.test(after) ? 'min' : MAX_BEFORE.test(before) || MAX_AFTER.test(after) ? 'max' : null;
    // A number listed right after a capped one shares its direction: in "at most 10 files or 800
    // lines" the 800 is a cap too (#99). Only across a short "or", "and" or comma, in one clause.
    const gap = last ? t.slice(last.end, m.index) : '';
    let via = null;
    if (!dir && last && gap.length <= 30 && !/[.;|]/.test(gap) && /\b(or|and)\b|,/.test(gap)) {
      dir = last.dir;
      via = /\band\b/.test(gap) && !/\bor\b/.test(gap) ? 'and' : 'or';
    }
    if (dir) last = { dir, end: m.index + m[0].length };
    // The unit is the word right after the number ("changed", "files", "%", "ms"), so numbers pair
    // by what they count, not by position (#99).
    // A qualifier ("changed", "new", "total") takes the next word too, so "400 changed lines" and "400
    // changed files" count different things (review of #133).
    const words = /^\s*(%|[a-z]+)(?:\s+([a-z]+))?/.exec(after) ?? [];
    const unit = [words[1], QUALIFIER.test(words[1] ?? '') ? words[2] : null].filter(Boolean).map((w) => w.replace(/s$/, '')).join(' ');
    out.push({ n: Number(m[0]), dir, unit, via });
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
// Why a change from `oldText` to `nowText` may carve out an exception ('' for a new rule). A
// negation only flips a rule that existed: in a new rule it's usually a prohibition, which tightens.
const narrowingLabels = (oldText, nowText) => [
  ...new Set([
    ...surplus(NARROWING, oldText, nowText).map((w) => `adds "${w}"`),
    ...(oldText ? surplus(NEGATION, oldText, nowText).map((w) => `adds "${w}"`) : []),
    ...surplus(NEGATION, nowText, oldText).map((w) => `drops "${w}"`),
    ...HIDING.filter(([re]) => surplus(re, oldText, nowText).length).map(([, label]) => label),
  ]),
];

// Pairs each old number with a new one of the same direction: the same unit first, in order, and
// only then the next unused one, so a rewording that changes the unit still pairs. A new number
// added in front ("under 10 files or 800 changed lines") can't take an old one's place (#99).
const compareNumbers = (was, now) => {
  const capped = was.some((x) => x.dir);
  for (const dir of ['min', 'max', null]) {
    const before = was.filter((x) => x.dir === dir);
    const after = now.filter((x) => x.dir === dir);
    const used = new Set();
    const loosens = (o, n) => n !== o && (dir === 'min' ? n < o : dir === 'max' ? n > o : true);
    // Within one unit, old and new are compared as sorted lists, so reordering a rule's numbers
    // isn't a change ("LCP ≤ 2500 ms, …, TBT ≤ 200 ms", independent review of #133). Caps pair
    // smallest first and floors largest first, so the extra new numbers, the loosest, are left
    // over for the check below.
    const order = (a, b) => (dir === 'min' ? b - a : a - b);
    const unpaired = [];
    for (const unit of new Set(before.map((b) => b.unit))) {
      const olds = before.filter((b) => b.unit === unit).sort((a, b) => order(a.n, b.n));
      const news = after.filter((x) => !used.has(x) && x.unit === unit).sort((a, b) => order(a.n, b.n));
      for (const [i, b] of olds.entries()) {
        const n = news[i];
        if (!n) {
          unpaired.push(b);
          continue;
        }
        used.add(n);
        if (loosens(b.n, n.n)) return dir ? 'threshold-loosened' : 'threshold-changed';
      }
    }
    // An old number with no new one of its unit pairs with the next unused one. Across two named
    // units it now counts something else, so it can't be judged by size ("30 days" becoming "30
    // weeks", review of #133).
    for (const b of unpaired) {
      const n = after.find((x) => !used.has(x));
      if (!n) return 'threshold-removed';
      used.add(n);
      if (b.unit && n.unit && n.unit !== b.unit) return 'threshold-changed';
      if (loosens(b.n, n.n)) return dir ? 'threshold-loosened' : 'threshold-changed';
    }
    // A new number with no direction in a rule that had a cap or a floor can't be judged, so it's a
    // change ("400 changed lines; 900 for docs", #99's own fallback, independent review of #133).
    if (!dir && capped && after.some((x) => !used.has(x) && x.via !== 'and')) return 'threshold-changed';
    // A new number left over in a capped rule is compared only with old numbers of its own unit:
    // looser than all of them is a loosening ("10 changed files or 800 lines" for "400 changed
    // lines"). A cap in a unit the rule didn't use ("≤ 50 ms or 5 s") can't be compared, and a new
    // "or" may let either cap pass, so it counts as a loosening too (security review of #99). Joined
    // with "and", it's a second cap that must also hold, which tightens (review of #133).
    if (dir && before.length) {
      for (const x of after.filter((y) => !used.has(y))) {
        const same = before.filter((b) => b.unit === x.unit).map((b) => b.n);
        if (!same.length && x.via !== 'and') return 'threshold-loosened';
        if (!same.length) continue;
        if (dir === 'max' ? x.n > Math.max(...same) : x.n < Math.min(...same)) return 'threshold-loosened';
      }
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
  const isException = (r) => r.kind === 'row' && (isExceptionId(r.key) || r.key === '_none_');
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
// Two tiers (admin, 9 Nov), so a real carve-out stands out on a PR where most changes trip
// something. Weak reasons are common in honest edits: a new rule or new text, a new clause in prose,
// and everyday words. Every other reason (a move to another list, a carve-out phrase, a negation, a
// hidden comment or footnote, a new clause in a list cell) is strong.
// `warn…` stays strong: "blocked unless" becoming "warned unless" drops a severity.
const WEAK_WORD = /^(only|may|can also|fine|outside|skip\w*)$/;
const WEAK_REASON = new Set(['adds a rule', 'adds text outside the rules', 'adds a clause']);
const isStrong = (reason) => {
  const word = /^adds "(.+)"$/.exec(reason)?.[1];
  return word ? !WEAK_WORD.test(word) : !WEAK_REASON.has(reason);
};
const tierOf = (c) => (c.narrows.some(isStrong) ? 'strong' : c.narrows.length ? 'weak' : null);
// One entry per changed rule: a heading line, then was/now lines. A changed row shows only the
// cells that changed, each under its column's name.
const reportEntries = (changes) =>
  changes.map((c) => {
    const where = c.now ? `CONSTRAINTS.md:${c.now.line}` : `CONSTRAINTS.md:${c.old.line} (old)`;
    const head = `${c.kind}: ${where} ${c.kind === 'other' ? '(not a rule)' : `(rule "${c.key}")`}`;
    const strong = c.narrows.filter(isStrong);
    const weak = c.narrows.filter((r) => !isStrong(r));
    const warn = [
      ...(strong.length ? [`warning [rule-narrowed]: ${strong.join(', ')}; check it isn't a carve-out`] : []),
      ...(weak.length ? [`note [check]: ${weak.join(', ')}`] : []),
    ];
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
  const narrowed = changes.filter((c) => tierOf(c) === 'strong').length;
  const toCheck = changes.filter((c) => tierOf(c) === 'weak').length;
  const counts = [narrowed && `${narrowed} may narrow a rule`, toCheck && `${toCheck} to check`].filter(Boolean);
  const intro = `CONSTRAINTS.md: ${changes.length} rule(s) changed${counts.map((s) => `, ${s}`).join('')}. The admin reads each one at merge (CONSTRAINTS.md, "Guarding the bar"). {+…+} marks added text, [-…-] removed text.`;
  const log = [`floor-guard: ${intro}`, ...entries.flatMap((e) => [`  ${e.head}`, ...e.lines.map((l) => `    ${l}`)])].join('\n');
  // Every entry sits in one fence, longer than any run of tildes or backticks in the text.
  const body = entries.flatMap((e) => [e.head, ...e.lines.map((l) => `  ${l}`), '']).join('\n');
  const fence = '~'.repeat(Math.max(3, ...[...body.matchAll(/~+/g)].map((m) => m[0].length + 1)));
  const summary = `### floor guard: CONSTRAINTS.md changes\n\n${intro}\n\n${fence}text\n${body}${fence}\n`;
  // GitHub keeps only 10 warning annotations per step, so past 10 the last one points to the
  // summary, and the possible narrowings go first, then the ones to check.
  const rank = { strong: 0, weak: 1, null: 2 };
  const ranked = [...entries].sort((a, b) => rank[tierOf(a.c)] - rank[tierOf(b.c)]);
  const shown = ranked.length > MAX_ANNOTATIONS ? ranked.slice(0, MAX_ANNOTATIONS - 1) : ranked;
  const TITLES = { strong: 'CONSTRAINTS.md rule may be narrowed (admin reads)', weak: 'CONSTRAINTS.md rule to check (admin reads)' };
  const annotations = shown.map((e) => {
    const line = e.c.now ? `,line=${e.c.now.line}` : '';
    const title = TITLES[tierOf(e.c)] ?? `CONSTRAINTS.md rule ${e.c.kind}`;
    return `::warning file=CONSTRAINTS.md${line},title=${escapeProp(title)}::${escapeData([e.head, ...e.lines].join('\n'))}`;
  });
  if (shown.length < ranked.length) {
    annotations.push(`::warning file=CONSTRAINTS.md,title=${escapeProp('CONSTRAINTS.md: more changes')}::${ranked.length - shown.length} more changed rules are in the job summary and the guard's log.`);
  }
  return { log, summary, annotations };
};

// Exceptions rows: | ID | Rule | Path | Reason | Owner | Expires |
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// A real calendar day only: `Date.UTC` rolls `2026-11-31` over to 1 Dec, so the result must give
// back the same year, month and day (review of #131).
const utcDay = (y, mo, d) => {
  const t = Date.UTC(y, mo, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo && back.getUTCDate() === d ? t : null;
};
export const parseDate = (s) => {
  const t = s.replace(/[`*_]/g, '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/.exec(t);
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  if (m && month !== undefined) return utcDay(Number(m[3]), month, Number(m[1]));
  return null;
};
// The findings an Exceptions row can waive, by the name its Rule column uses (#99). Unfinished work
// and the exception-* findings are never waivable.
export const WAIVABLE = new Set([
  'silenced-checker', 'test-made-easier', 'test-deleted', 'assertion-removed', 'property-runs-cut',
  'config-loosened', 'check-removed', 'rule-removed', 'rule-narrowed', 'threshold-removed',
  'threshold-loosened', 'threshold-changed', 'severity-dropped', 'stage-moved',
]);
// A Rule cell names one or more findings, as `silenced-checker` or "silenced checker".
const ruleNames = (cell) => cell.split(/[,;]/).map((s) => s.replace(/[`*_]/g, '').trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
// The cells of a row-shaped line: blockquote markers and the outer pipes are optional, as GFM
// renders a row without them (review of #131).
const rowCells = (text) => text.trim().replace(/^(?:>\s*)+/, '').replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
export const parseException = (text) => {
  const cells = rowCells(text);
  return {
    id: exceptionId(cells[0]),
    rules: ruleNames(cells[1] ?? ''),
    path: (cells[2] ?? '').replace(/`/g, ''),
    reason: cells[3] ?? '',
    owner: cells[4] ?? '',
    expires: parseDate(cells[5] ?? ''),
  };
};
// A Path names one file or folder, so its first segment is literal: `**`, `*/**` and `**/*.ts`
// would each waive a rule across the repo.
const tooBroad = (path) => {
  // One file (`packages/sim/src/a.ts`) or one folder (`packages/sim/` or `packages/sim/**`): no
  // wildcard anywhere else, so `packages/*/src/**` and `apps/**/x.ts` fail (security review, #99).
  const folder = path.endsWith('/**') || path.endsWith('/');
  const body = path.replace(/\/\*\*$|\/$/, '');
  if (!body || /[*?[\]{}]/.test(body)) return true;
  // The widest folder is one package or a folder inside it (admin, 9 Nov): a folder needs two
  // segments, so `packages/sim/` passes and `packages/**`, `apps/` and `docs/` don't.
  return folder && body.split('/').filter(Boolean).length < 2;
};
// A Path no file can have: a leading `/`, an empty segment, or a `.` or `..` segment. Paths are
// relative to the repo's top and have none of these.
const neverMatches = (path) => /^\//.test(path) || /\/\//.test(path) || /(^|\/)\.{1,2}(\/|$)/.test(path);
// An Exceptions row's ID, without emphasis: `**E1**` is E1.
// Emphasis only around it: `**E1**` is E1, but `E*1` is no ID at all.
const exceptionId = (cell = '') => cell.trim().replace(/^[*_`]+|[*_`]+$/g, '');
const isExceptionId = (cell) => /^E\d+$/.test(exceptionId(cell ?? ''));
const EXCEPTIONS_HEADER = ['ID', 'Rule', 'Path', 'Reason', 'Owner', 'Expires'].join('|');
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

export const guard = (changes, { mergeBase, today, constraintsNow, dependabot = false }) => {
  const findings = []; // { rule, file, line, key?, waivable }
  const notices = [];
  const ruleChanges = []; // CONSTRAINTS.md rules that changed, for the change report
  const push = (waivable) => (rule, file, line, key) => findings.push({ rule, file, line, key, waivable });
  const weak = push(true);
  const always = push(false);

  for (const f of changes) {
    if (f.status === 'deleted') {
      if (isTest(f.path)) weak('test-deleted', f.path, 'file');
      // A deleted config that held a run count takes it with it (review of #133).
      else if ((oldContent(mergeBase, f.path) ?? []).some(runCount)) weak('property-runs-cut', f.path, 'file');
      continue;
    }
    if (isConstraints(f.path)) {
      const result = constraintsFindings(f, mergeBase);
      for (const c of result.findings) weak(c.rule, f.path, c.line, c.key);
      ruleChanges.push(...result.changes);
    }
    if (isProse(f.path)) continue;
    // The whole new file, read once and only if a check needs lines that weren't added.
    let content;
    const fileLines = () => (content ??= readFileSync(f.path, 'utf8').split('\n'));
    for (const { line, text } of f.added) {
      // Only the suppression and stub scans skip the guard's own files (see SELF).
      if (!SELF.has(f.path)) {
        if (SUPPRESSIONS.test(text)) weak('silenced-checker', f.path, line);
        if (STUBS.test(text) || STUB_THROW.test(text)) always('unfinished-work', f.path, line);
        else if (OPEN_CATCH.test(stripComments(text)) && emptyBlockAfter(fileLines(), line)) always('unfinished-work', f.path, line);
      }
      if (isTest(f.path) && SKIPS.test(text)) weak('test-made-easier', f.path, line);
    }
    if (isTest(f.path)) {
      const count = (ls) => ls.reduce((n, l) => n + (l.text.match(ASSERTIONS)?.length ?? 0), 0);
      if (count(f.removed) > count(f.added)) weak('assertion-removed', f.path, `${f.removed.find((l) => ASSERTION.test(l.text))?.line} (old)`);
    }
    if (basename(f.path) === 'package.json' && f.status !== 'added') for (const line of scriptChecks(f)) weak('check-removed', f.path, line);
    if (WORKFLOW.test(f.path)) {
      const before = f.oldPath ? oldContent(mergeBase, f.oldPath) ?? [] : [];
      const now = readFileSync(f.path, 'utf8').split('\n');
      // A `uses:` line that only moves the same action to another full commit SHA (Dependabot's
      // weekly bump, #69) counts as kept on both sides (#99). Another action, or a tag instead
      // of a SHA, is still a change.
      const pinnedAction = (t) => /^\s*-?\s*uses:\s*([\w.-]+\/[\w./-]+)@[0-9a-f]{40}\s*(#.*)?$/.exec(t)?.[1] ?? null;
      // Dependabot's PRs only (security review of #133): any 40-hex SHA can be an imposter commit
      // from a fork, served under the original repo's name. GITHUB_ACTOR is set by the runner.
      // Bumps pair within one job, and a job counts as bumped for an action only when it removes and
      // adds the same number of its `uses:` lines (review of #133: pairing across the whole file
      // let a bump in one job hide a step deleted from, or added to, the floor job).
      const bumpKey = (lines, l) => (pinnedAction(l.text) ? `${jobOf(lines, l.line)}|${pinnedAction(l.text)}` : null);
      const tally = (ls, lines) => ls.reduce((m, l) => (bumpKey(lines, l) ? m.set(bumpKey(lines, l), (m.get(bumpKey(lines, l)) ?? 0) + 1) : m), new Map());
      const removedPins = tally(f.removed, before);
      const addedPins = tally(f.added, now);
      const bumped = new Set(dependabot ? [...removedPins].filter(([k, n]) => addedPins.get(k) === n).map(([k]) => k) : []);
      const kept = new Set(f.added.map((a) => a.text.trim()));
      const gone = new Set(f.removed.map((r) => r.text.trim()));
      for (const r of f.removed) {
        const guarded = CHECK_STEP.test(r.text) || jobOf(before, r.line) === 'floor';
        const bump = bumped.has(bumpKey(before, r));
        if (guarded && !bump && !kept.has(r.text.trim())) weak('check-removed', f.path, `${r.line} (old)`);
      }
      // A workflow, or a floor job, that didn't exist at the merge base has no bar to lower.
      const hadFloor = before.some((l) => /^ {2}floor:\s*$/.test(l));
      for (const a of f.added) {
        if (f.status === 'added') break;
        // A skipped required job reports as passing, so a new `if:` counts too.
        const loosens = /continue-on-error:\s*true|^\s*-?\s*if:/.test(a.text) || (hadFloor && jobOf(now, a.line) === 'floor');
        if (loosens && !gone.has(a.text.trim()) && !bumped.has(bumpKey(now, a))) weak('check-removed', f.path, a.line);
      }
    }
    // Run counts (#99): the file's counts, old against new, one to one, read from code without its
    // comments. Each old literal needs its own new literal at least as high, and each old count
    // taken from a variable needs one that's still there. A count lowered, deleted (it falls back to
    // a default the guard can't see), or turned from a variable into a literal is a cut (reviews
    // of #133).
    const removedKeys = new Map(f.removed.map((r) => [runCount(r.text)?.key, r]).filter(([k]) => k));
    if (removedKeys.size) {
      const before = (oldContent(mergeBase, f.oldPath ?? f.path) ?? []).map(runCount).filter(Boolean);
      const now = fileLines().map(runCount).filter(Boolean);
      for (const [key, r] of removedKeys) {
        const literals = (cs) => cs.filter((c) => c.key === key && c.n !== null).map((c) => c.n).sort((a, b) => b - a);
        const variables = (cs) => cs.filter((c) => c.key === key && c.n === null).length;
        const was = literals(before);
        const is = literals(now);
        const kept = variables(now) >= variables(before) && is.length >= was.length && was.every((n, i) => is[i] >= n);
        if (!kept) weak('property-runs-cut', f.path, `${r.line} (old)`);
      }
    }
    for (const line of configLoosening(withoutFormatting(f), mergeBase)) weak('config-loosened', f.path, line);
  }

  // Exceptions: added rows waive weak findings on their path; every row must still be valid.
  // Rows come from the parsed Exceptions table only, never from raw diff lines, so a row-shaped
  // line in a code fence, a comment or another table can't waive anything.
  // Only a level-2 `## Exceptions` heading holds waivers, and the file has exactly one: a second
  // one fails (#99), since an earlier empty one once hid the real table. Titles match without case.
  const exceptionRows = (lines) => {
    const rules = parseRules(lines);
    const level2 = rules.headings.filter((h) => h.level === 2 && h.title.toLowerCase() === 'exceptions');
    const no = level2.length === 1 ? level2[0].no : null;
    // Waivers come from one table only: the section's single table with exactly the Exceptions
    // header, written at the left margin, rows included. A table indented into a list item, a second
    // table with that header or a table with another header waives nothing (security review, #131).
    const inSection = rules.filter((r) => r.kind === 'row' && r.sectionNo === no);
    const tables = [...new Set(inSection.filter((r) => r.headers.join('|') === EXCEPTIONS_HEADER && /^\|/.test(r.table.text)).map((r) => r.table))];
    const table = tables.length === 1 ? inSection.filter((r) => r.table === tables[0] && /^\|/.test(r.text)) : [];
    // A row of the table with no E<n> ID (`E*1`, `X1`) would neither waive nor expire: it fails.
    const malformed = table.filter((r) => !isExceptionId(r.key) && r.key !== '_none_');
    return { waiving: table.filter((r) => isExceptionId(r.key)), malformed, repeated: level2.slice(1) };
  };
  // Expiry and validity read every row-shaped line in the file, whatever heading, fence or comment
  // it sits in, so no formatting can hide an expired row from them (review of #99). The ID is read
  // the same way as for a waiver, so no row can waive without being checked (security review).
  const rowLines = (lines) => lines.map((text, i) => ({ line: i + 1, text })).filter((l) => l.text.includes('|') && isExceptionId(rowCells(l.text)[0]));
  const constraints = changes.find((f) => isConstraints(f.path));
  const now = exceptionRows(constraintsNow.split('\n'));
  for (const h of now.repeated) always('exceptions-heading-repeated', 'CONSTRAINTS.md', h.line);
  for (const r of now.malformed) always('exception-invalid', 'CONSTRAINTS.md', r.line, r.key);
  const allNow = rowLines(constraintsNow.split('\n'));
  const before = constraints ? rowLines(oldContent(mergeBase, constraints.oldPath ?? constraints.path) ?? []) : allNow;
  const rowsBefore = new Set(before.map((r) => r.text.trim()));
  const addedRows = now.waiving.filter((r) => !rowsBefore.has(r.text.trim()));
  // An ID used twice in the file fails, every row of it, and neither one waives (review of #131).
  // An ID reused after its row was removed in an earlier PR needs the history: a known limit.
  const ids = allNow.map((r) => ({ line: r.line, id: parseException(r.text).id }));
  const repeatedIds = new Set(ids.filter((x, i) => ids.findIndex((y) => y.id === x.id) !== i).map((x) => x.id));
  for (const x of ids) if (repeatedIds.has(x.id)) always('exception-invalid', 'CONSTRAINTS.md', x.line, x.id);
  // CONSTRAINTS.md asks every row for a reason and an owner.
  for (const r of now.waiving) {
    const e = parseException(r.text);
    if (!e.reason || !e.owner) always('exception-invalid', 'CONSTRAINTS.md', r.line, e.id);
  }
  const waivers = [];
  const latest = Math.min(today + MAX_EXCEPTION_DAYS * 864e5, Date.parse(FREEZE));
  for (const a of addedRows) {
    const e = parseException(a.text);
    // Reported above or below, with every other row: a repeated ID, no reason or owner, a date it
    // can't read, or one already past.
    if (repeatedIds.has(e.id) || !e.reason || !e.owner || e.expires === null || e.expires < today) continue;
    if (!e.path || neverMatches(e.path) || !e.rules.length || e.rules.some((x) => !WAIVABLE.has(x))) always('exception-invalid', 'CONSTRAINTS.md', a.line, e.id);
    else if (tooBroad(e.path)) always('exception-too-broad', 'CONSTRAINTS.md', a.line, e.id);
    else if (e.expires > latest) always('exception-too-long', 'CONSTRAINTS.md', a.line, e.id);
    else {
      waivers.push({ ...e, re: globToRegExp(e.path) });
      notices.push(`new exception ${e.id} on ${e.path} for ${e.rules.join(', ')}`);
    }
  }
  // Every row, new or old: a date the guard can't read would otherwise never expire.
  for (const r of allNow) {
    const e = parseException(r.text);
    if (e.expires === null) always('exception-invalid', 'CONSTRAINTS.md', r.line, e.id);
    else if (e.expires < today) always('exception-expired', 'CONSTRAINTS.md', r.line, e.id);
  }
  const blocking = [];
  for (const f of findings) {
    const w = f.waivable && waivers.find((x) => x.re.test(f.file) && x.rules.includes(f.rule));
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
  // #99: name the real route. `guard / floor` is in ruleset `main checks`, which has no bypass, so
  // the admin's bypass merge (ruleset `main`) can't get a red guard through.
  'check-removed':
    "A workflow step that runs a check was removed, a job was allowed to fail, or the floor job changed. `guard / floor` has no bypass (ruleset `main checks`), so the routes are: keep the step; add an Exceptions row for `check-removed` on the workflow file in this PR (admin approval); or the admin lifts `main checks` for that one merge (ADR-0004). A Dependabot PR that only moves an action's pinned SHA passes on its own.",
};

const main = () => {
  const mergeBase = enterRepo(baseArg(process.argv));
  const changes = readChange(mergeBase);
  // FLOOR_GUARD_TODAY is for tests. In CI the real date always counts (#99), so a workflow edit
  // can't set the clock back on an expired row. Any non-empty GITHUB_ACTIONS or CI but "false" is CI.
  const set = (v) => Boolean(v) && v !== 'false' && v !== '0';
  const inCI = set(process.env.GITHUB_ACTIONS) || set(process.env.CI);
  if (inCI && process.env.FLOOR_GUARD_TODAY) console.log('floor-guard: note: FLOOR_GUARD_TODAY is ignored in CI');
  const todayEnv = inCI ? undefined : process.env.FLOOR_GUARD_TODAY;
  const today = todayEnv ? parseDate(todayEnv) : Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  if (today === null) throw new CannotRun('FLOOR_GUARD_TODAY is not a YYYY-MM-DD date');
  let constraintsNow;
  try {
    constraintsNow = readFileSync('CONSTRAINTS.md', 'utf8');
  } catch {
    throw new CannotRun('CONSTRAINTS.md is missing');
  }
  // Dependabot's PR only when the runner's actor is Dependabot and every commit in the PR is its
  // own: GITHUB_ACTOR is whoever pushed the commit the run is for (security review of #133).
  // The event payload also has to name Dependabot as the PR's author, from a branch of this repo,
  // not a fork (independent review of #133): GITHUB_ACTOR is only the latest event's actor.
  const authors = git(['log', '--no-merges', '--format=%an', `${mergeBase}..HEAD`])?.split('\n').filter(Boolean) ?? ['?'];
  const pullRequest = () => {
    try {
      return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')).pull_request ?? null;
    } catch {
      return null; // no event file: not a Dependabot PR
    }
  };
  const pr = pullRequest();
  const sameRepo = Boolean(pr?.head?.repo?.full_name) && pr.head.repo.full_name === pr.base?.repo?.full_name;
  const dependabot =
    process.env.GITHUB_ACTOR === 'dependabot[bot]' && pr?.user?.login === 'dependabot[bot]' && sameRepo && authors.every((a) => a === 'dependabot[bot]');
  const { blocking, notices, report } = guard(changes, { mergeBase, today, constraintsNow, dependabot });
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

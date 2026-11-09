#!/usr/bin/env node
// typecheck-reach.mjs: every workspace package is type-checked (#99, "Typecheck reach").
// `tsc -b` builds only the projects the root tsconfig.json references, so a package left out of
// `references` was never type-checked and `ci / typecheck` stayed green. This runs after `tsc -b`
// in `pnpm typecheck` (package.json) and fails when a package matched by pnpm-workspace.yaml has no
// tsconfig.json, or isn't referenced from the root.
//
// Usage: node .github/scripts/typecheck-reach.mjs   (from anywhere in the repo)
// Exit codes: 0 every package referenced, 1 a package missed, 2 could not run (never reads as 0).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CannotRun, git } from './diff.mjs';

const top = () => {
  const dir = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!dir) throw new CannotRun('not inside a git work tree');
  return dir;
};

// The `packages:` globs of pnpm-workspace.yaml. Only `dir/*` and plain folders are expanded; any
// other glob can't be checked, so it can't run rather than skip packages.
const workspaceDirs = (root) => {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) throw new CannotRun('pnpm-workspace.yaml is missing');
  const lines = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^packages:\s*(#.*)?$/.test(l));
  if (start === -1) throw new CannotRun('pnpm-workspace.yaml has no packages list');
  // The list runs to the next top-level key. Blank lines and comments sit inside it, and its items
  // may be indented or not (review of #134: the reader stopped at the first of these and passed).
  const globs = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const m = /^\s*-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(l);
    if (m) globs.push(m[1]);
    else if (/^\S/.test(l)) break;
    else throw new CannotRun(`pnpm-workspace.yaml packages line it can't read: ${l.trim()}`);
  }
  if (!globs.length) throw new CannotRun('pnpm-workspace.yaml lists no packages');
  const expand = (glob) => {
    const star = /^([\w.-]+(?:\/[\w.-]+)*)\/\*$/.exec(glob);
    if (star) {
      const dir = join(root, star[1]);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => statSync(join(dir, name)).isDirectory())
        .map((name) => `${star[1]}/${name}`);
    }
    if (/^[\w.-]+(?:\/[\w.-]+)*$/.test(glob)) return [glob];
    throw new CannotRun(`pnpm-workspace.yaml glob it can't expand: ${glob}`);
  };
  // An exclusion (`!packages/old`) takes its folders out of the set.
  const excluded = new Set(globs.filter((g) => g.startsWith('!')).flatMap((g) => expand(g.slice(1))));
  return globs.filter((g) => !g.startsWith('!')).flatMap(expand).filter((d) => !excluded.has(d));
};

// The folders the root tsconfig.json references, as repo-relative paths.
const referenced = (root) => {
  let config;
  try {
    config = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  } catch (e) {
    throw new CannotRun(`can't read the root tsconfig.json as JSON: ${e.message}`);
  }
  // A package counts as referenced through its own tsconfig.json only, as a folder or the file
  // itself: a sibling such as `tsconfig.test.json` builds the tests, not the package (review of
  // #134).
  return new Set(
    (config.references ?? [])
      .map((r) => normalize(r.path).replace(/\/$/, ''))
      .filter((p) => !/\.json$/.test(p) || /(^|\/)tsconfig\.json$/.test(p))
      .map((p) => p.replace(/(^|\/)tsconfig\.json$/, '') || '.'),
  );
};

const main = () => {
  const root = top();
  const refs = referenced(root);
  const missed = [];
  for (const dir of workspaceDirs(root)) {
    if (!existsSync(join(root, dir, 'package.json'))) continue; // not a package
    if (!existsSync(join(root, dir, 'tsconfig.json'))) missed.push(`${dir} has no tsconfig.json`);
    else if (!refs.has(dir)) missed.push(`${dir} is not in the root tsconfig.json references`);
  }
  if (!missed.length) {
    console.log('typecheck-reach: every workspace package is referenced');
    return 0;
  }
  for (const m of missed) console.error(`typecheck-reach: ${m}`);
  console.error('`tsc -b` checks only referenced projects: add the package to `references` in tsconfig.json.');
  return 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`typecheck-reach: cannot run: ${e instanceof CannotRun ? e.message : e?.stack ?? e}`);
    process.exitCode = 2;
  }
}

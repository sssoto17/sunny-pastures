#!/usr/bin/env node
// typecheck-reach.mjs: every workspace package is type-checked (#99, "Typecheck reach").
// `tsc -b` builds only the projects the root tsconfig.json references, so a package left out of
// `references` was never type-checked and `ci / typecheck` stayed green. This runs after `tsc -b`
// in `pnpm typecheck` (package.json) and fails when a package matched by pnpm-workspace.yaml has no
// tsconfig.json, or isn't referenced from the root.
//
// Usage: node .github/scripts/typecheck-reach.mjs   (from anywhere in the repo)
// Exit codes: 0 every package referenced, 1 a package missed, 2 could not run (never reads as 0).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

class CannotRun extends Error {}

const top = () => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new CannotRun('not inside a git work tree');
  }
};

// The `packages:` globs of pnpm-workspace.yaml. Only `dir/*` and plain folders are expanded; any
// other glob can't be checked, so it can't run rather than skip packages.
const workspaceDirs = (root) => {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) throw new CannotRun('pnpm-workspace.yaml is missing');
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start === -1) throw new CannotRun('pnpm-workspace.yaml has no packages list');
  const globs = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(l);
    if (!m) break;
    globs.push(m[1]);
  }
  return globs.flatMap((glob) => {
    if (glob.startsWith('!')) return []; // an exclusion only narrows the set
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
  });
};

// The folders the root tsconfig.json references, as repo-relative paths.
const referenced = (root) => {
  let config;
  try {
    config = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  } catch (e) {
    throw new CannotRun(`can't read the root tsconfig.json as JSON: ${e.message}`);
  }
  return new Set(
    (config.references ?? []).map((r) => {
      const p = normalize(r.path).replace(/\/$/, '');
      return /\.json$/.test(p) ? p.replace(/\/[^/]+$/, '') : p;
    }),
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

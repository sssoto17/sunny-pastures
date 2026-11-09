import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo } from './test-repo.mjs';

const SCRIPT = fileURLToPath(new URL('../typecheck-reach.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const WORKSPACE = 'packages:\n  - apps/*\n  - packages/*\n';
const solution = (refs) => `${JSON.stringify({ files: [], references: refs.map((path) => ({ path })) }, null, 2)}\n`;
const pkg = (dir) => ({ [`${dir}/package.json`]: '{}\n', [`${dir}/tsconfig.json`]: '{ "extends": "../../tsconfig.base.json" }\n' });

let repo;
afterEach(() => repo?.cleanup());

// #99, "Typecheck reach": `tsc -b` builds only what the root tsconfig references, so a workspace
// package left out of `references` was never type-checked and `ci / typecheck` stayed green.
describe('typecheck reach', () => {
  it('passes when every workspace package is referenced', () => {
    repo = makeRepo({ 'pnpm-workspace.yaml': WORKSPACE, 'tsconfig.json': solution(['./packages/sim', './apps/web/tsconfig.json']), ...pkg('packages/sim'), ...pkg('apps/web') });
    expect(repo.run(SCRIPT)).toMatchObject({ code: 0 });
  });

  it('fails a package missing from the root references', () => {
    repo = makeRepo({ 'pnpm-workspace.yaml': WORKSPACE, 'tsconfig.json': solution(['./packages/sim']), ...pkg('packages/sim'), ...pkg('apps/web') });
    const r = repo.run(SCRIPT);
    expect(r.code).toBe(1);
    expect(r.out).toContain('apps/web is not in the root tsconfig.json references');
  });

  it('fails a package with no tsconfig.json', () => {
    repo = makeRepo({ 'pnpm-workspace.yaml': WORKSPACE, 'tsconfig.json': solution(['./packages/sim']), ...pkg('packages/sim'), 'packages/raw/package.json': '{}\n' });
    const r = repo.run(SCRIPT);
    expect(r.code).toBe(1);
    expect(r.out).toContain('packages/raw has no tsconfig.json');
  });

  // Review of #134: the list reader stopped at the first line it didn't expect, and passed.
  it.each([
    ['a blank line between items', 'packages:\n  - packages/*\n\n  - apps/*\n'],
    ['a comment between items', 'packages:\n  - packages/*\n  # the app\n  - apps/*\n'],
    ['an unindented list', 'packages:\n- packages/*\n- apps/*\n'],
  ])('reads a workspace list with %s', (_, workspace) => {
    repo = makeRepo({ 'pnpm-workspace.yaml': workspace, 'tsconfig.json': solution(['./packages/sim']), ...pkg('packages/sim'), ...pkg('apps/web') });
    const r = repo.run(SCRIPT);
    expect(r.code).toBe(1);
    expect(r.out).toContain('apps/web is not in the root tsconfig.json references');
  });

  it('applies an exclusion glob', () => {
    repo = makeRepo({ 'pnpm-workspace.yaml': `${WORKSPACE}  - "!packages/raw"\n`, 'tsconfig.json': solution(['./packages/sim']), ...pkg('packages/sim'), 'packages/raw/package.json': '{}\n' });
    expect(repo.run(SCRIPT).code).toBe(0);
  });

  it.each(['./packages/sim/tsconfig.test.json', './packages/sim/package.json'])('counts a package as referenced only through its own tsconfig.json, not %s', (ref) => {
    repo = makeRepo({ 'pnpm-workspace.yaml': WORKSPACE, 'tsconfig.json': solution([ref]), ...pkg('packages/sim') });
    expect(repo.run(SCRIPT).code).toBe(1);
  });

  it('ignores a folder without a package.json', () => {
    repo = makeRepo({ 'pnpm-workspace.yaml': WORKSPACE, 'tsconfig.json': solution(['./packages/sim']), ...pkg('packages/sim'), 'packages/notes/README.md': 'x\n' });
    expect(repo.run(SCRIPT).code).toBe(0);
  });

  it.each([
    ['a workspace glob it cannot expand', { 'pnpm-workspace.yaml': 'packages:\n  - "packages/**"\n', 'tsconfig.json': solution([]) }],
    ['a root tsconfig it cannot read', { 'pnpm-workspace.yaml': WORKSPACE, 'tsconfig.json': '{ not json' }],
    ['no workspace file', { 'tsconfig.json': solution([]) }],
    ['an empty packages list', { 'pnpm-workspace.yaml': 'packages:\n\nminimumReleaseAge: 1\n', 'tsconfig.json': solution([]) }],
  ])('exits 2, never 0, on %s', (_, files) => {
    repo = makeRepo(files);
    expect(repo.run(SCRIPT).code).toBe(2);
  });

  it('passes on this repo', () => {
    const r = spawnSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

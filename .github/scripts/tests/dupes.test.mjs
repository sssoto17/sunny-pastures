// The duplication check (CONSTRAINTS.md, duplication row; ADR-0005, section 3): the real `dupes`
// script and .fallowrc.jsonc, run against throwaway repos, fail a copied helper (#125).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { root } from './lint-snippet.mjs';
import { makeRepo } from './test-repo.mjs';

const FALLOW = join(root, 'node_modules/.bin/fallow');
const CONFIG = readFileSync(join(root, '.fallowrc.jsonc'), 'utf8');
const [tool, ...SCRIPT_ARGS] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.dupes.split(' ');

// A helper well over the minimum size: 8 lines, about 90 tokens.
const helper = (name) => `export function ${name}(value: unknown, path: string): string[] {
  const found: string[] = [];
  if (typeof value === 'number' && !Number.isSafeInteger(value)) found.push(\`\${path} is unsafe\`);
  else if (Array.isArray(value)) value.forEach((item, i) => found.push(...${name}(item, \`\${path}[\${String(i)}]\`)));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) found.push(...${name}(item, \`\${path}.\${key}\`));
  }
  return found;
}
`;

describe('fallow dupes', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  const dupes = () => {
    expect(tool).toBe('fallow');
    const r = spawnSync(FALLOW, [...SCRIPT_ARGS, '--changed-since', 'main'], { cwd: repo.dir, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const base = (files = {}) => (repo = makeRepo({ '.fallowrc.jsonc': CONFIG, 'packages/sim/src/state/index.ts': helper('unsafeNumbers'), ...files }));

  it('passes a change with no copies', () => {
    base();
    repo.write({ 'packages/sim/src/hash/index.ts': 'export const answer = 42;\n' });
    expect(dupes().code).toBe(0);
  });

  it('fails a helper copied into another module', () => {
    base();
    repo.write({ 'packages/sim/src/plots/index.ts': helper('unsafeNumbers') });
    const r = dupes();
    expect(r.code).toBe(1);
    expect(r.out).toContain('packages/sim/src/plots/index.ts');
  });

  it('fails a helper copied between test files, which Fallow skips by default', () => {
    base();
    repo.write({ 'packages/sim/src/plots/tests/a.test.ts': helper('walk'), 'packages/sim/src/plots/tests/b.test.ts': helper('walk') });
    expect(dupes().code).toBe(1);
  });

  it('passes the same shape with other names: the same rule, not the same shape, is a clone', () => {
    base();
    const renamed = helper('badNumbers').replaceAll('found', 'seen').replaceAll('value', 'node').replaceAll('item', 'child');
    repo.write({ 'packages/sim/src/plots/index.ts': renamed });
    expect(dupes().code).toBe(0);
  });

  it('reports only clones in changed files', () => {
    base({ 'packages/sim/src/plots/index.ts': helper('unsafeNumbers') });
    repo.write({ 'packages/sim/src/hash/index.ts': 'export const answer = 42;\n' });
    expect(dupes().code).toBe(0);
  });
});

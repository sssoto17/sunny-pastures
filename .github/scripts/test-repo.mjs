// Test helper: a throwaway git repo with a `main` commit and a working branch, for running the
// guard scripts end to end. Used by floor-guard.test.mjs and coverage-gate.test.mjs.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const GIT_OPTS = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export const makeRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'));
  const git = (...args) => execFileSync('git', [...GIT_OPTS, ...args], { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  const write = (entries) => {
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  git('init', '-q', '-b', 'main');
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'work');
  const commit = () => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'change');
  };
  // Under Actions the test run itself has GITHUB_ACTIONS, GITHUB_STEP_SUMMARY and CI set. The
  // scripts under test must not inherit them: they'd write the fixtures' reports into the real job
  // summary, and the guard ignores FLOOR_GUARD_TODAY in CI, which the date tests rely on. A test
  // that needs them passes them in `env`.
  const run = (script, args = [], env = {}) => {
    const base = args.includes('--base') ? [] : ['--base', 'main'];
    const outer = { ...process.env };
    delete outer.GITHUB_ACTIONS;
    delete outer.GITHUB_STEP_SUMMARY;
    delete outer.CI;
    const r = spawnSync('node', [script, ...base, ...args], {
      cwd: dir,
      env: { ...outer, ...GIT_ENV, ...env },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, git, write, commit, run, cleanup };
};

// Reads the change a PR makes: the diff from the merge base to the working tree, plus untracked
// files. Shared by floor-guard.mjs and coverage-gate.mjs. Adapted from the floor-guard reference
// (.agents/skills/constraint-driven-development/references/floor-guard.md, "Contract").
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';

// Thrown when the change can't be read. Callers exit 2, which must never read as clean.
export class CannotRun extends Error {}

// `git diff --no-index` exits 1 whenever the two sides differ, which is the normal case for a new
// file, so that output is kept. Any other failure is null, and null never reads as clean.
export const git = (args, { diffExit = false } = {}) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    return diffExit && e.status === 1 && typeof e.stdout === 'string' ? e.stdout : null;
  }
};

export const baseArg = (argv) => {
  const i = argv.indexOf('--base');
  return i > -1 && argv[i + 1] ? argv[i + 1] : 'origin/main';
};

// Changes the working directory to the top of the work tree and returns the merge base. `git
// ls-files` is relative to the current directory, so a script started in a subfolder would miss
// untracked files elsewhere.
export const enterRepo = (base) => {
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!top) throw new CannotRun('not inside a git work tree');
  process.chdir(top);
  const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
  if (!mergeBase) throw new CannotRun(`no merge base against ${base} (shallow clone or missing ref?)`);
  return mergeBase;
};

// Parses a unified diff with --unified=0 into one entry per file. Line numbers come from the hunk
// headers: `removed` lines carry their number in the old file, `added` lines in the new one.
// `---` and `+++` are headers only between a file's `diff` line and its first `@@`; inside a hunk
// an added `++i` (shown as `+++i`) is content.
export const parseDiff = (text) => {
  const files = [];
  const pathOf = (s) => (s === '/dev/null' ? null : s.replace(/^[ab]\//, ''));
  let cur = null;
  let inHeader = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff ')) {
      // `diff --git a/x b/x` names the file even when no ---/+++ follows (an empty new file).
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? null, oldPath: m?.[1] ?? null, added: [], removed: [] };
      files.push(cur);
      inHeader = true;
    } else if (!cur) {
      continue;
    } else if (line.startsWith('@@')) {
      inHeader = false;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new CannotRun('unreadable hunk header');
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
    } else if (inHeader) {
      if (line.startsWith('new file mode')) cur.oldPath = null;
      else if (line.startsWith('deleted file mode')) cur.path = null;
      else if (line.startsWith('--- ')) cur.oldPath = pathOf(line.slice(4));
      else if (line.startsWith('+++ ')) cur.path = pathOf(line.slice(4));
      else if (line.startsWith('rename from ')) cur.oldPath = line.slice(12);
      else if (line.startsWith('rename to ')) cur.path = line.slice(10);
    } else if (line.startsWith('+')) {
      cur.added.push({ line: newLine++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      cur.removed.push({ line: oldLine++, text: line.slice(1) });
    }
  }
  for (const f of files) {
    f.status = f.path === null ? 'deleted' : f.oldPath === null ? 'added' : f.oldPath !== f.path ? 'renamed' : 'modified';
    if (f.path === null) f.path = f.oldPath;
  }
  return files;
};

// The whole change: tracked files with git's rename detection (-M), then untracked files as
// additions. An untracked file with the same content as a deleted tracked file is a rename too
// (a plain `mv` that isn't staged yet).
export const readChange = (mergeBase) => {
  const tracked = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', mergeBase, '--']);
  if (tracked === null) throw new CannotRun(`could not diff against ${mergeBase}`);
  const files = parseDiff(tracked);
  const list = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (list === null) throw new CannotRun('could not list untracked files');
  for (const f of list.split('\0').filter(Boolean)) {
    // Only regular files and symlinks have content to diff. Device nodes appear when a sandbox
    // mounts /dev/null over protected paths (docs/agents/sandbox.md, "Phantom files").
    const st = lstatSync(f, { throwIfNoEntry: false });
    if (!st?.isFile() && !st?.isSymbolicLink()) continue;
    const d =git(['diff', '--no-index', '--unified=0', '--no-color', '/dev/null', f], { diffExit: true });
    if (d === null) throw new CannotRun(`could not diff untracked file ${f}`);
    const [entry] = parseDiff(d);
    if (!entry) continue; // an empty file has no diff at all
    Object.assign(entry, { path: f, oldPath: null, status: 'added' });
    const hash = git(['hash-object', f])?.trim();
    const gone = files.find((x) => x.status === 'deleted' && git(['rev-parse', `${mergeBase}:${x.path}`])?.trim() === hash);
    if (gone) {
      files.splice(files.indexOf(gone), 1);
      files.push({ path: f, oldPath: gone.path, status: 'renamed', added: [], removed: [] });
    } else {
      files.push(entry);
    }
  }
  return files;
};

// A file's content at the merge base, as lines (index 0 is line 1). Null when it didn't exist.
export const oldContent = (mergeBase, path) => git(['show', `${mergeBase}:${path}`])?.split('\n') ?? null;

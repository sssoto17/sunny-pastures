---
status: proposed
---

# Guarding the main folder: effect checks behind a parsed denylist

The main folder stays on `main` and belongs to the coordinating session; lane work happens in
worktrees (AGENTS.md). #75's guards (PR #115) enforce that from a command's text, with a
hand-written shell lexer (`.claude/hooks/lib/shell-lexer.sh`). Every review round of #115 found new
spellings that slipped through (`[[ (a)]] && git commit …; echo ]]`, `$'…'` quotes, `xargs sed -i`,
`python3`, `curl -o`, `prettier --write`), because bash's syntax is too large to denylist by hand.
The admin merged #115 as a stopgap on 9 Nov and asked for a sturdier design. This ADR records it.

## How this was decided

Grilled with the admin on 21 Nov 2026, one question per turn, in
[Design: guard the main folder by effects, an allowlist or a parser](https://github.com/sssoto17/sunny-pastures/issues/118).
Sections 1 to 7 cite the questions they settle; Q12 chose this ADR as the record (with a pointer
from ADR-0002, area 2), and Q13 the build split in Consequences. PR #461's review (21 Nov) added the
`HEAD` ancestry rule, the `PostToolUseFailure` registration, the hashed snapshot and the named gaps.

## 1. Two layers: effect checks are the guard, a denylist runs in front (Q1, Q4)

- **The effect check is the guard.** It looks at what a main-folder command did, not at how it was
  spelled, so no spelling slips through and nothing needs parsing (section 3).
- **A denylist runs in front of it, over a parsed syntax tree** (section 2). It keeps today's rules
  (`sed -i`, redirects into the repo, `git commit`, branch switches and so on) and blocks the common
  writes before they run, so the session reverts less. A spelling the list doesn't know is not a bug
  to chase: the effect check catches the write.
- **The file tools** (Edit, Write, MultiEdit, NotebookEdit) keep #115's path check: their path is a
  plain JSON field.

Not chosen: an **allowlist** (deny by default, allow known command shapes). It prevents every
spelling, but the coordinator's real commands (`gh … | jq`, heredocs, loops, `node -e`,
`( cd wt && … )`) would bring false denies until it is tuned, and the tuning never ends. With the
effect check behind the denylist, an allowlist's extra prevention buys little.

## 2. The parser: `sh-syntax` now, the hand lexer goes (Q2, Q3, Q5)

- **The parser comes in now**, in this work, not on a later trigger (admin, 21 Nov).
- **`sh-syntax`** (npm, [un-ts/sh-syntax](https://github.com/un-ts/sh-syntax), MIT) is mvdan/sh, the
  canonical Go bash parser behind `shfmt`, compiled to WASM. It is a root devDependency, pinned
  exactly at the newest version past `minimumReleaseAge` when #120 is built (0.8.7 of 15 Nov clears
  it from 22 Nov). Checked 21 Nov: no runtime dependencies, no install scripts, about 4.2 MB
  unpacked, releases every few days in November, and `go.mod` tracks mvdan/sh v3.14.1. The admin
  approved the dependency in the grill (Q5).
- **The dialect is bash.** The Bash tool runs the user's shell, which is zsh on the admin's machine,
  and mvdan/sh parses bash, POSIX and mksh, not zsh. Commands are parsed as bash; zsh-only syntax
  (glob qualifiers such as `*(.)`, `${(f)…}` flags, `=(…)`) doesn't parse and is denied as
  unparsable (section 5). Agents already write bash-compatible commands, and the hooks themselves
  are bash.
- **One Node process parses each Bash call once**, and every guard reads that one tree: a single
  dispatcher hook whose guards are functions in the same Node module, not one Node start per guard
  (Q14).
- **The hand lexer is deleted** once its four users are ported (`block-coordinator-work.sh`,
  `block-branch-switch.sh`, `block-thread-resolve.sh`, `after-edit.sh`). Its other helpers move:

  <!-- prettier-ignore -->
  | Helper | Goes to |
  | --- | --- |
  | `remote_session`, `in_worktree` | the dispatcher (the same env and path checks, in Node); a bash copy stays only for a hook that isn't on the dispatcher |
  | `normalize_path`, `resolve_path` | the dispatcher, on Node's `path` module |
  | `parse_git_args` | the dispatcher, reading git's global options (`-C`, `-c`, `--git-dir`) from the tree's arguments |
  | `json_field` | a small `lib/json-field.sh`, kept only while a bash hook (`after-edit.sh`) still reads hook JSON with it |

Not chosen:

<!-- prettier-ignore -->
| Alternative | Why not |
| --- | --- |
| The `shfmt` binary (v3.14.1, `--to-json`) | Needs a new install path in every local and cloud session and in CI, network at session start, and the 7-day rule checked by hand. `sh-syntax` reuses `pnpm install`, its pin, integrity hash and `minimumReleaseAge`. |
| `mvdan-sh` on npm | Deprecated, last release May 2022. |
| `bash-parser` (npm), `bashlex` (PyPI) | Last releases 2017 and 2023, incomplete. |
| Keep the hand lexer, frozen | Agreed in Q2 while the parser was deferred; superseded once Q3 brought the parser in now. |

## 3. The effect check (Q7, Q8)

After each Bash call whose cwd is the main folder:

- **What counts as a change:**
  - a tracked file modified, staged or deleted;
  - an untracked file that git doesn't ignore (`git status --porcelain --untracked-files=all`);
  - the branch isn't `main`, or `HEAD` is detached;
  - `HEAD` isn't `origin/main` or an ancestor of it
    (`git merge-base --is-ancestor HEAD refs/remotes/origin/main` fails). `git pull --ff-only` after
    a fetch passes; a local commit on `main` by any route (`git commit`, `git cherry-pick`,
    `git revert`, `git am`, `git commit-tree` plus `update-ref`) does not, whatever the git hooks
    saw.

  Ignored paths (`.scratch/`, `.remember/`, `node_modules/`, `.claude/worktrees/`) never show;
  anything that legitimately lives in the main folder goes in `.gitignore`.

- **A delta, not an absolute:** a `PreToolUse` step records the status lines, a content hash of each
  dirty path (`git hash-object`), the branch and `HEAD` in `$TMPDIR`, keyed on the tool-call id. The
  post step reports only what that one command changed. Hashing the dirty paths means a second write
  to a path that was already dirty still shows. A hand edit by the admin or an inherited dirty tree
  makes no noise.
- **Both outcomes are checked:** the post step is registered on `PostToolUse` **and**
  `PostToolUseFailure`, since a Bash call that exits non-zero fires only the second
  ([hooks docs](https://code.claude.com/docs/en/hooks), checked 21 Nov). Without it,
  `echo x > apps/web/a.ts; false` would go unseen and the next snapshot would take the write in as
  its baseline. `PostToolUse` reports with exit 2; `PostToolUseFailure` can't block, so it reports
  through `additionalContext`.
- **It reports, never reverts:** the message lists the changed paths, so the session reverts its own
  write. The hook never runs `git restore` or `git clean`: it could wipe the admin's edits or a file
  the command didn't make.
- Worktree sessions, cloud sessions and CI runs are exempt, as with #115.
- **Known gaps:**
  - a `run_in_background` command writes after its post step has run, so its writes are seen by no
    one and become the next call's baseline;
  - a cancelled (interrupted) call fires neither post event, with the same result;
  - writes outside the main folder's repo (another worktree, `$HOME`) are not its business.

## 4. Git hooks stop commits on `main` (Q9)

- A tracked `.githooks/` folder holds `pre-commit` and `pre-merge-commit`; both refuse while the
  branch is `main`, so `git commit` and a non-fast-forward `git merge` on `main` are stopped before
  they write.
- They don't see every route to a commit: `git cherry-pick`, `git revert`, `git am` and plumbing
  (`commit-tree`, `update-ref`) don't run `pre-commit`. Those are caught afterwards by section 3's
  ancestry rule, and the `main` ruleset stops any push.
- The admin sets `core.hooksPath=.githooks` once, outside the sandbox (it protects `.git/config`),
  with a tested script in `scripts/setup/`. Nothing used `.git/hooks/` before (only the samples), so
  this disables nothing. The setting is shared by every worktree; worktrees are never on `main`, so
  it only bites in the main folder. Cloud and CI clones don't have it; the `main` ruleset stops a
  stray push there.
- `--no-verify` skips these hooks. The global rules forbid it, and the denylist denies
  `git commit --no-verify` / `git commit -n` and `git merge --no-verify` in the main folder.
  (`git merge -n` means `--no-stat`, so it is allowed.)

## 5. When the parser can't help (Q6)

Each guard fails in the direction its backstop allows:

<!-- prettier-ignore -->
| Case | Main-folder guards (`block-coordinator-work`, `block-branch-switch`) | `block-thread-resolve` |
| --- | --- | --- |
| Parser missing (no `node_modules` yet, broken install) | Let the call through with a loud stderr warning. The effect check is plain git and still runs, so writes into the main folder are still reported, and `pnpm install` is never blocked. It doesn't back everything: a top-level `cd` into a worktree (the branch guard's rule) and writes into other worktrees (`.claude/worktrees/` is ignored) go unguarded until the parser is back. | Deny a command that mentions GraphQL or the resolve mutation; let others through. Nothing stands behind this guard (a resolve is a remote effect with no local trace), and it runs in remote sessions too. |
| The command doesn't parse as bash (section 2) | Deny: bash would most likely reject it too. | Deny. |

## 6. Where it lives (Q10)

Built here now. The guards lean on this repo's layout (the main folder and worktree convention,
`.scratch/`, `.remember/`, the `pnpm` install that ships `sh-syntax`). An `idea` issue,
sssoto17/agent-workflow#102, proposes extracting them once the design has run for a while, with the
repo-specific parts as configuration.

## 7. Other tools that guard or check commands (Q11)

<!-- prettier-ignore -->
| Tool | Verdict |
| --- | --- |
| `block-branch-switch.sh` | Ported to the parser in #120 (the lexer's deletion needs it). |
| `block-thread-resolve.sh` | Ported in #120, with section 5's fail-closed rule. |
| `after-edit.sh` (#111) | Uses the lib only for its JSON reader; moves with the lexer's deletion in #120. |
| #269, a guard on sandboxed `git pull` / `merge` / `rebase` that touch `.claude/` | Not built yet: built as a guard on #120's dispatcher, reading the git subcommand and its arguments from the tree. Blocked by #120. |
| #316, `redirect-cli.sh` (wrong-CLI redirects, destructive git) | Not built yet, and planned on the hand lexer: rewritten to be a guard on #120's dispatcher. Its `--no-verify` permission rules stay, since they apply in every session, while section 4's denylist rule covers the main folder only. Blocked by #120. |
| `block-secret-paste.sh` | No change: it scans prompt text, not commands, and a pasted secret has no file effect. |
| `scripts/after-merge.sh` (#77) | No change: it already checks effects (`git status`, mounts) before it acts. |
| #109's `/today` read-only guard | Moot: `/today` is user-scoped now (`~/.claude/skills/today/`). |

No new refactor issues are filed: the two planned guards are existing issues, rewritten.

## Patterns

<!-- prettier-ignore -->
| Pattern | Where | Why |
| --- | --- | --- |
| Defence in depth (layered guards) | parsed denylist → effect check → git hooks → `main` ruleset | Each layer catches what the one before misses; no single layer has to be complete. |
| Chain of Responsibility | the dispatcher hands one parsed tree to each guard in turn; the first deny stops the call | Guards stay small and independent, and the parse happens once. |
| Snapshot and compare (memento) | `PreToolUse` records status, hashes and `HEAD`; the post steps diff them | Judges a command by its effect, and only by its own effect. |
| Parse, don't validate | guards read a typed syntax tree from mvdan/sh, not raw text | Quoting, grouping and expansion are the parser's problem, not each guard's. |
| Fail-safe defaults, per layer | section 5 | Fail open only where a backstop exists; fail closed where none does. |

## Consequences

- **#119 builds sections 3 and 4:** the `PreToolUse` snapshot, the post step on `PostToolUse` and
  `PostToolUseFailure` with the ancestry rule and hashed dirty paths, the `.githooks/` hooks and the
  `scripts/setup/` script with its test. It needs no parser, so it starts when this ADR merges,
  alongside #120.
- **#120 builds sections 2 and 5:** `sh-syntax`, the dispatcher, the four ports to the parsed
  denylist (with the `--no-verify` rules), the helpers' new homes, and the lexer's deletion. Likely
  over the split size, so a stack: (1) the dependency and parse script, (2) the coordinator and
  branch guards, (3) thread-resolve, after-edit and deleting the lexer.
- **#269 and #316 build on #120's dispatcher** and wait for it.
- **A time budget (Q14):** all `PreToolUse`, `PostToolUse` and `PostToolUseFailure` hooks together
  add at most 300 ms per Bash call. #120 adds the `CONSTRAINTS.md` row with a timing test in
  `ci / scripts`.
- **`.claude/` is code-owned**, so the build PRs carry `review:admin`.
- **The admin runs one setup step** (`core.hooksPath`) after #119 merges.

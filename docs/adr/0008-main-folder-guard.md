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
The sections below follow the questions (Q1–Q14).

## 1. Two layers: effect checks are the guard, a denylist runs in front (Q1, Q4)

- **The effect check is the guard.** It looks at what a main-folder command did, not at how it was
  spelled, so no spelling slips through and nothing needs parsing (section 3).
- **A denylist runs in front of it, over a parsed syntax tree** (section 2). It keeps today's rules
  (`sed -i`, redirects into the repo, `git commit`, branch switches and so on) and blocks the common
  writes before they run, so the session reverts less. A spelling the list doesn't know is not a bug
  to chase: the effect check catches the write.
- **The file tools** (Edit, Write) keep #115's path check: their path is a plain JSON field.

Not chosen: an **allowlist** (deny by default, allow known command shapes). It prevents every
spelling, but the coordinator's real commands (`gh … | jq`, heredocs, loops, `node -e`,
`( cd wt && … )`) would bring false denies until it is tuned, and the tuning never ends. With the
effect check behind the denylist, an allowlist's extra prevention buys little.

## 2. The parser: `sh-syntax` now, the hand lexer goes (Q2, Q3, Q5)

- **The parser comes in now**, in this work, not on a later trigger (admin, 21 Nov).
- **`sh-syntax`** (npm, [un-ts/sh-syntax](https://github.com/un-ts/sh-syntax), MIT) is mvdan/sh, the
  canonical Go bash parser behind `shfmt`, compiled to WASM. It is a root devDependency, pinned
  exactly at the newest version past `minimumReleaseAge` when #120 is built (0.8.7 of 15 Nov is too
  new on 21 Nov). Checked 21 Nov: no runtime dependencies, no install scripts, about 4.2 MB
  unpacked, releases every few days in November, and `go.mod` tracks mvdan/sh v3.14.1. The admin
  approved the dependency in the grill (Q5).
- **One Node process parses each Bash call once**, and every guard reads that one tree: a single
  dispatcher hook, not one Node start per guard (Q14).
- **The hand lexer is deleted** once its four users are ported (`block-coordinator-work.sh`,
  `block-branch-switch.sh`, `block-thread-resolve.sh`, `after-edit.sh`). The small JSON reader in
  the same lib stays only if a hook still needs it.

Not chosen:

| Alternative                               | Why not                                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `shfmt` binary (v3.14.1, `--to-json`) | Needs a new install path in every local and cloud session and in CI, network at session start, and the 7-day rule checked by hand. `sh-syntax` reuses `pnpm install`, its pin, integrity hash and `minimumReleaseAge`. |
| `mvdan-sh` on npm                         | Deprecated, last release May 2022.                                                                                                                                                                                     |
| `bash-parser` (npm), `bashlex` (PyPI)     | Last releases 2017 and 2023, incomplete.                                                                                                                                                                               |
| Keep the hand lexer, frozen               | Agreed in Q2 while the parser was deferred; superseded once Q3 brought the parser in now.                                                                                                                              |

## 3. The effect check (Q7, Q8)

After each Bash call whose cwd is the main folder:

- **What counts as a change:** a tracked file modified, staged or deleted; an untracked file that
  git doesn't ignore (`git status --porcelain --untracked-files=all`); or the branch isn't `main` or
  `HEAD` is detached. `HEAD` moving forward on `main` (`git pull --ff-only`) is not a change.
  Ignored paths (`.scratch/`, `.remember/`, `node_modules/`) never show; anything that legitimately
  lives in the main folder goes in `.gitignore`.
- **A delta, not an absolute:** a `PreToolUse` step records `git status` and the branch in
  `$TMPDIR`, keyed on the tool-call id; `PostToolUse` reports only what that one command changed. A
  hand edit by the admin or an inherited dirty tree makes no noise.
- **It reports, never reverts:** exit 2 with the changed paths, so the session reverts its own
  write. The hook never runs `git restore` or `git clean`: it could wipe the admin's edits or a file
  the command didn't make.
- Worktree sessions, cloud sessions and CI runs are exempt, as with #115.

## 4. Git hooks stop commits on `main` (Q9)

- A tracked `.githooks/` folder holds `pre-commit` and `pre-merge-commit`; both refuse while the
  branch is `main`, so a non-fast-forward `git merge` on `main` is stopped too.
- The admin sets `core.hooksPath=.githooks` once, outside the sandbox (it protects `.git/config`),
  with a tested script in `scripts/setup/`. Nothing used `.git/hooks/` before (only the samples), so
  this disables nothing. The setting is shared by every worktree; worktrees are never on `main`, so
  it only bites in the main folder. Cloud and CI clones don't have it; the `main` ruleset stops a
  stray push there.
- `--no-verify` skips these hooks. The global rules forbid it, and the denylist denies `git commit`
  / `git merge` with `--no-verify` or `-n` in the main folder.

## 5. When the parser can't help (Q6)

Each guard fails in the direction its backstop allows:

| Case                                                   | Main-folder guards (`block-coordinator-work`, `block-branch-switch`)                                                            | `block-thread-resolve`                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parser missing (no `node_modules` yet, broken install) | Let the call through with a loud stderr warning: the effect check is plain git and still runs. `pnpm install` is never blocked. | Deny a command that mentions GraphQL or `resolveReviewThread`; let others through. Nothing stands behind this guard (a resolve is a remote effect with no local trace), and it runs in remote sessions too. |
| The command doesn't parse                              | Deny: bash would most likely reject it too.                                                                                     | Deny.                                                                                                                                                                                                       |

## 6. Where it lives (Q10)

Built here now. The guards lean on this repo's layout (the main folder and worktree convention,
`.scratch/`, `.remember/`, the `pnpm` install that ships `sh-syntax`). An `idea` issue in
`sssoto17/agent-workflow` proposes extracting them once the design has run for a while, with the
repo-specific parts as configuration.

## 7. Other tools that guard or check commands (Q11)

| Tool                            | Verdict                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `block-branch-switch.sh`        | Ported to the parser in #120 (the lexer's deletion needs it).                          |
| `block-thread-resolve.sh`       | Ported in #120, with section 5's fail-closed rule.                                     |
| `after-edit.sh` (#111)          | Uses the lib only for its JSON reader; moves with the lexer's deletion in #120.        |
| `block-secret-paste.sh`         | No change: it scans prompt text, not commands, and a pasted secret has no file effect. |
| `scripts/after-merge.sh` (#77)  | No change: it already checks effects (`git status`, mounts) before it acts.            |
| #109's `/today` read-only guard | Moot: `/today` is user-scoped now (`~/.claude/skills/today/`).                         |

So no separate refactor issues are filed.

## Patterns

<!-- prettier-ignore -->
| Pattern | Where | Why |
| --- | --- | --- |
| Defence in depth (layered guards) | parsed denylist → effect check → git hooks → `main` ruleset | Each layer catches what the one before misses; no single layer has to be complete. |
| Chain of Responsibility | the dispatcher hands one parsed tree to each guard in turn; the first deny stops the call | Guards stay small and independent, and the parse happens once. |
| Snapshot and compare (memento) | `PreToolUse` records `git status`, `PostToolUse` diffs it | Judges a command by its effect, and only by its own effect. |
| Parse, don't validate | guards read a typed syntax tree from mvdan/sh, not raw text | Quoting, grouping and expansion are the parser's problem, not each guard's. |
| Fail-safe defaults, per layer | section 5 | Fail open only where a backstop exists; fail closed where none does. |

## Consequences

- **#119 builds sections 3 and 4:** the `PreToolUse` snapshot and `PostToolUse` delta report, the
  `.githooks/` hooks and the `scripts/setup/` script with its test. It needs no parser, so it starts
  when this ADR merges, alongside #120.
- **#120 builds sections 2 and 5:** `sh-syntax`, the dispatcher, the four ports to the parsed
  denylist (with the `--no-verify` rule), and the lexer's deletion. Likely over the split size, so a
  stack: (1) the dependency and parse script, (2) the coordinator and branch guards, (3)
  thread-resolve, after-edit and deleting the lexer.
- **A time budget (Q14):** all `PreToolUse` and `PostToolUse` hooks together add at most 300 ms per
  Bash call. #120 adds the `CONSTRAINTS.md` row with a timing test in `ci / scripts`.
- **`.claude/` is code-owned**, so both build PRs carry `review:admin`.
- **The admin runs one setup step** (`core.hooksPath`) after #119 merges.

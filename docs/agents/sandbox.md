# Sandbox pitfalls

Claude Code runs each Bash command in its own sandbox (bubblewrap on WSL2). Each pitfall below was
hit in this repo, and each comes with the way around it. Commands that need the host go outside
the sandbox: say which restriction blocks them, then retry with the sandbox disabled.

Last checked: 2026-11-12.

## Command shape

Write each Bash call so a rule in `.claude/settings.json` can match it, or it prompts (#205):

- No `cd … &&` prefix, in a subshell or not: run from the session's working directory and use
  absolute paths. `git -C <dir> …` matches no allow rule yet, so it still prompts.
- Run checks with `pnpm check:fast`, `pnpm check:task`, `pnpm test`, `pnpm lint` or
  `pnpm typecheck`, not `pnpm vitest`, `pnpm exec` or `pnpm -s eslint`/`tsc` directly.
- Prefer a script under `scripts/` over a one-off loop or heredoc; one you'll repeat becomes one.

## Must run outside the sandbox

| What | Symptom inside the sandbox | Why |
|---|---|---|
| Git commands that write `.git/config` or `.git/hooks`: `git push -u` / `--set-upstream`, `git worktree add` from a remote branch with tracking, `git remote set-url`, `gh pr checkout` | `could not lock config file` | The sandbox protects `.git/config` and `.git/hooks`, so a session can't plant a hook or a `core.fsmonitor` program. Avoid these commands rather than leaving the sandbox; see "Git inside the sandbox". |
| Every bare `supabase` command, even `supabase --version` | `EROFS: read-only file system` | The CLI writes telemetry to `~/.supabase`, and home is read-only. `HOME=$TMPDIR supabase …` also works. The `pnpm db:*` scripts and `pnpm supabase:check` run outside the sandbox on their own (`sandbox.excludedCommands` in `.claude/settings.json`). |
| Anything that connects to a service on the host: local Postgres (55322), the Supabase API (55321), a spike server started in an earlier command | `Connection refused` | The sandbox has its own network namespace, so `127.0.0.1` inside it isn't the host's loopback. Checked on 6 Nov: port 55322 refused inside, open outside. |
| Reading `.env`, `.env.local`, `.env.*.local`, `.env.production`, `~/.ssh`, `~/.aws` | Empty file or permission denied | These paths are read-denied, so `node --env-file=.env` sees nothing. Pass `DATABASE_URL` in the environment, or run the command outside. |

A server and the client that calls it work inside the sandbox only when they run in the same
command (for example, start the server in the background, run the curl, then kill the server).
Across commands, run both outside.

## Git inside the sandbox

Sandboxed commands can write `.git`: objects, refs, the index and `.git/worktrees`, including a
worktree's shared `.git`. Only `.git/config` and `.git/hooks` are protected (checked 7 Nov with
`test -w`, and by `git worktree add` run inside the sandbox). So `git add`, `commit`, `fetch`,
`switch`, `merge`, `worktree add` and `push` all run sandboxed. Don't add
`dangerouslyDisableSandbox` to `git` or `gh`, except for the cases under "When git does need the
host" below. These habits keep `.git/config` out of it:

- Create worktrees without tracking: `git worktree add --no-track -b <branch>
  .claude/worktrees/<N>-<slug> origin/main`.
- Push with `git push origin <branch>`, never `-u`. `gh pr create --head <branch>` doesn't need
  an upstream.
- Don't run `gh pr checkout` or `git remote set-url`. Read a PR's files with `git show
  origin/<branch>:<path>` or `gh api`.

### When git does need the host

Each case below was hit on 7 or 8 Nov. After a merge, `scripts/after-merge.sh <worktree>` (#77)
handles all three: it checks before changing anything, and when a step needs the host it
stops and prints the command to run outside the sandbox. No sandbox setting fixes these (checked
12 Nov, #205): `sandbox.filesystem.allowWrite` can't lift the built-in protection on `.git/config`,
`.git/hooks` or `.claude/` (<https://code.claude.com/docs/en/sandboxing>), and a mount point can't
be deleted.

- **Updating the main folder when the change touches `.claude/settings.json`, hooks or skills**
  (`git merge --ff-only`, `git pull`). Those paths are write-denied in the main folder, so git
  updates the other files, then stops with "unable to unlink". That leaves a half-applied
  checkout: `HEAD` hasn't moved, but the files it already wrote show as modified. Recover by
  restoring them (`git restore <paths>`), then run the update outside the sandbox. To know
  beforehand, run `git diff --name-only HEAD origin/main -- .claude/`: if it lists any of those
  paths, run the update outside from the start.
- **`git worktree remove`.** On 8 Nov (#71 cleanup) it refused, because the sandbox's `/dev/null`
  placeholders (`.bashrc`, `.mcp.json`, `.claude/*` and so on; see "Phantom files" below) showed
  as untracked files in the worktree. `git worktree remove --force` deregistered the worktree,
  but deleting the folder failed with "Device or resource busy" (the placeholder mounts), and
  the lane finished outside with `rm -rf` and `git worktree prune`. The same "Device or resource
  busy" on `.git/worktrees/<name>` was seen on 7 Nov: from a main-folder session the sandbox
  mounts that whole admin folder read-only, and bind-mounts the real `commondir` and
  `config.worktree` in it read-only too (seen 9 Nov). A mount point can't be deleted. So expect worktree removal to need the host. Don't `--force` past
  placeholders: a mount can hide a real file at the same path (an uncommitted
  `.claude/commands/x.md`, say), which `rm -rf` would then delete. Remove the worktree from
  outside the sandbox, where `git status` shows what's really there. `after-merge.sh` reads
  `/proc/self/mountinfo` first: with any mount in the worktree or its admin folder, or any
  placeholder, it stops before changing anything and prints one command to run outside.
- **`git branch -D`** always tries to drop the branch's `branch.<name>` section from
  `.git/config`, so inside the sandbox it warns "could not lock config file .git/config". The
  warning is harmless: the ref is deleted. A branch created with `--no-track` (above) has no
  such section, so nothing is left behind (seen 8 Nov, #90 cleanup). A branch with upstream
  tracking leaves a stale `branch.<name>` entry, which is also harmless.

## Phantom files in `git status`

Inside the sandbox, the repo root shows untracked entries that aren't real: `.bashrc`, `.zshrc`,
`.profile`, `.gitconfig`, `.gitmodules`, `.env`, `.mcp.json`, `.idea`, `.vscode`, several
`.claude/*` paths and so on. They are `/dev/null` placeholders the sandbox mounts over protected
paths. They don't exist on disk outside the sandbox.

They can be told apart from real files reliably: each is a character device with `/dev/null`'s
numbers (`stat -c '%F %t:%T'` prints `character special file 1:3`) and a mount point (listed in
`/proc/self/mountinfo` with source `/null`). Git never checks out a device and making one needs
root, so no real work looks like that. Some sit on ignored paths (`.env`, `.env.local`,
`.env.production`, ignored by `.env*`), so `git status` shows them only with `--ignored`; one
is under `.git` (`config.lock`). They appear in the folder the session works in, not in other
worktrees' folders (checked 9 Nov, #77, from a lane session).

Not placeholders, but also mount points: protected real files and folders the sandbox mounts
read-only, such as `.claude/settings.json`, `.claude/hooks/`, and from a main-folder session each
worktree's `.git/worktrees/<name>/` with its `commondir` and `config.worktree`. These are regular
files, not devices. Like placeholders, they can't be deleted from inside the sandbox.

- Stage files by name (`git add docs/x.md`), never `git add -A` or `git add .`.
- Don't delete them or add them to `.gitignore`.

## Paths you can't write

- Writable: the current folder and `$TMPDIR`. Use `$TMPDIR` for scratch files, not `/tmp`.
- In the main folder, `.claude/hooks/block-coordinator-work.sh` (#75) denies the coordinating
  session's file tools and common shell writes (redirects, `sed -i`, `cp`, `mv`, `rm` and the
  like) on repo files outside `.scratch/` and `.remember/`. Paths outside the repo and removing
  a merged worktree stay allowed. It and the branch guard skip remote sessions
  (`CLAUDE_CODE_REMOTE=true` or `GITHUB_ACTIONS=true`), which have no main folder.
- Never writable from a session: the main folder's `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/hooks/` and `.claude/skills/`, and everything under
  `~/.claude/`. Changes there are the admin's. A worktree's copies can be edited, and they reach
  `main` only through a PR the admin merges; edits to them ask first (`.claude/settings.json`).

## Permission rules

`.claude/settings.json` sets the repo's `permissions` (allow, ask, deny) and `sandbox` keys (#50).
Read-only `gh` and `git` commands, the writes AGENTS.md allows, the `pnpm` checks and
`scripts/today-gather.sh` run without a prompt.
Merging, closing issues, moving an issue to Ready or Factory, repo settings and a bare
`git push` ask first. Reading `.env*`, commands that print secrets, force pushes and pushes to
`main` are denied. Bash rules match the command text, so they're guidance, not a security
boundary. The sandbox and the hooks are what enforce.

## Working directory

`cd` in a Bash command carries over to the next command. If a session `cd`s into another
worktree, it keeps working there. The coordinating session must stay in the main folder, so
use absolute paths, or `git -C <path>` (which prompts), to look into a worktree.
`.claude/hooks/block-branch-switch.sh` blocks a top-level `cd` into `.claude/worktrees/` from the
main folder. A session that owns a worktree enters it with the worktree tool before its first
edit. That moves the session's working directory into the worktree, where `cd` is allowed.

## Secrets in output

The admin pastes terminal output back into sessions (see the rule in `AGENTS.md`). Commands that
print credentials, and what to use instead:

| Prints secrets | Use instead |
|---|---|
| `supabase start` (keys, S3 credentials, DB URL with password) | `pnpm db:start` |
| `supabase status` | `pnpm db:status`; `pnpm db:env` writes `DATABASE_URL` to `.env` without echoing it |
| `env`, `printenv`, `cat .env` (denied by permission rules) | `test -n "${NAME:+x}" && echo set` to check a variable is set |

As a backstop, a `UserPromptSubmit` hook (`.claude/hooks/block-secret-paste.sh`, registered in
`.claude/settings.json`) refuses any prompt that contains a key, a token or a database URL with a
password, before the session reads it. When you add a secret format, add its pattern there.

The Supabase CLI writes these values to stderr as well as stdout, so `> /dev/null` or a `| sed`
filter on stdout still leaks them. Capture both streams (`2>&1`) before filtering, as
`supabase/db.sh` does.

## GitHub

- `git push` can fail with `fatal error in commit_refs` (5 Nov; it cleared after about an hour).
  Create the commit through the GitHub API instead: `git/trees` → `git/commits` → update the ref.
- If an issue linked to the Project disappears from the board, delete its Project item and add it
  again with its fields. Don't change the Status field's options (names, descriptions) through the
  API: it replaces the options and wipes every item's status. That edit is for the admin, in the UI.

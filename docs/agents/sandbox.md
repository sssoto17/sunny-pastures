# Sandbox pitfalls

Claude Code runs each Bash command in its own sandbox (bubblewrap on WSL2). Each pitfall below was
hit in this repo, and each comes with the way around it. Commands that need the host go outside
the sandbox: say which restriction blocks them, then retry with the sandbox disabled.

Last checked: 2026-11-07.

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
`switch`, `merge`, `worktree add/remove` and `push` all run sandboxed. Don't add
`dangerouslyDisableSandbox` to `git` or `gh`. These habits keep `.git/config` out of it:

- Create worktrees without tracking: `git worktree add --no-track -b <branch>
  .claude/worktrees/<N>-<slug> origin/main`.
- Push with `git push origin <branch>`, never `-u`. `gh pr create --head <branch>` doesn't need
  an upstream.
- Don't run `gh pr checkout` or `git remote set-url`. Read a PR's files with `git show
  origin/<branch>:<path>` or `gh api`.

## Phantom files in `git status`

Inside the sandbox, the repo root shows untracked entries that aren't real: `.bashrc`, `.zshrc`,
`.profile`, `.gitconfig`, `.gitmodules`, `.env`, `.mcp.json`, `.idea`, `.vscode`, several
`.claude/*` paths and so on. They are `/dev/null` placeholders the sandbox mounts over protected
paths. They don't exist on disk outside the sandbox.

- Stage files by name (`git add docs/x.md`), never `git add -A` or `git add .`.
- Don't delete them or add them to `.gitignore`.

## Paths you can't write

- Writable: the current folder and `$TMPDIR`. Use `$TMPDIR` for scratch files, not `/tmp`.
- Never writable from a session: the main folder's `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/hooks/` and `.claude/skills/`, and everything under
  `~/.claude/`. Changes there are the admin's. A worktree's copies can be edited, and they reach
  `main` only through a PR the admin merges; edits to them ask first (`.claude/settings.json`).

## Permission rules

`.claude/settings.json` sets the repo's `permissions` (allow, ask, deny) and `sandbox` keys (#50).
Read-only `gh` and `git` commands and the writes AGENTS.md allows run without a prompt.
Merging, closing issues, moving an issue to Ready or Factory, repo settings and a bare
`git push` ask first. Reading `.env*`, commands that print secrets, force pushes and pushes to
`main` are denied. Bash rules match the command text, so they're guidance, not a security
boundary. The sandbox and the hooks are what enforce.

## Working directory

`cd` in a Bash command carries over to the next command. If a session `cd`s into another
worktree, it keeps working there. The coordinating session must stay in the main folder, so
use `git -C <path>`, a subshell `( cd <path> && … )` or absolute paths to look into a worktree.
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

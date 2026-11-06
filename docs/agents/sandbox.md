# Sandbox pitfalls

Claude Code runs each Bash command in its own sandbox (bubblewrap on WSL2). Each pitfall below was
hit in this repo, and each comes with the way around it. Commands that need the host go outside
the sandbox: say which restriction blocks them, then retry with the sandbox disabled.

Last checked: 2026-11-06.

## Must run outside the sandbox

| What | Symptom inside the sandbox | Why |
|---|---|---|
| `.git` writes: commit, push, `git worktree add/remove` | Permission errors; `warning: unable to access '.gitmodules'` | `.git` and some repo-root paths aren't writable. |
| Every `supabase` command, even `supabase --version` | `EROFS: read-only file system` | The CLI writes telemetry to `~/.supabase`, and home is read-only. `HOME=$TMPDIR supabase …` also works. |
| Anything that connects to a service on the host: local Postgres (55322), the Supabase API (55321), a spike server started in an earlier command | `Connection refused` | The sandbox has its own network namespace, so `127.0.0.1` inside it isn't the host's loopback. Checked on 6 Nov: port 55322 refused inside, open outside. |
| Reading `.env`, `.env.local`, `.env.*.local`, `.env.production`, `~/.ssh`, `~/.aws` | Empty file or permission denied | These paths are read-denied, so `node --env-file=.env` sees nothing. Pass `DATABASE_URL` in the environment, or run the command outside. |

A server and the client that calls it work inside the sandbox only when they run in the same
command (for example, start the server in the background, run the curl, then kill the server).
Across commands, run both outside.

## Phantom files in `git status`

Inside the sandbox, the repo root shows untracked entries that aren't real: `.bashrc`, `.zshrc`,
`.profile`, `.gitconfig`, `.gitmodules`, `.env`, `.mcp.json`, `.idea`, `.vscode`, several
`.claude/*` paths and so on. They are `/dev/null` placeholders the sandbox mounts over protected
paths. They don't exist on disk outside the sandbox.

- Stage files by name (`git add docs/x.md`), never `git add -A` or `git add .`.
- Don't delete them or add them to `.gitignore`.

## Paths you can't write

- Writable: the current folder and `$TMPDIR`. Use `$TMPDIR` for scratch files, not `/tmp`.
- Never writable from a session: `.claude/settings.json`, `.claude/settings.local.json`,
  `.claude/hooks/`, `.claude/skills/`, and everything under `~/.claude/`. Changes there are the
  admin's: propose the change and let the admin make it.

## Working directory

`cd` in a Bash command carries over to the next command. If a session `cd`s into another
worktree, it keeps working there. The coordinating session must stay in the main folder, so
use `git -C <path>`, a subshell `( cd <path> && … )` or absolute paths to look into a worktree.

## Secrets in output

The admin pastes terminal output back into sessions (see the rule in `AGENTS.md`). Commands that
print credentials, and what to use instead:

| Prints secrets | Use instead |
|---|---|
| `supabase start` (keys, S3 credentials, DB URL with password) | `pnpm db:start` |
| `supabase status` | `pnpm db:status`; `pnpm db:env` writes `DATABASE_URL` to `.env` without echoing it |
| `env`, `printenv`, `cat .env` | `printenv NAME \| wc -c` to check a variable is set |

The Supabase CLI writes these values to stderr as well as stdout, so `> /dev/null` or a `| sed`
filter on stdout still leaks them. Capture both streams (`2>&1`) before filtering, as
`supabase/db.sh` does.

## GitHub

- `git push` can fail with `fatal error in commit_refs` (5 Nov; it cleared after about an hour).
  Create the commit through the GitHub API instead: `git/trees` → `git/commits` → update the ref.
- If an issue linked to the Project disappears from the board, delete its Project item and add it
  again with its fields. Don't change the Status field's options (names, descriptions) through the
  API: it replaces the options and wipes every item's status. That edit is for the admin, in the UI.

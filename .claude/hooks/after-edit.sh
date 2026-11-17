#!/usr/bin/env bash
# PostToolUse hook on Edit, Write and MultiEdit: the after-edit check (#111). It runs
# `pnpm check:fast` in the repo the session works in (its worktree, from the cwd), so a broken
# edit is reported before the agent's next step. When the edited file is Markdown inside that
# repo, Prettier formats it first (#344; ADR-0005, section 6), so a wrap or spacing nit is fixed in
# the file and never reaches a review. It calls node_modules/.bin/prettier directly: through
# `pnpm exec` each run took 0.25-0.4 s longer (#231, section 5). Prettier skips what
# .prettierignore and .gitignore list, so `.claude/`, `.agents/` and `.scratch/` stay as written.
# `check:fast` keeps its own glob, without Markdown, for its 5 s budget; `format:md` checks all
# Markdown in `check:task` and CI.
# Exit 0 passes; 2 blocks and stderr goes back to the session; 1 (pnpm missing) is reported as a
# hook error. A repo without node_modules (not installed yet) is skipped. Reads the raw hook JSON
# on stdin, so it needs no jq. Tests: after-edit.test.sh next to this file.
set -uo pipefail
# Without the lib the hook exits 1: Claude Code reports the error and the edit stands.
# shellcheck source-path=SCRIPTDIR source=lib/shell-lexer.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/shell-lexer.sh" || exit 1

input=$(cat)

root=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$root" && [[ -d node_modules ]] || exit 0
command -v pnpm >/dev/null || {
  echo "check:fast skipped: pnpm not on PATH" >&2
  exit 1
}

file=$(json_field file_path) || file=""
if [[ $file == *.md && $file == "$root"/* && -f $file ]]; then
  node_modules/.bin/prettier --write --log-level warn "$file" >&2 || {
    echo "prettier couldn't format $file; check:fast not run" >&2
    exit 2
  }
fi

pnpm --silent check:fast >&2 || exit 2

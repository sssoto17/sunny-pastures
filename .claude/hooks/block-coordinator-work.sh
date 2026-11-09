#!/usr/bin/env bash
# PreToolUse hook: keep the coordinating session at the coordination level (#75). When the
# session's cwd is the main folder (not inside .claude/worktrees/<name>), it denies
# Edit/Write/MultiEdit/NotebookEdit on repo paths outside .scratch/ and .remember/, including
# another session's worktree. Paths outside the repo (session memory, the scratchpad) stay
# writable. Worktree sessions are unaffected. Exit 2 blocks the tool call and stderr goes back to
# the session. Reads the raw hook JSON on stdin, so it needs no jq; shared parts are in
# lib/shell-lexer.sh. Tests: block-coordinator-work.test.sh next to this file.
set -uo pipefail
# shellcheck source-path=SCRIPTDIR source=lib/shell-lexer.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/shell-lexer.sh" || exit 1

input=$(cat)

cwd=$(json_field cwd) || exit 0
in_worktree "$cwd" && exit 0
tool=$(json_field tool_name) || exit 0

deny_edit() {
  cat >&2 <<EOF
Blocked: the coordinating session (cwd in the main folder) doesn't edit repo files: $1
It briefs, dispatches, reviews, relays and keeps the board (AGENTS.md). Write a brief in .scratch/
and hand the work to a lane, which enters its own worktree with the worktree tool. From the main
folder, .scratch/, .remember/ and paths outside the repo stay writable.
EOF
  exit 2
}

# The repo the session was started in: the main folder.
root=${CLAUDE_PROJECT_DIR:-}
[[ -n $root ]] || root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root=$cwd
normalize_path / "$root"
root=$REPLY

deny_bash() {
  cat >&2 <<EOF
Blocked: \`$1\` is lane work, and this is the coordinating session (cwd in the main folder).
It briefs, dispatches, reviews, relays and keeps the board (AGENTS.md); filing issues with
\`gh issue create\` stays allowed. Write a brief in .scratch/ and hand the work to a lane, which
commits and opens its PR from its own worktree (entered with the worktree tool).
EOF
  exit 2
}

# Called by walk_commands for each simple command. Every directory counts: a commit in another
# session's worktree, reached with `git -C` or a subshell `cd`, is lane work too.
check_command() {
  case $name in
    git)
      gdir=$here
      parse_git_args "${@:2}"
      [[ $git_sub == commit ]] && deny_bash 'git commit'
      ;;
    gh)
      [[ ${2:-} == pr && ${3:-} =~ ^(create|new)$ ]] && deny_bash 'gh pr create'
      ;;
  esac
  return 0
}

case $tool in
  Bash)
    command=$(json_field command) || exit 0
    # Nothing to check: skip the lexer. Only for unquoted text, since quotes or a backslash can
    # split a command name (`g'i't`, `g\it`) and hide it from this test.
    if [[ ! $command =~ [\'\"\\] && ! $command =~ (git|gh) ]]; then exit 0; fi
    lex_command "$command"
    walk_commands "$cwd"
    ;;
  Edit | Write | MultiEdit | NotebookEdit)
    path=$(json_field file_path) || path=$(json_field notebook_path) || exit 0
    # shellcheck disable=SC2088 # a literal `~` in the tool input stands for home
    [[ $path == '~' || $path == '~/'* ]] && path=${HOME:-}${path:1}
    normalize_path "$cwd" "$path"
    case $REPLY in
      "$root"/.scratch/* | "$root"/.remember/*) ;;
      "$root" | "$root"/*) deny_edit "$REPLY" ;;
    esac
    ;;
esac
exit 0

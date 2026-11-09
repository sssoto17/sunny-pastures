#!/usr/bin/env bash
# PreToolUse hook on Bash: keep the main folder on `main` and keep the coordinating session's
# working directory in it. Denies a branch switch (`git checkout <branch>`, `git switch`,
# `gh pr checkout`) whose directory is not inside .claude/worktrees/<name>, whatever the session's
# cwd, and a top-level `cd`/`pushd` into .claude/worktrees/ from the main folder. Remote sessions
# (cloud sessions, routines, GitHub Actions jobs) have no main folder and are skipped. Exit 2
# blocks the command and stderr goes back to the session. Reads the raw hook JSON on stdin, so it
# needs no jq; the JSON reader and the shell lexer are in lib/shell-lexer.sh. Tests:
# block-branch-switch.test.sh next to this file.
set -uo pipefail
# Without the lib the hook exits 1: Claude Code reports the error and lets the call through.
# shellcheck source-path=SCRIPTDIR source=lib/shell-lexer.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/shell-lexer.sh" || exit 1

input=$(cat)
remote_session && exit 0

cwd=$(json_field cwd) || exit 0
command=$(json_field command) || exit 0
# Nothing to check: skip the lexer. Only for unquoted text, since quotes or a backslash can
# split a command name (`g'i't`, `g\it`) and hide it from this test.
if [[ ! $command =~ [\'\"\\] && ! $command =~ (git|gh|cd|pushd) ]]; then exit 0; fi

deny_switch() {
  cat >&2 <<'EOF'
Blocked: this switches branches outside a worktree, in the main folder. The main folder stays on
main and belongs to the coordinating session (AGENTS.md, parallel sessions). Work in a worktree
instead: `git worktree add .claude/worktrees/<N>-<slug> -b <branch> main`, then reach it with
`git -C <worktree> …`, a subshell `( cd <worktree> && … )` or absolute paths
(docs/agents/sandbox.md, "Working directory"). To restore a file, use `git checkout -- <path>`.
EOF
  exit 2
}

deny_cd() {
  cat >&2 <<'EOF'
Blocked: a top-level `cd`/`pushd` into .claude/worktrees/ moves this session out of the main
folder, and Bash keeps that directory for every later command. The main folder belongs to the
coordinating session: to look into a worktree, use `git -C <worktree> …`, a subshell
`( cd <worktree> && … )` or absolute paths. A session that owns a worktree enters it with the
worktree tool (EnterWorktree) before its first edit, not with `cd` (docs/agents/sandbox.md,
"Working directory").
EOF
  exit 2
}

# Is `git <args>` (words after `git`) a branch switch? Moves gdir with each `-C`.
git_switches_branch() {
  parse_git_args "$@"
  [[ $git_sub == switch ]] && return 0
  [[ $git_sub == checkout ]] || return 1
  # checkout: `-- <path>` restores files. Otherwise a ref or a branch option switches.
  local a k opts=("${git_rest[@]}")
  for ((k = 0; k < ${#opts[@]}; k++)); do
    [[ ${opts[k]} == -- ]] || continue
    ((k + 1 < ${#opts[@]})) && return 1 # `checkout [<ref>] -- <path>` restores files
    opts=("${opts[@]:0:k}")             # a bare trailing `--` changes nothing
    break
  done
  for a in "${opts[@]}"; do
    case $a in
      -b* | -B* | --orphan | --orphan=* | --detach | -) return 0 ;;
      -*) ;;
      *) return 0 ;;
    esac
  done
  return 1
}

# Called by walk_commands for each simple command, with `here` its directory.
check_command() {
  case $name in
    git)
      gdir=$here
      if git_switches_branch "${@:2}" && ! in_worktree "$gdir"; then deny_switch; fi
      ;;
    gh)
      if [[ ${2:-} == co || "${2:-} ${3:-}" == 'pr checkout' ]] && ! in_worktree "$here"; then
        deny_switch
      fi
      ;;
  esac
}

# Called by walk_commands for each cd/pushd/popd, before it moves the directory to REPLY.
# A top-level cd persists into the session's later commands; a subshell's does not.
check_cd() {
  if ((depth == 0)) && ! in_worktree "$here" &&
    { [[ $cd_target =~ (^|/)\.claude/worktrees(/|$) ]] || in_worktree "$REPLY"; }; then
    deny_cd
  fi
}

lex_command "$command"
walk_commands "$cwd"
exit 0

#!/usr/bin/env bash
# PreToolUse hook on Bash and MCP tools: agents never resolve review threads (#264; CONSTRAINTS.md,
# "Admin review"). An open escalation thread is what holds a PR for the admin, so resolving it is
# the admin's go-ahead (ADR-0002, area 2). Denies:
# - any MCP tool named like resolve_review_thread / resolveReviewThread, on any server;
# - a Bash command whose text holds resolveReviewThread in any case, once quotes and backslashes
#   are taken out (so `resolve''ReviewThread` counts);
# - a GraphQL call (`gh api graphql`, `gh api …/graphql`, `curl …graphql…`) whose query it can't
#   read: one with an expansion ($…, backticks), a file or stdin (@file, --input, <), since the
#   mutation could hide there.
# Unlike the other hooks, it also runs in remote sessions (cloud, routines, Actions): agent PRs
# and replies come from the admin's account until #107, so nothing on GitHub can tell an agent's
# resolve from the admin's. This is a standard plus a check, not a boundary: #107's App identity
# is. Exit 2 blocks the call and stderr goes back to the session. Tests: block-thread-resolve.test.sh.
set -uo pipefail
# Without the lib the hook exits 1: Claude Code reports the error and lets the call through.
# shellcheck source-path=SCRIPTDIR source=lib/shell-lexer.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/shell-lexer.sh" || exit 1

input=$(cat)

deny() { # reason
  cat >&2 <<EOF
Blocked: $1. Agents never resolve review threads: an open thread, above all the reviewer's
escalation thread, holds the PR until the admin resolves it (ADR-0002, area 2; CONSTRAINTS.md,
"Admin review"). Reply on the thread instead, and leave resolving to the admin. To read threads,
use a GraphQL query written out in the command, with no \$ variables, files or stdin.
EOF
  exit 2
}

tool=$(json_field tool_name) || exit 0
shopt -s nocasematch
if [[ $tool == mcp__* ]]; then
  [[ $tool =~ (^|[^n])resolve_?review_?thread ]] && deny "the MCP tool $tool resolves a review thread"
  # GitHub's MCP server resolves through one tool with a method (github-mcp-server README).
  if [[ $tool == *pull_request_review_write ]]; then
    method=$(json_field method) || exit 0
    [[ $method == resolve_thread ]] && deny "$tool with method resolve_thread resolves a review thread"
  fi
  exit 0
fi
[[ $tool == Bash ]] || exit 0
shopt -u nocasematch

command=$(json_field command) || exit 0
flat=${command//[\'\"\\]/}
[[ ${flat,,} == *resolvereviewthread* ]] && deny "this command names resolveReviewThread"
[[ ${flat,,} == *graphql* ]] || exit 0

deny_unreadable() {
  deny "this GraphQL call's query comes from a variable, a command, a file or stdin, so the hook can't read it"
}

# Called by walk_commands for each simple command (in a subshell for `bash -c`, so it denies here).
check_command() {
  local w is_call=0
  case $name in
    gh)
      [[ ${2:-} == api ]] || return 0
      for w in "${@:3}"; do [[ $w =~ (^|/)graphql([?#/]|$) ]] && is_call=1; done
      ;;
    curl)
      for w in "${@:2}"; do [[ ${w,,} == *graphql* ]] && is_call=1; done
      ;;
  esac
  ((is_call)) || return 0
  # Backticks and input redirects leave no trace in the words, so they count in the whole command;
  # under xargs the query can arrive as an operand.
  [[ $command == *'`'* || $command == *'<'* ]] && deny_unreadable
  ((via_xargs)) && deny_unreadable
  for w in "${@:2}"; do
    # $…; a file (gh -F k=@f, --input; curl -d @f, k@f, -T, -K and their long forms)
    [[ $w == *'$'* || $w == *@* || $w == --input* ]] && deny_unreadable
    [[ $name == curl && $w =~ ^(-T|-K|--upload-file|--config)($|=) ]] && deny_unreadable
  done
  return 0
}

lex_command "$command"
walk_commands "${PWD:-/}"
exit 0

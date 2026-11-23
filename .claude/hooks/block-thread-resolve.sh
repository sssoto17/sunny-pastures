#!/usr/bin/env bash
# PreToolUse hook on Bash and MCP tools: agents never resolve review threads (#264), submit a PR
# review or reply on a review thread (#497); CONSTRAINTS.md, "Admin review". An open escalation
# thread is what holds a PR for the admin, so resolving it is the admin's go-ahead (ADR-0002,
# area 2). A review from a session on the admin's account reads as the admin's review (it was the
# sign-off under `guard / code-owned` until #565 dropped #494's rule), and a thread reply creates a
# review. Agents answer a finding with a
# plain PR comment (`gh pr comment`), which creates none. Denies:
# - an MCP tool, on any server, that resolves a thread (resolve_review_thread) or writes a review or
#   a thread reply (pull_request_review_write, the pending-review tools, reply_to_pull_request_comment);
# - a Bash command whose text holds resolveReviewThread or a review-writing GraphQL mutation
#   (add/submit/dismiss/update/delete PullRequestReview…) in any case, once quotes and backslashes
#   are taken out (so `resolve''ReviewThread` counts);
# - `gh pr review`;
# - a `gh api` call that writes (a method other than GET, or a field or --input without one) to
#   pulls/<n>/reviews… or pulls/<n>/comments… (a review, a review comment or a thread reply), or
#   writes to an endpoint it can't read (an expansion, backticks or xargs);
# - a `curl` call that reaches pulls/<n>/reviews… or pulls/<n>/comments…, whatever its method;
# - a GraphQL call (`gh api graphql`, `gh api …/graphql`, `curl …graphql…`) whose query it can't
#   read: one with an expansion ($…, backticks), a file or stdin (@file, --input, <), since the
#   mutation could hide there.
# The commands inside $( … ) and backticks are checked too. A command over 20 KB that runs gh or
# curl with one of the words these forms need is refused, since reading it could outrun the timeout. Unlike the other hooks, it also runs
# in remote sessions (cloud, routines, Actions): agent PRs and replies come from the admin's
# account until #107, so nothing on GitHub can tell an agent's review from the admin's. This is a
# standard plus a check, not a boundary: #107's App identity is. The `deny` rules in
# .claude/settings.json cover the plain forms as a first layer. Exit 2 blocks the call and stderr
# goes back to the session. Tests: block-thread-resolve.test.sh.
set -uo pipefail
# Without the lib the hook exits 1: Claude Code reports the error and lets the call through.
# shellcheck source-path=SCRIPTDIR source=lib/shell-lexer.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/shell-lexer.sh" || exit 1

input=$(cat)

deny() { # reason
  cat >&2 <<EOF
Blocked: $1. Agents never resolve review threads, submit a PR review or reply on a review
thread (#264, #497; CONSTRAINTS.md, "Admin review"). An open thread holds the PR for the admin,
and a review from a session on the admin's account would read as the admin's own review.
Answer a finding with a plain PR comment (gh pr comment <N> --body-file <file>), and leave reviews
and resolving to the admin. To read threads or reviews, use a REST GET or a GraphQL query written
out in the command, with no \$ variables, files or stdin.
EOF
  exit 2
}

# A PR review or review-comment endpoint: pulls/<n>/reviews…, pulls/<n>/comments… (a thread reply
# is pulls/<n>/comments/<id>/replies) or pulls/comments/<id> (edit or delete a review comment).
# Matched lowercased.
review_path='(^|/)pulls/([^/]+/)?(reviews|comments)([/?#]|$)'

tool=$(json_field tool_name) || exit 0
shopt -s nocasematch
if [[ $tool == mcp__* ]]; then
  [[ $tool =~ (^|[^n])resolve_?review_?thread ]] && deny "the MCP tool $tool resolves a review thread"
  # GitHub's MCP server writes reviews through pull_request_review_write (every method: create,
  # submit_pending, delete_pending, resolve_thread, …), add_comment_to_pending_review and
  # add_reply_to_pull_request_comment (github-mcp-server README); older releases had
  # create_and_submit_pull_request_review and the *_pending_pull_request_review tools.
  squashed=${tool//_/}
  [[ $squashed =~ pullrequestreviewwrite|commenttopendingreview|pendingpullrequestreview|replytopullrequestcomment|(add|create|submit|dismiss)[a-z0-9]*pullrequestreview ]] &&
    deny "the MCP tool $tool writes a PR review or a reply on a review thread"
  exit 0
fi
[[ $tool == Bash ]] || exit 0
shopt -u nocasematch

command=$(json_field command) || exit 0
flat=${command//[\'\"\\]/}
flat=${flat,,}
[[ $flat == *resolvereviewthread* ]] && deny "this command names resolveReviewThread"
[[ $flat =~ (add|submit|dismiss|update|delete)pullrequestreview ]] &&
  deny "this command names ${BASH_REMATCH[0]}, a GraphQL mutation that writes a PR review or a thread reply"
# Only a command that runs gh or curl goes on to the lexer (slow on a long command).
calls_gh='(^|[^a-z0-9_.-])(gh|curl)([^a-z0-9_.-]|$)'
[[ $flat =~ $calls_gh ]] || exit 0
# Every form below needs one of these words: `pr review`, `api`, a pulls/ path or graphql.
[[ $flat == *review* || $flat == *api* || $flat == *pulls* || $flat == *graphql* ]] || exit 0
# The lexer is slow on a long command (about 1 s at 20 KB): past the 10 s timeout the hook would
# let the call through, so refuse a long one instead.
((${#command} <= 20000)) ||
  deny "this command is over 20 KB and runs gh or curl, too long for the hook to read in time; put long text in a file (gh pr comment <N> --body-file <file>)"

# The command without its single-quoted text, where a backtick is only data.
unquoted=$command
while [[ $unquoted =~ \'[^\']*\' ]]; do unquoted=${unquoted/"${BASH_REMATCH[0]}"/}; done

deny_unreadable() {
  deny "this GraphQL call's query comes from a variable, a command, a file or stdin, so the hook can't read it"
}

# A GraphQL call, its words after the command name in "$@": deny it when the hook can't read its
# query.
check_graphql() {
  local w
  # Backticks and input redirects leave no trace in the words, so they count in the whole command;
  # under xargs the query can arrive as an operand.
  [[ $command == *'`'* || $command == *'<'* ]] && deny_unreadable
  ((via_xargs)) && deny_unreadable
  for w in "$@"; do
    # $…; a file (gh -F k=@f, --input; curl -d @f, k@f, -T, -K and their long forms)
    [[ $w == *'$'* || $w == *@* || $w == --input* ]] && deny_unreadable
    [[ $name == curl && $w =~ ^(-T|-K|--upload-file|--config)($|=) ]] && deny_unreadable
  done
  return 0
}

# `gh api`, its words after `api` in "$@": find the endpoint and whether the call writes. gh sends
# GET unless -X/--method says otherwise, and POST once a field or --input is given (gh api --help).
check_gh_api() {
  local w next='' method='' fields=0 endpoint='' has_endpoint=0 write=0
  for w in "$@"; do
    case $next in
      method) method=$w next='' && continue ;;
      skip) next='' && continue ;;
    esac
    case $w in
      -X | --method) next=method ;;
      --method=*) method=${w#*=} ;;
      -X?*) method=${w#-X} ;;
      -f | -F | --field | --raw-field | --input) fields=1 next=skip ;;
      -f?* | -F?* | --field=* | --raw-field=* | --input=*) fields=1 ;;
      -H | --header | -q | --jq | -t | --template | --hostname | -p | --preview | --cache) next=skip ;;
      -?*) ;;
      *) ((has_endpoint)) || endpoint=$w has_endpoint=1 ;;
    esac
  done
  if [[ -n $method ]]; then
    [[ ${method^^} == GET ]] || write=1 # a method from a variable counts as a write
  elif ((fields)); then
    write=1
  fi
  if [[ ${endpoint,,} =~ (^|/)graphql([?#/]|$) ]]; then
    check_graphql "$@"
    return 0
  fi
  ((write)) || return 0
  [[ ${endpoint,,} =~ $review_path ]] &&
    deny "this gh api call writes to $endpoint, a PR review or review-comment endpoint"
  ((via_xargs)) && deny "this gh api call writes under xargs, which can add the endpoint, so the hook can't read it"
  [[ $unquoted == *'`'* ]] &&
    deny "this gh api call writes and the command holds backticks, so the hook can't read its endpoint"
  [[ $endpoint == '' ]] && deny "this gh api call writes to an endpoint the hook can't find"
  # An expansion could hold a review path, unless a literal issues/ segment comes before it (and
  # no `..` leads back out).
  if [[ $endpoint == *'$'* ]]; then
    [[ ${endpoint%%\$*} =~ (^|/)issues/ && $endpoint != *..* ]] ||
      deny "this gh api call writes to an endpoint that comes from a variable or a command, so the hook can't read it"
  fi
  return 0
}

# Called by walk_commands for each simple command (in a subshell for `bash -c`, so it denies here).
check_command() {
  local w
  case $name in
    gh)
      shift
      # Skip options before the subcommand, such as `gh -R o/r pr review`.
      while (($#)) && [[ $1 == -?* ]]; do
        [[ $1 == -R || $1 == --repo || $1 == --hostname ]] && shift
        shift
      done
      if [[ ${1:-} == pr ]]; then
        shift
        # and between `pr` and its subcommand: `gh pr -R o/r review`
        while (($#)) && [[ $1 == -?* ]]; do
          [[ $1 == -R || $1 == --repo ]] && shift
          shift
        done
        [[ ${1:-} == review ]] && deny "gh pr review submits a PR review"
        return 0
      fi
      [[ ${1:-} == api ]] && check_gh_api "${@:2}"
      ;;
    curl)
      for w in "${@:2}"; do
        [[ ${w,,} =~ $review_path ]] && deny "this curl call reaches $w, a PR review or review-comment endpoint"
      done
      for w in "${@:2}"; do
        [[ ${w,,} == *graphql* ]] && check_graphql "${@:2}" && break
      done
      ;;
  esac
  return 0
}

# The lexer keeps $( … ) and backticks as data, so walk the commands inside them as well: each
# $( … ) body up to its matching `)` (counting parentheses outside quotes), and each backtick
# body. A nested $( … ) is found again on its own.
walk_body() {
  local b=${1,,}
  [[ ${b//[\'\"\\]/} =~ $calls_gh ]] || return 0
  lex_command "$1"
  walk_commands "${PWD:-/}"
}
walk_substitutions() {
  local rest k depth c sq dq
  rest=$command
  while [[ $rest == *'$('* ]]; do
    rest=${rest#*'$('}
    depth=1 sq=0 dq=0
    for ((k = 0; k < ${#rest} && depth > 0; k++)); do
      c=${rest:k:1}
      case $c in
        \\) ((sq)) || k=$((k + 1)) ;;
        "'") ((dq)) || sq=$((!sq)) ;;
        '"') ((sq)) || dq=$((!dq)) ;;
        '(') ((sq || dq)) || depth=$((depth + 1)) ;;
        ')') ((sq || dq)) || depth=$((depth - 1)) ;;
      esac
    done
    walk_body "${rest:0:k-1}"
  done
  rest=$command
  while [[ $rest == *'`'*'`'* ]]; do
    rest=${rest#*'`'}
    walk_body "${rest%%'`'*}"
    rest=${rest#*'`'}
  done
}

lex_command "$command"
walk_commands "${PWD:-/}"
walk_substitutions
exit 0

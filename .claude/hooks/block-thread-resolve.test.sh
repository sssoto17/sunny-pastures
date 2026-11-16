#!/usr/bin/env bash
# shellcheck disable=SC2016 # test commands are single-quoted on purpose: the hook must see $Q unexpanded
# Tests for block-thread-resolve.sh, through its hook interface: PreToolUse JSON on stdin,
# exit 0 (allow) or 2 (deny, message on stderr). Run: bash .claude/hooks/block-thread-resolve.test.sh
set -uo pipefail

hook="$(dirname "$0")/block-thread-resolve.sh"
CWD=/home/dev/sunny-pastures
pass=0
fail=0
unset CLAUDE_CODE_REMOTE GITHUB_ACTIONS # set in cloud sessions and CI; tested below

json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

run_hook() { # tool-name command -> sets code, err
  local input
  input=$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PreToolUse","tool_name":%s,"tool_input":{"command":%s,"description":"test"}}' \
    "$(json_str "$CWD")" "$(json_str "$1")" "$(json_str "$2")")
  err=$(timeout 5 bash "$hook" <<<"$input" 2>&1 >/dev/null)
  code=$?
}

check() { # expected-code tool command [stderr-substring]
  run_hook "$2" "$3"
  if [[ $code -eq $1 && (-z ${4:-} || $err == *"$4"*) ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: expected exit %s, got %s\n  tool: %s\n  command: %s\n  stderr: %s\n' \
      "$1" "$code" "$2" "$3" "$err"
  fi
}
deny() { check 2 Bash "$@"; }
allow() { check 0 Bash "$@"; }

# --- the mutation, however it's written -------------------------------------------------------
deny 'gh api graphql -f query='\''mutation { resolveReviewThread(input: {threadId: "T"}) { thread { id } } }'\''' 'resolve review threads'
deny 'gh api graphql -f query='\''mutation { resolve'\'''\''ReviewThread(input: {threadId: "T"}) { thread { id } } }'\'''
deny 'gh api graphql -f query="mutation { resolve\ReviewThread(input: {threadId: \"T\"}) { thread { id } } }"'
deny 'python3 -c "import requests; q = \"RESOLVEREVIEWTHREAD\""'
deny $'cat <<EOF >q.graphql\nmutation { resolveReviewThread(input: {threadId: "T"}) { thread { id } } }\nEOF'

# --- a GraphQL call whose query the hook can't read -------------------------------------------
deny 'gh api graphql -f query="$(cat q.graphql)"' "can't read"
deny 'gh api graphql -f query="$Q"'
deny 'gh api graphql -f query=`cat q.graphql`'
deny 'gh api graphql -F query=@q.graphql'
deny 'gh api graphql --input q.json'
deny 'cat q.json | gh api graphql --input -'
deny 'gh api graphql -f query=- < q.graphql'
deny 'gh api https://api.github.com/graphql -F query=@q.graphql'
deny 'curl -s -X POST https://api.github.com/graphql -d @q.json'
deny 'curl https://api.github.com/graphql --data "$BODY"'
deny 'git fetch && gh api graphql -F query=@q.graphql'
deny 'bash -c "gh api graphql -F query=@q.graphql"'
# quoting splits the word `graphql` in the text, not in the command (#319's review)
deny 'gh api '\''graph'\''ql -F query=@q.graphql'
deny 'curl https://api.github.com/gra""phql -d @q.json'
# curl's other ways to read a body from a file, and xargs adding the query as an operand
deny 'curl https://api.github.com/graphql --data-urlencode query@q.graphql'
deny 'curl -T q.json https://api.github.com/graphql'
deny 'curl -K q.cfg https://api.github.com/graphql'
deny 'xargs -a q.txt gh api graphql -f query'
deny 'printf "%s" "$Q" | xargs -I{} gh api graphql -f query={}'
deny 'printf "query { viewer { login } }" | xargs -I{} gh api graphql -f query={}'

# --- what stays allowed ------------------------------------------------------------------------
allow 'gh api graphql -f query='\''query { viewer { login } }'\'''
allow 'gh api repos/sssoto17/sunny-pastures/pulls/1/comments --jq ".[].id"'
allow 'gh api "repos/sssoto17/sunny-pastures/pulls?state=open" --jq ".[] | .number"'
allow 'curl -s https://example.com/api -d @body.json'
allow 'echo graphql "$HOME"'
allow 'git status'
allow 'git log --grep graphql'

# --- MCP tools: any resolve-thread tool, on any server -----------------------------------------
check 2 mcp__github__resolve_review_thread '' 'resolve review threads'
check 2 mcp__other_server__resolveReviewThread ''
check 0 mcp__github__unresolve_review_thread ''
check 0 mcp__github__pull_request_read ''
check 0 Read ''

# GitHub's MCP server (the local plugin's) resolves a thread with pull_request_review_write,
# method resolve_thread (github-mcp-server README); its other methods stay allowed.
mcp_method() { # expected-code tool method
  local input
  input=$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PreToolUse","tool_name":%s,"tool_input":{"owner":"o","repo":"r","pullNumber":1,"method":%s}}' \
    "$(json_str "$CWD")" "$(json_str "$2")" "$(json_str "$3")")
  err=$(timeout 5 bash "$hook" <<<"$input" 2>&1 >/dev/null)
  code=$?
  if [[ $code -eq $1 ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    printf 'FAIL: expected exit %s, got %s\n  tool: %s method: %s\n  stderr: %s\n' "$1" "$code" "$2" "$3" "$err"
  fi
}
mcp_method 2 mcp__plugin_github_github__pull_request_review_write resolve_thread
mcp_method 2 mcp__github__pull_request_review_write RESOLVE_THREAD
mcp_method 0 mcp__plugin_github_github__pull_request_review_write unresolve_thread
mcp_method 0 mcp__plugin_github_github__pull_request_review_write create
mcp_method 0 mcp__plugin_github_github__pull_request_review_write submit_pending

# --- unlike the other hooks, it runs in cloud sessions and Actions too ------------------------
export CLAUDE_CODE_REMOTE=true
deny 'gh api graphql -f query="$Q"'
check 2 mcp__github__resolve_review_thread ''
unset CLAUDE_CODE_REMOTE
export GITHUB_ACTIONS=true
deny 'gh api graphql -F query=@q.graphql'
unset GITHUB_ACTIONS

echo "block-thread-resolve.test.sh: $pass passed, $fail failed"
((fail == 0))

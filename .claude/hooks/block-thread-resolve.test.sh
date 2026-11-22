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
deny 'gh api "https://api.github.com/graphql?x=1" -F query=@q.graphql'
deny 'gh api https://api.github.com/graphql#x -F query=@q.graphql'
deny 'gh api graphql/ -F query=@q.graphql'
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
# #497: the tool writes reviews with every other method, so all of them are refused now.
mcp_method 2 mcp__plugin_github_github__pull_request_review_write unresolve_thread
mcp_method 2 mcp__plugin_github_github__pull_request_review_write create
mcp_method 2 mcp__plugin_github_github__pull_request_review_write submit_pending
mcp_method 2 mcp__github__pull_request_review_write delete_pending

# --- #497: no PR review and no thread reply, in any form ---------------------------------------
# A lane on the admin's account that reviews its own PR would sign it off under
# `guard / code-owned` (#494); a thread reply is a review too. A PR comment stays allowed.
deny 'gh pr review 12 --approve' 'submit a PR review'
deny 'gh pr review 12 --comment -b "fixed in abc123"'
deny 'gh pr review'
deny 'git fetch && gh pr review 12 --request-changes -b x'
deny 'bash -c "gh pr review 12 --approve"'
deny 'echo "$(gh pr review 12 --approve)"'
deny 'echo `gh pr review 12 --approve`'
deny 'env GH_REPO=o/r gh pr review 12 --approve'
# REST: a review (POST pulls/<n>/reviews), submitting a pending one (…/reviews/<id>/events),
# dismissing one (…/dismissals), a review comment (POST pulls/<n>/comments) and a thread reply
# (…/comments/<id>/replies), with an explicit method or with fields (gh then sends POST)
deny 'gh api -X POST repos/sssoto17/sunny-pastures/pulls/12/reviews -f event=COMMENT -f body=x' 'review-comment endpoint'
deny 'gh api repos/{owner}/{repo}/pulls/12/reviews -f event=APPROVE'
deny 'gh api repos/{owner}/{repo}/pulls/12/reviews --input review.json'
deny 'gh api --method=POST repos/o/r/pulls/12/reviews'
deny 'gh api -XPOST repos/o/r/pulls/12/reviews'
deny 'gh api -f event=APPROVE repos/o/r/pulls/12/reviews'
deny 'gh api -Fevent=APPROVE "repos/$R/pulls/$N/reviews"'
deny 'gh api repos/o/r/pulls/12/reviews/99/events -f event=COMMENT'
deny 'gh api -X PUT repos/o/r/pulls/12/reviews/99/dismissals -f message=x'
deny 'gh api https://api.github.com/repos/o/r/pulls/12/reviews -f event=APPROVE'
deny 'gh api repos/o/r/pulls/12/comments -f body=x -f commit_id=abc -f path=a.ts -F line=3'
deny 'gh api repos/o/r/pulls/12/comments -f body=x -F in_reply_to=77'
deny 'gh api repos/o/r/pulls/12/comments/77/replies -f body="fixed in abc123"'
deny 'gh api -X POST repos/o/r/PULLS/12/Comments/77/replies --raw-field body=x'
deny 'gh api --method "$M" repos/o/r/pulls/12/reviews'
deny 'x=$(gh api repos/o/r/pulls/12/reviews -f event=APPROVE --jq .id)'
deny 'curl -s -X POST https://api.github.com/repos/o/r/pulls/12/reviews -d @r.json'
deny 'curl https://api.github.com/repos/o/r/pulls/12/comments/77/replies --json "{}"'
# a write whose endpoint the hook can't read
deny 'gh api -X POST "$URL" -f event=APPROVE' "can't read"
deny 'gh api "$(cat endpoint.txt)" -f event=APPROVE'
deny 'echo repos/o/r/pulls/12/reviews | xargs gh api -f event=APPROVE'
# GraphQL: the review and thread-reply mutations, however they're written
deny 'gh api graphql -f query='\''mutation { addPullRequestReview(input: {pullRequestId: "P", event: APPROVE}) { clientMutationId } }'\''' 'GraphQL mutation'
deny 'gh api graphql -f query='\''mutation { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: "T", body: "x"}) { clientMutationId } }'\'''
deny 'gh api graphql -f query='\''mutation { addPullRequestReviewComment(input: {}) { clientMutationId } }'\'''
deny 'gh api graphql -f query='\''mutation { addPullRequestReviewThread(input: {}) { clientMutationId } }'\'''
deny 'gh api graphql -f query='\''mutation { submitPullRequestReview(input: {event: COMMENT}) { clientMutationId } }'\'''
deny 'gh api graphql -f query='\''mutation { dismissPullRequestReview(input: {}) { clientMutationId } }'\'''
deny 'gh api graphql -f query="mutation { add'\'''\''PullRequest\Review(input: {}) { clientMutationId } }"'
deny 'curl https://api.github.com/graphql -d '\''{"query":"mutation { ADDPULLREQUESTREVIEW(input: {}) { clientMutationId } }"}'\'''
# a GraphQL query the hook can't read (the mutation could hide in it), here inside $( … )
deny 'echo "$(gh api graphql -F query=@review.graphql)"' "can't read"
# MCP: GitHub's review tools on any server (github-mcp-server README), older names included
check 2 mcp__github__add_comment_to_pending_review '' 'writes a PR review'
check 2 mcp__github__add_reply_to_pull_request_comment ''
check 2 mcp__plugin_github_github__add_reply_to_pull_request_comment ''
check 2 mcp__claude_ai_GitHub__pull_request_review_write ''
check 2 mcp__github__create_and_submit_pull_request_review ''
check 2 mcp__github__create_pending_pull_request_review ''
check 2 mcp__github__submit_pending_pull_request_review ''
check 2 mcp__github__add_pull_request_review_comment_to_pending_review ''
check 2 mcp__github__dismiss_pull_request_review ''
# what stays allowed: a PR comment, reading reviews and threads, other writes
allow 'gh pr comment 12 --body "Fixed in abc123: the guard now reads the head."'
allow 'gh pr comment 12 --body-file .scratch/reply.md'
allow 'gh api repos/o/r/issues/12/comments -f body="fixed in abc123"'
allow 'gh api repos/sssoto17/sunny-pastures/pulls/12/reviews --jq ".[].state"'
allow 'gh api --paginate "repos/o/r/pulls/$PR/reviews?per_page=100"'
allow 'gh api -X GET repos/o/r/pulls/12/reviews -f per_page=100'
allow 'gh api repos/o/r/pulls/12/comments --jq ".[].body"'
allow 'gh api repos/o/r/pulls/12 -H "Accept: application/vnd.github.diff"'
allow 'gh api -X PATCH repos/o/r/issues/12 -f title=x'
allow 'gh api graphql -f query='\''query { repository(owner: "o", name: "r") { pullRequest(number: 12) { reviewThreads(first: 50) { nodes { isResolved } } latestReviews(first: 5) { nodes { state } } } } }'\'''
allow 'gh pr view 12 --json reviews'
allow 'gh pr reviewers 12'
allow 'echo "$(gh pr view 12 --json headRefOid -q .headRefOid)"'
check 0 mcp__github__pull_request_read ''
check 0 mcp__github__add_issue_comment ''
check 0 mcp__github__request_copilot_review ''

# --- unlike the other hooks, it runs in cloud sessions and Actions too ------------------------
export CLAUDE_CODE_REMOTE=true
deny 'gh api graphql -f query="$Q"'
check 2 mcp__github__resolve_review_thread ''
unset CLAUDE_CODE_REMOTE
export GITHUB_ACTIONS=true
deny 'gh api graphql -F query=@q.graphql'
unset GITHUB_ACTIONS

# --- the first layer: .claude/settings.json `deny` rules for the plain forms (#497) --------------
# A dry run of the rules: each plain form below must match a `deny` rule, and `gh pr comment` none.
# Bash globs stand in for Claude Code's matching, where `*` matches any text (code.claude.com/docs/
# en/permissions, "Wildcard patterns" and "Tool name wildcards"); a rule `X *` also matches bare `X`.
settings="$(dirname "$0")/../settings.json"
deny_rules=$(sed -n '/"deny": \[/,/\]/p' "$settings" | sed -n 's/^[[:space:]]*"\(.*\)",\{0,1\}$/\1/p')
rule_for() { # tool-name command -> 0 if a deny rule matches
  local r pat
  while IFS= read -r r; do
    if [[ $1 == Bash && $r == Bash\(*\) ]]; then
      pat=${r#Bash(}
      pat=${pat%)}
      # shellcheck disable=SC2053 # the rule is a glob on purpose
      [[ $2 == $pat || ($pat == *' *' && $2 == "${pat% \*}") ]] && return 0
    elif [[ $1 != Bash && $r != *\(* ]]; then
      # shellcheck disable=SC2053
      [[ $1 == $r ]] && return 0
    fi
  done <<<"$deny_rules"
  return 1
}
rule() { # expected (denied|allowed) tool command
  local got=allowed
  rule_for "$2" "${3:-}" && got=denied
  if [[ $got == "$1" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    printf 'FAIL: expected settings.json to leave %s %s, got %s\n' "$2" "${3:-}" "$got"
  fi
}
rule denied Bash 'gh pr review'
rule denied Bash 'gh pr review 12 --approve'
rule denied Bash 'gh api repos/o/r/pulls/12/reviews -f event=COMMENT -f body=x'
rule denied Bash 'gh api -X POST repos/o/r/pulls/12/reviews -F event=APPROVE'
rule denied Bash 'gh api repos/o/r/pulls/12/reviews --input review.json'
rule denied Bash 'gh api repos/o/r/pulls/12/reviews/99/events -f event=COMMENT'
rule denied Bash 'gh api repos/o/r/pulls/12/comments -f body=x -f path=a.ts'
rule denied Bash 'gh api repos/o/r/pulls/12/comments/77/replies -f body=x'
rule denied Bash 'gh api --method POST repos/o/r/pulls/12/comments/77/replies'
rule denied Bash 'curl -X POST https://api.github.com/repos/o/r/pulls/12/reviews -d @r.json'
rule denied Bash 'gh api graphql -f query='\''mutation { addPullRequestReview(input: {}) { clientMutationId } }'\'''
rule denied Bash 'gh api graphql -f query='\''mutation { addPullRequestReviewThreadReply(input: {}) { clientMutationId } }'\'''
rule denied Bash 'gh api graphql -f query='\''mutation { submitPullRequestReview(input: {}) { clientMutationId } }'\'''
rule denied mcp__github__pull_request_review_write
rule denied mcp__plugin_github_github__pull_request_review_write
rule denied mcp__github__add_comment_to_pending_review
rule denied mcp__github__add_reply_to_pull_request_comment
rule denied mcp__claude_ai_GitHub__add_reply_to_pull_request_comment
rule allowed Bash 'gh pr comment 12 --body-file .scratch/reply.md'
rule allowed Bash 'gh api repos/o/r/pulls/12/reviews --jq ".[].state"'
rule allowed Bash 'gh api repos/o/r/pulls/12/comments --jq ".[].body"'
rule allowed Bash 'gh api repos/o/r/issues/12/comments -f body=x'
rule allowed mcp__github__pull_request_read

echo "block-thread-resolve.test.sh: $pass passed, $fail failed"
((fail == 0))

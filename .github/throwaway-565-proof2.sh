#!/usr/bin/env bash
# THROWAWAY (#565, never merge). Proof 2: on a head whose first Actions check suite is a PR's, does
# an API-written `guard / code-owned` check run reach the merge box and satisfy the required check?
# And does a commit status named `guard / code-owned` reach it on #629, whose check runs didn't?
set -euo pipefail
R=$GITHUB_REPOSITORY
OUT=$RUNNER_TEMP/readings.md
: >"$OUT"
note() { printf '%s\n' "$*" | tee -a "$OUT"; }
QUERY='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
  mergeStateStatus commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){nodes{
  __typename ... on CheckRun{name databaseId status conclusion isRequired(pullRequestNumber:$n)
  checkSuite{databaseId workflowRun{event workflow{name}}}}
  ... on StatusContext{context state isRequired(pullRequestNumber:$n) creator{login}}}}}}}}}}}'
reading() { # title pr
  note ""
  note "### $1 (PR #$2)"
  gh api graphql -f query="$QUERY" -F o="${R%/*}" -F r="${R#*/}" -F n="$2" --jq '
    .data.repository.pullRequest as $p
    | "mergeStateStatus: \($p.mergeStateStatus); rollup state: \($p.commits.nodes[0].commit.statusCheckRollup.state); contexts: \($p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes | length)",
      ($p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[]
       | select(.name == "guard / code-owned" or .context == "guard / code-owned" or .name == "code-owned / sign-off")
       | if .__typename == "CheckRun"
         then "- check run `\(.name)` id \(.databaseId): \(.status)/\(.conclusion), isRequired \(.isRequired), suite \(.checkSuite.databaseId) from \(.checkSuite.workflowRun.workflow.name // "-") on \(.checkSuite.workflowRun.event // "-")"
         else "- status `\(.context)`: \(.state), isRequired \(.isRequired), creator \(.creator.login)" end)' \
    | tee -a "$OUT"
}

note "PR #$PR, head $HEAD"
note ""
note "Actions check suites on this head, oldest first:"
gh api "repos/$R/commits/$HEAD/check-suites?app_id=15368&per_page=100" \
  --jq '.check_suites | sort_by(.id)[] | "- suite \(.id), created \(.created_at)"' | tee -a "$OUT"

note ""
note "### A. API-written guard / code-owned (failure) on this head"
note "suites by workflow run:"
for s in $(gh api "repos/$R/commits/$HEAD/check-suites?app_id=15368&per_page=100" --jq '.check_suites | sort_by(.id)[].id'); do
  note "- $s: $(gh api "repos/$R/actions/runs?check_suite_id=$s" --jq '[.workflow_runs[] | "\(.name) on \(.event)"] | join(", ")')"
done
set +e
resp=$(gh api -i "repos/$R/check-runs" -f name="guard / code-owned" -f head_sha="$HEAD" -f status=completed \
  -f conclusion=failure -f "output[title]=throwaway: failure" -f "output[summary]=API-written" 2>&1)
set -e
note "POST check-runs answered: $(head -1 <<<"$resp")"
note "$(tail -1 <<<"$resp" | head -c 600)"
id=$(tail -1 <<<"$resp" | jq -r '.id // empty' 2>/dev/null || true)
[[ -n $id ]] || note "no check run written"
if [[ -n $id ]]; then
suite=$(gh api "repos/$R/check-runs/$id" --jq .check_suite.id)
note "check run $id landed in suite $suite, whose run is:"
gh api "repos/$R/actions/runs?check_suite_id=$suite" \
  --jq '.workflow_runs[] | "  \(.name), event \(.event), path \(.path)"' | tee -a "$OUT"
sleep 5
reading "A1. After the API-written failure" "$PR"
gh api -X PATCH "repos/$R/check-runs/$id" -f status=completed -f conclusion=success \
  -f "output[title]=throwaway: success" -f "output[summary]=updated in place" --silent
sleep 5
reading "A2. After PATCH in place to success" "$PR"
gh api -X PATCH "repos/$R/check-runs/$id" -f status=completed -f conclusion=failure \
  -f "output[title]=throwaway: failure" -f "output[summary]=updated in place again" --silent
sleep 5
reading "A3. After PATCH back to failure" "$PR"
fi

note ""
note "### B. #629: its API-written check runs landed in the branch's create suite; a commit status instead"
reading "B0. Before" 629
gh api "repos/$R/statuses/$OTHER_HEAD" -f state=success -f context="guard / code-owned" \
  -f description="throwaway #565: status from an Actions token" --silent
sleep 5
reading "B1. After a commit status guard / code-owned (success) from an Actions token" 629

body=$(jq -Rs . <"$OUT")
gh api "repos/$R/check-runs" --input - --silent <<EOF
{"name": "throwaway-565 / readings 2", "head_sha": "$HEAD", "status": "completed", "conclusion": "neutral",
 "output": {"title": "readings 2", "summary": $body}}
EOF

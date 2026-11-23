#!/usr/bin/env bash
# THROWAWAY (#565, never merge). See .github/workflows/throwaway-565-proof.yml.
set -euo pipefail
R=$GITHUB_REPOSITORY
OUT=$RUNNER_TEMP/readings.md
: >"$OUT"
note() { printf '%s\n' "$*" | tee -a "$OUT"; }

# What the merge box reads: the head's rollup, each named check run with its conclusion and whether
# it is required for this PR.
QUERY='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
  mergeStateStatus commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){nodes{
  __typename ... on CheckRun{name databaseId status conclusion isRequired(pullRequestNumber:$n)
  checkSuite{workflowRun{event workflow{name}}}}}}}}}}}}}'
reading() {
  note ""
  note "### $1"
  gh api graphql -f query="$QUERY" -F o="${R%/*}" -F r="${R#*/}" -F n="$PR" --jq '
    .data.repository.pullRequest as $p
    | "mergeStateStatus: \($p.mergeStateStatus); rollup state: \($p.commits.nodes[0].commit.statusCheckRollup.state)",
      ($p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[]
       | select(.name == "guard / code-owned" or .name == "code-owned (run)" or .name == "code-owned / sign-off")
       | "- `\(.name)` id \(.databaseId): \(.status)/\(.conclusion), isRequired \(.isRequired), from \(.checkSuite.workflowRun.workflow.name // "no workflow run") on \(.checkSuite.workflowRun.event // "-")")' \
    | tee -a "$OUT"
}
guard() { # event-file
  set +e
  GITHUB_EVENT_PATH=$1 node .github/scripts/code-owned-guard.mjs --codeowners .github/CODEOWNERS 2>&1 | tee -a "$OUT"
  note "exit ${PIPESTATUS[0]}"
  set -e
}
latest_guard() {
  gh api "repos/$R/commits/$HEAD/check-runs?check_name=guard%20%2F%20code-owned&filter=all" \
    --jq '[.check_runs[]] | max_by(.id) | .id'
}

note "PR #$PR, head $HEAD"
note ""
note "### 1. The new guard script, first run (pull_request event): escalates and writes guard / code-owned"
guard "$GITHUB_EVENT_PATH"
reading "1. After the first run"

note ""
note "### 2. A code-owned / sign-off record written by this branch's workflow (pull_request)"
rec=$(gh api "repos/$R/check-runs" -f name="code-owned / sign-off" -f head_sha="$HEAD" -f status=completed \
  -f conclusion=success -f "output[title]=fake" -f "output[summary]=written by a workflow on the PR's branch" --jq .id)
suite=$(gh api "repos/$R/check-runs/$rec" --jq .check_suite.id)
note "record $rec, check suite $suite"
gh api "repos/$R/actions/runs?check_suite_id=$suite" \
  --jq '.workflow_runs[] | "its workflow run: id \(.id), event \(.event), path \(.path), head_branch \(.head_branch)"' | tee -a "$OUT"
note "fromMain on it:"
REC=$rec SUITE=$suite node --input-type=module -e '
  import { fromMain } from "./.github/scripts/code-owned-guard.mjs";
  const h = { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" };
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  const cr = await (await fetch(`${base}/check-runs/${process.env.REC}`, { headers: h })).json();
  const runs = (await (await fetch(`${base}/actions/runs?check_suite_id=${process.env.SUITE}`, { headers: h })).json()).workflow_runs;
  console.log(`fromMain: ${fromMain(cr, runs.length === 1 ? runs[0] : null)} (app ${cr.app.id}, runs ${runs.length})`);
' | tee -a "$OUT"

note ""
note "### 3. github-actions[bot] removes review:admin; the guard runs on that unlabeled event"
gh api -X DELETE "repos/$R/issues/$PR/labels/review%3Aadmin" --silent
jq '.action = "unlabeled" | .label = {name: "review:admin"} | .sender = {login: "github-actions[bot]", type: "Bot"}' \
  "$GITHUB_EVENT_PATH" >"$RUNNER_TEMP/unlabeled.json"
guard "$RUNNER_TEMP/unlabeled.json"
note "labels now: $(gh api "repos/$R/issues/$PR/labels" --jq '[.[].name] | join(", ")')"
reading "3. After the guard's run on the removal"

note ""
note "### 4. Update the latest guard / code-owned check run in place: success, then failure"
id=$(latest_guard)
note "check run $id"
gh api -X PATCH "repos/$R/check-runs/$id" -f status=completed -f conclusion=success \
  -f "output[title]=throwaway: success" -f "output[summary]=updated in place" --silent
sleep 5
reading "4a. After PATCH to success"
gh api -X PATCH "repos/$R/check-runs/$id" -f status=completed -f conclusion=failure \
  -f "output[title]=throwaway: failure" -f "output[summary]=updated in place again" --silent
sleep 5
reading "4b. After PATCH back to failure"
gh api -X PATCH "repos/$R/check-runs/$id" -f status=completed -f conclusion=success \
  -f "output[title]=throwaway: success" -f "output[summary]=updated in place a third time" --silent
sleep 5
reading "4c. After PATCH to success again"

note ""
note "### 5. Cancel the code-owned (run) job"
run=""
for _ in $(seq 1 60); do
  run=$(gh api "repos/$R/actions/workflows/throwaway-565-run.yml/runs?head_sha=$HEAD" \
    --jq '[.workflow_runs[] | select(.status == "in_progress")][0].id // empty')
  [[ -n $run ]] && break
  sleep 5
done
note "run $run"
gh api -X POST "repos/$R/actions/runs/$run/cancel" --silent
for _ in $(seq 1 60); do
  st=$(gh api "repos/$R/actions/runs/$run" --jq .status)
  [[ $st == completed ]] && break
  sleep 5
done
note "its conclusion: $(gh api "repos/$R/actions/runs/$run" --jq .conclusion)"
reading "5. After the cancelled code-owned (run)"

note ""
note "### 6. Did this branch's pull_request_target copy (throwaway-565-prt.yml) run?"
note "runs of it on this head: $(gh api "repos/$R/actions/runs?head_sha=$HEAD&event=pull_request_target" \
  --jq '[.workflow_runs[] | select(.path == ".github/workflows/throwaway-565-prt.yml")] | length')"
note "pull_request_target runs on this head, by path: $(gh api "repos/$R/actions/runs?head_sha=$HEAD&event=pull_request_target" \
  --jq '[.workflow_runs[].path] | join(", ")')"

body=$(jq -Rs . <"$OUT")
gh api "repos/$R/check-runs" --input - --silent <<EOF
{"name": "throwaway-565 / readings", "head_sha": "$HEAD", "status": "completed", "conclusion": "neutral",
 "output": {"title": "readings", "summary": $body}}
EOF

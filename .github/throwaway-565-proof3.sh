#!/usr/bin/env bash
# THROWAWAY (#565, never merge). Proof 3: a sign-off record a workflow on the PR's branch writes,
# with a real OIDC token for this PR and head, isn't counted; and the guard's verdict (check run and
# commit status) reaches the merge box.
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
reading() {
  note ""
  note "### $1"
  gh api graphql -f query="$QUERY" -F o="${R%/*}" -F r="${R#*/}" -F n="$PR" --jq '
    .data.repository.pullRequest as $p
    | "mergeStateStatus: \($p.mergeStateStatus); rollup state: \($p.commits.nodes[0].commit.statusCheckRollup.state)",
      ($p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[]
       | select(.name == "guard / code-owned" or .context == "guard / code-owned" or .name == "code-owned / sign-off")
       | if .__typename == "CheckRun"
         then "- check run `\(.name)` id \(.databaseId): \(.status)/\(.conclusion), isRequired \(.isRequired), suite from \(.checkSuite.workflowRun.workflow.name // "-") on \(.checkSuite.workflowRun.event // "-")"
         else "- status `\(.context)`: \(.state), isRequired \(.isRequired), creator \(.creator.login)" end)' \
    | tee -a "$OUT"
}

note "PR #$PR, head $HEAD"
note ""
note "### 1. A record from this branch's workflow, with a real OIDC token for this PR and head"
node --input-type=module -e '
  import { audienceOf, fromMain, SIGN_OFF } from "./.github/scripts/code-owned-guard.mjs";
  const { GITHUB_REPOSITORY: repo, PR, HEAD, GH_TOKEN } = process.env;
  const aud = audienceOf(repo, Number(PR), HEAD);
  const t = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(aud)}`,
    { headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  const token = (await t.json()).value;
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  console.log(`token claims: iss ${claims.iss}; aud ${claims.aud}; repository ${claims.repository}; workflow_ref ${claims.workflow_ref}; event_name ${claims.event_name}; ref ${claims.ref}`);
  const h = { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json" };
  const base = `https://api.github.com/repos/${repo}`;
  const rec = await (await fetch(`${base}/check-runs`, { method: "POST", headers: h, body: JSON.stringify({
    name: SIGN_OFF, head_sha: HEAD, status: "completed", conclusion: "success",
    output: { title: "branch-written", summary: `written by a workflow on the PR branch\n\ntoken: ${token}` } }) })).json();
  console.log(`record ${rec.id} written`);
  const listed = (await (await fetch(`${base}/commits/${HEAD}/check-runs?check_name=${encodeURIComponent(SIGN_OFF)}&filter=all`, { headers: h })).json()).check_runs;
  const keys = (await (await fetch("https://token.actions.githubusercontent.com/.well-known/jwks")).json()).keys;
  const { createPublicKey, verify } = await import("node:crypto");
  const [hh, pp, ss] = token.split(".");
  const kid = JSON.parse(Buffer.from(hh, "base64url")).kid;
  const sigOk = verify("RSA-SHA256", Buffer.from(`${hh}.${pp}`), createPublicKey({ key: keys.find((k) => k.kid === kid), format: "jwk" }), Buffer.from(ss, "base64url"));
  console.log(`its signature verifies against the published GitHub keys: ${sigOk}`);
  for (const r of listed) console.log(`fromMain(record ${r.id}): ${fromMain(r, { repo, number: Number(PR), head: HEAD, keys })}`);
' 2>&1 | tee -a "$OUT"

note ""
note "### 2. The guard script on this pull_request event: writes its check run and status"
set +e
node .github/scripts/code-owned-guard.mjs --codeowners .github/CODEOWNERS 2>&1 | grep -v '^code-owned: "' | tee -a "$OUT"
note "exit ${PIPESTATUS[0]}"
set -e
sleep 5
reading "2. After the guard's run"

body=$(jq -Rs . <"$OUT")
gh api "repos/$R/check-runs" --input - --silent <<EOF
{"name": "throwaway-565 / readings 3", "head_sha": "$HEAD", "status": "completed", "conclusion": "neutral",
 "output": {"title": "readings 3", "summary": $body}}
EOF

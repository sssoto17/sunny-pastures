#!/usr/bin/env bash
# A test helper, never run outside a suite: a fake `gh` for scripts/stack.test.sh and
# scripts/open-pr.test.sh. A suite copies it to $work/bin/gh and puts that first on PATH. It
# answers `gh api` over REST the way GitHub returns it, from JSON files, and never reaches GitHub.
#
# State under $work/gh (this file's folder/../gh): pulls/<n>.json, stacks/<n>.json, runs/<id>.json,
# next (the next number: PRs and stacks share it, as on GitHub), labels (the labels that exist,
# one per line) and calls (each call's arguments, one per line, then "--"). A file
# fail_<METHOD>_<endpoint with / as _> fails that call with its text; fail_app_<…> fails it only
# for the App's token, inside a simulated workflow run. --jq runs through jq. reviews_<n>.json and
# checks_<sha>.json are canned reviews and check runs. The remote is $work/remote.git.
# A PR's head.sha and base.sha are its branches' heads on the remote, as GitHub shows them once it
# has seen a push; stale_heads keeps the shas from when the PR opened (GitHub lagging behind).
# POST graphql runs the two draft mutations on the PR whose node_id (PR_<n>) it names.
#
# POST dispatches stands in for the workflows: open-pr runs the real .github/scripts/open-pr.sh
# ($FAKE_WORKFLOW_SCRIPT) and pr-draft the real pr-draft.sh beside it, each with the payload as its
# environment, as sunny-factory[bot], and records the run under runs/, newest id highest.
# events logs, in order, "opened <n> draft=<bool>", each pr-draft request "<state> <prs>" and each
# mutation "marked <n> draft|ready". no_workflow makes the event start nothing; run_pending leaves
# the run in progress.
st=$(cd "$(dirname "$0")/../gh" && pwd)
for a in "$@"; do printf '%s\n' "$a"; done >>"$st/calls"
printf -- '--\n' >>"$st/calls"
[[ $1 == api ]] || { echo "fake: unexpected gh call: $*" >&2; exit 99; }
shift
method=GET endpoint="" filter="" input='{}' silent=0
while (($#)); do
  case $1 in
    -X | --method) method=$2; shift 2 ;;
    --jq | -q) filter=$2; shift 2 ;;
    --silent) silent=1; shift ;;
    --input) [[ $2 == - ]] || { echo "fake: --input takes - only" >&2; exit 98; }; input=$(cat); shift 2 ;;
    -f | -F) # key=value into the JSON body; -F types a number; key[] appends to an array
      k=${2%%=*} v=${2#*=}
      if [[ $1 == -F && $v =~ ^[0-9]+$ ]]; then jv=$v; else jv=$(jq -n --arg v "$v" '$v'); fi
      if [[ $k == *'[]' ]]; then
        input=$(jq --argjson v "$jv" --arg k "${k%'[]'}" '.[$k] += [$v]' <<<"$input")
      else
        input=$(jq --argjson v "$jv" --arg k "$k" '.[$k] = $v' <<<"$input")
      fi
      shift 2 ;;
    -*) echo "fake: unexpected flag $1" >&2; exit 98 ;;
    *) endpoint=$1; shift ;;
  esac
done
path=${endpoint%%\?*} query=""
[[ $endpoint == *\?* ]] && query=${endpoint#*\?}
key=${method}_${path//\//_}
if [[ -f $st/fail_$key ]]; then cat "$st/fail_$key" >&2; exit 1; fi
if [[ -n ${FAKE_APP:-} && -f $st/fail_app_$key ]]; then cat "$st/fail_app_$key" >&2; exit 1; fi
P=repos/sssoto17/sunny-pastures
remote=$st/../remote.git
next() { local n; n=$(cat "$st/next"); echo $((n + 1)) >"$st/next"; echo "$n"; }
pr() { # n -> the PR, its shas live from the remote unless stale_heads
  local j h b
  j=$(cat "$st/pulls/$1.json")
  [[ -f $st/stale_heads ]] && { printf '%s\n' "$j"; return; }
  h=$(git --git-dir="$remote" rev-parse -q --verify "refs/heads/$(jq -r .head.ref <<<"$j")") || h=""
  b=$(git --git-dir="$remote" rev-parse -q --verify "refs/heads/$(jq -r .base.ref <<<"$j")") || b=""
  jq --arg h "$h" --arg b "$b" '(if $h != "" then .head.sha = $h else . end)
    | (if $b != "" then .base.sha = $b else . end)' <<<"$j"
}
stack_json() { # n -> the stack as GET stacks/<n> returns it, parts in order
  local s; s=$(cat "$st/stacks/$1.json")
  jq --slurpfile prs <(for n in $(jq -r '.prs[]' <<<"$s"); do pr "$n"; done) \
    '{number, base: {ref: .base}, open, pull_requests: [$prs[] | {number, state, merged_at,
      head: {ref: .head.ref, sha: .head.sha}, base: {ref: .base.ref}}]}' <<<"$s"
}
set_stack() { # n -> writes .stack on each of its open PRs
  local s i=0 size n; s=$(cat "$st/stacks/$1.json")
  size=$(jq '[.prs[] ] | length' <<<"$s")
  for n in $(jq -r '.prs[]' <<<"$s"); do
    i=$((i + 1))
    jq --argjson num "$1" --argjson pos "$i" --argjson size "$size" --arg base "$(jq -r .base <<<"$s")" \
      '.stack = {number: $num, position: $pos, size: $size, base: {ref: $base}}' \
      "$st/pulls/$n.json" >"$st/tmp" && mv "$st/tmp" "$st/pulls/$n.json"
  done
}
workflow() { # name payload -> runs its step script as the App and records the run
  local id status=completed conclusion=success script fields title
  case $1 in
    open-pr) script=$FAKE_WORKFLOW_SCRIPT fields="branch base title body labels ready"
      title="open-pr $(jq -r .branch <<<"$2")" ;;
    pr-draft) script=${FAKE_WORKFLOW_SCRIPT%/*}/pr-draft.sh fields="state prs"
      title="pr-draft $(jq -r '"\(.state) \(.prs)"' <<<"$2")"
      echo "${title#pr-draft }" >>"$st/events" ;;
  esac
  id=$(($(cat "$st/run_next" 2>/dev/null || echo 9000) + 1))
  echo "$id" >"$st/run_next"
  if [[ ! -f $st/run_pending ]]; then
    (
      export FAKE_APP=1 FAKE_LOGIN='sunny-factory[bot]' GITHUB_REPOSITORY=sssoto17/sunny-pastures
      export GITHUB_OUTPUT=$st/run_$id.output GITHUB_STEP_SUMMARY=$st/run_$id.summary
      for f in $fields; do
        export "${f^^}=$(jq -r --arg f "$f" '.[$f] // ""' <<<"$2")"
      done
      bash "$script"
    ) >"$st/run_$id.log" 2>&1 || conclusion=failure
  else
    status=in_progress conclusion=""
  fi
  jq -n --argjson id "$id" --arg s "$status" --arg c "$conclusion" --arg t "$title" --arg w "$1" \
    '{id: $id, status: $s, conclusion: (if $c == "" then null else $c end), display_title: $t,
      workflow: $w, event: "repository_dispatch", html_url: "https://github.com/runs/\($id)"}' \
    >"$st/runs/$id.json"
}
out=""
case "$method $path" in
  "GET $P/pulls")
    head=$(sed -n 's/.*head=[^:]*:\([^&]*\).*/\1/p' <<<"$query")
    out=$(for f in "$st"/pulls/*.json; do [[ -f $f ]] && cat "$f"; done |
      jq -s --arg h "$head" '[.[] | select(.state == "open" and .head.ref == $h)]') ;;
  "POST $P/pulls")
    n=$(next)
    sha=$(git --git-dir="$remote" rev-parse "refs/heads/$(jq -r .head <<<"$input")" 2>/dev/null || echo unknown)
    jq --argjson n "$n" --arg sha "$sha" --arg login "${FAKE_LOGIN:-sssoto17}" '{number: $n, state: "open",
      merged_at: null, title, body, draft: (.draft // false), node_id: "PR_\($n)",
      user: {login: $login}, head: {ref: .head, sha: $sha, repo: {full_name: "sssoto17/sunny-pastures"}},
      base: {ref: .base}, stack: null}' \
      <<<"$input" >"$st/pulls/$n.json"
    echo "opened $n draft=$(jq .draft "$st/pulls/$n.json")" >>"$st/events"
    out=$(pr "$n") ;;
  "GET $P/pulls/"*/reviews)
    n=${path#"$P"/pulls/}; n=${n%/reviews}
    out=$(cat "$st/reviews_$n.json" 2>/dev/null || echo '[]') ;;
  "GET $P/pulls/"*)
    n=${path#"$P"/pulls/}
    [[ -f $st/pulls/$n.json ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    out=$(pr "$n") ;;
  "GET $P/branches/"*)
    b=${path#"$P"/branches/}
    sha=$(git --git-dir="$remote" rev-parse -q --verify "refs/heads/$b") ||
      { echo "gh: Branch not found (HTTP 404)" >&2; exit 1; }
    out=$(jq -n --arg b "$b" --arg sha "$sha" '{name: $b, commit: {sha: $sha}}') ;;
  "GET $P/labels/"*)
    l=${path#"$P"/labels/}
    grep -qxF -- "$l" "$st/labels" 2>/dev/null || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    out=$(jq -n --arg l "$l" '{name: $l}') ;;
  "GET $P/commits/"*/check-runs)
    sha=${path#"$P"/commits/}; sha=${sha%/check-runs}
    out=$(cat "$st/checks_$sha.json" 2>/dev/null || echo '{"total_count":0,"check_runs":[]}') ;;
  "POST $P/issues/"*/labels)
    out='[]' ;;
  "POST $P/stacks")
    prs=$(jq -c .pull_requests <<<"$input")
    (($(jq length <<<"$prs") >= 2)) || { echo "gh: 2 items required (HTTP 422)" >&2; exit 1; }
    base=$(jq -r ".base.ref" "$st/pulls/$(jq '.[0]' <<<"$prs").json")
    n=$(next)
    jq -n --argjson n "$n" --argjson prs "$prs" --arg base "$base" \
      '{number: $n, base: $base, open: true, prs: $prs}' >"$st/stacks/$n.json"
    set_stack "$n"
    out=$(stack_json "$n") ;;
  "POST $P/stacks/"*/add)
    n=${path#"$P"/stacks/}; n=${n%/add}
    jq --argjson add "$(jq -c .pull_requests <<<"$input")" '.prs += $add' "$st/stacks/$n.json" >"$st/tmp" &&
      mv "$st/tmp" "$st/stacks/$n.json"
    set_stack "$n"
    out=$(stack_json "$n") ;;
  "GET $P/stacks/"*)
    n=${path#"$P"/stacks/}
    [[ -f $st/stacks/$n.json ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    out=$(stack_json "$n") ;;
  "POST $P/dispatches")
    jq -c . <<<"$input" >>"$st/dispatches"
    ev=$(jq -r .event_type <<<"$input")
    [[ ($ev == open-pr || $ev == pr-draft) && ! -f $st/no_workflow ]] &&
      workflow "$ev" "$(jq -c .client_payload <<<"$input")"
    silent=1 ;;
  "GET $P/actions/workflows/"*.yml/runs)
    w=${path#"$P"/actions/workflows/}; w=${w%.yml/runs}
    out=$(for f in "$st"/runs/*.json; do [[ -f $f ]] && cat "$f"; done |
      jq -s --arg w "$w" '[.[] | select((.workflow // "open-pr") == $w)]
        | {total_count: length, workflow_runs: (sort_by(.id) | reverse)}') ;;
  "POST graphql")
    m=$(jq -r .query <<<"$input" | grep -oE 'convertPullRequestToDraft|markPullRequestReadyForReview')
    n=$(jq -r .id <<<"$input"); n=${n#PR_}
    [[ -n $m && -f $st/pulls/$n.json ]] || { echo "gh: Could not resolve to a node (HTTP 200)" >&2; exit 1; }
    d=$([[ $m == convertPullRequestToDraft ]] && echo true || echo false)
    jq --argjson d "$d" '.draft = $d' "$st/pulls/$n.json" >"$st/tmp" && mv "$st/tmp" "$st/pulls/$n.json"
    echo "marked $n $([[ $d == true ]] && echo draft || echo ready)" >>"$st/events"
    out=$(jq -n --arg m "$m" --argjson n "$n" --argjson d "$d" '{data: {($m): {pullRequest: {number: $n, isDraft: $d}}}}') ;;
  *) echo "fake: unexpected endpoint $method $endpoint" >&2; exit 97 ;;
esac
((silent)) && exit 0
if [[ -n $filter ]]; then jq -r "$filter" <<<"$out"; else printf '%s\n' "$out"; fi

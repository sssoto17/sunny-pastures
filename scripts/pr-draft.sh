#!/usr/bin/env bash
# Turns lane PRs into drafts, or marks them ready for review, from local and cloud lanes alike
# (#358; ADR-0002, area 2, "Stacks"). It sends repository_dispatch `pr-draft`, and main's pr-draft
# workflow switches the PRs as sunny-factory[bot] with the App's token: the REST update endpoint has
# no draft field, the cloud proxy refuses GraphQL, and a ready mark made with GITHUB_TOKEN would
# start no CI. Then it waits until GitHub shows every PR in the asked state. scripts/stack.sh and
# scripts/open-pr.sh call it around the pushes and opens that would otherwise run CI twice a head.
# Tests: scripts/pr-draft.test.sh. Needs bash 4+, jq and an authenticated gh.
set -euo pipefail
shopt -s inherit_errexit

REPO=sssoto17/sunny-pastures
P=repos/$REPO
RUNS="$P/actions/workflows/pr-draft.yml/runs?event=repository_dispatch&per_page=30"
TIMEOUT=${PR_DRAFT_TIMEOUT:-120} POLL=${PR_DRAFT_POLL:-3}

usage() {
  cat >&2 <<'EOF'
usage: scripts/pr-draft.sh draft|ready <pr>...

  Turns each PR into a draft, or marks it ready for review, through the pr-draft workflow (as
  sunny-factory[bot]), and waits until GitHub shows it. A PR already in that state is left out;
  with none left, nothing is sent. The workflow refuses a PR that isn't open or whose head isn't a
  lane branch, and then this prints the run's link.
  PR_DRAFT_TIMEOUT (seconds, default 120) bounds the wait.
Exit codes: 0 every PR is in the state; 1 a gh command, the run or the wait failed; 2 refused,
nothing sent.
EOF
}

die() { # code message
  printf 'pr-draft: %s\n' "$2" >&2
  exit "$1"
}

case ${1:-} in
  -h | --help) usage; exit 0 ;;
  draft) want=true ;;
  ready) want=false ;;
  *) usage; exit 2 ;;
esac
state=$1
shift
(($#)) || { usage; exit 2; }
prs=()
for n in "$@"; do
  [[ $n =~ ^[1-9][0-9]*$ ]] || die 2 "not a PR number: $n"
  [[ " ${prs[*]-} " == *" $n "* ]] || prs+=("$n")
done

draft_of() { gh api "$P/pulls/$1" --jq .draft; }
todo=()
for n in "${prs[@]}"; do
  d=$(draft_of "$n") || die 1 "can't read PR #$n"
  [[ $d == "$want" ]] || todo+=("$n")
done
((${#todo[@]})) || exit 0
list=$(IFS=,; echo "${todo[*]}")

# The newest run before this dispatch: an older run is never read as this one's answer.
before=$(gh api "$RUNS" --jq '[.workflow_runs[].id] | max // 0' 2>/dev/null) || before=""
jq -n --arg state "$state" --arg prs "$list" \
  '{event_type: "pr-draft", client_payload: {state: $state, prs: $prs}}' |
  gh api -X POST "$P/dispatches" --input - --silent || die 1 "the dispatch failed"
echo "pr-draft: asked the pr-draft workflow to mark $(printf '#%s ' "${todo[@]}")$state" >&2

run_state() { # -> "<status> <conclusion> <url>" of this dispatch's run, or nothing
  [[ -n $before ]] || return 0
  gh api "$RUNS" 2>/dev/null | jq -r --argjson before "$before" --arg t "pr-draft $state $list" '
    [.workflow_runs[] | select(.id > $before and .display_title == $t)] | min_by(.id)
    | select(. != null) | "\(.status) \(.conclusion) \(.html_url)"' || true
}

start=$SECONDS
while :; do
  left=()
  for n in "${todo[@]}"; do
    d=$(draft_of "$n") || d="" # one failed read doesn't end the wait
    [[ $d == "$want" ]] || left+=("$n")
  done
  ((${#left[@]})) || break
  read -r status conclusion url <<<"$(run_state)" || true
  if [[ ${status:-} == completed && $conclusion != success ]]; then
    die 1 "the pr-draft run failed ($conclusion), and says why: $url"
  fi
  ((SECONDS - start < TIMEOUT)) ||
    die 1 "after $TIMEOUT s GitHub doesn't show $(printf '#%s ' "${left[@]}")as $state${url:+; the run: $url}"
  sleep "$POLL"
done
echo "pr-draft: $(printf '#%s ' "${todo[@]}")$state" >&2

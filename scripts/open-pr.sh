#!/usr/bin/env bash
# The one way a lane opens a PR (#336; ADR-0002, area 2, "Lanes open PRs as sunny-factory"), local
# or cloud: the lane pushes its branch as today, then this sends repository_dispatch, and the
# open-pr workflow on main opens the PR as sunny-factory[bot] with the App's token, which never
# enters a session. So the admin is a reviewer of the PR, not its author. It waits for that run
# and prints the PR's number, alone, on stdout. scripts/stack.sh opens each stack part through it.
# REST only (`gh api`), since the cloud GitHub proxy refuses GraphQL (`gh pr create` uses it).
# Tests: scripts/open-pr.test.sh. Needs bash 4+, git, jq and an authenticated gh.
set -euo pipefail
shopt -s inherit_errexit

REPO=sssoto17/sunny-pastures
P=repos/$REPO
RUNS="$P/actions/workflows/open-pr.yml/runs?event=repository_dispatch&per_page=30"
TIMEOUT=${OPEN_PR_TIMEOUT:-300} POLL=${OPEN_PR_POLL:-5}

usage() {
  cat >&2 <<'EOF'
usage: scripts/open-pr.sh [--base <branch>] [--label <name>]... [--dry-run] <branch> <body-file>

  Opens <branch>'s PR as sunny-factory[bot] and prints its number. Push the branch first. The
  body file's first line is the PR's title; the rest is its body.
  --base     the branch the PR goes onto (default main); a stack part's base is the part
             below, and the workflow links it into that part's stack. Use scripts/stack.sh for
             stacks: it calls this for each part.
  --label    a label the App adds (it must exist); repeat for more.
  --dry-run  check and print the dispatch request, send nothing.

A branch that already has an open PR prints that PR's number and sends nothing. The workflow
refuses main, names outside the lanes' (<N>-<slug>, claude/<name>) and a base with no open PR;
this script then prints the run's link. OPEN_PR_TIMEOUT (seconds, default 300) bounds the wait.
Exit codes: 0 the PR is open; 1 a gh command, the run or the wait failed; 2 refused, nothing sent.
EOF
}

die() { # code message
  printf 'open-pr: %s\n' "$2" >&2
  exit "$1"
}

base=main labels=() dry=0
while (($#)); do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --base) (($# >= 2)) || die 2 "--base needs a branch"; base=$2; shift 2 ;;
    --label) (($# >= 2)) || die 2 "--label needs a name"; labels+=("$2"); shift 2 ;;
    --dry-run) dry=1; shift ;;
    -*) usage; die 2 "unknown option: $1" ;;
    *) break ;;
  esac
done
(($# == 2)) || { usage; exit 2; }
branch=$1 file=$2

[[ -r $file ]] || die 2 "can't read the body file $file"
title=$(head -n1 "$file")
[[ -n ${title//[[:space:]]/} ]] || die 2 "the body file $file has no title on its first line"
body=$(tail -n +2 "$file" | sed '/./,$!d')

open_pr_for() { gh api "$P/pulls?head=${REPO%%/*}:$1&state=open" --jq '.[0].number // empty'; }

# What GitHub has, before anything is sent.
remote=$(gh api "$P/branches/$branch" --jq .commit.sha 2>/dev/null) ||
  die 2 "no branch $branch on origin: push it first (git push origin $branch)"
if local=$(git rev-parse -q --verify "refs/heads/$branch"); then
  [[ $local == "$remote" ]] ||
    die 2 "your $branch isn't the one on origin: push it first (git push origin $branch)"
fi
found=$(open_pr_for "$branch")
if [[ -n $found ]]; then
  printf 'open-pr: %s already open as #%s\n' "$branch" "$found" >&2
  echo "$found"
  exit 0
fi

# Five properties of the ten client_payload allows; the whole payload stays under 64 KB.
request=$(jq -n --arg branch "$branch" --arg base "$base" --arg title "$title" --arg body "$body" \
  --arg labels "$(IFS=,; echo "${labels[*]-}")" \
  '{event_type: "open-pr", client_payload: {branch: $branch, base: $base, title: $title,
    body: $body, labels: $labels}}')
(($(jq -c .client_payload <<<"$request" | wc -c) < 65536)) ||
  die 2 "the title and body are over client_payload's 64 KB: shorten the body"

if ((dry)); then
  echo "open-pr: dry run, nothing sent; the request:" >&2
  printf '%s\n' "$request"
  exit 0
fi

# The newest run before this dispatch: an older run is never read as this one's answer.
before=$(gh api "$RUNS" --jq '[.workflow_runs[].id] | max // 0' 2>/dev/null) || before=""
gh api -X POST "$P/dispatches" --input - --silent <<<"$request" || die 1 "the dispatch failed"
echo "open-pr: asked the open-pr workflow to open $branch onto $base" >&2

run_state() { # -> "<status> <conclusion> <url>" of this dispatch's run, or nothing
  [[ -n $before ]] || return 0
  gh api "$RUNS" 2>/dev/null | jq -r --argjson before "$before" --arg t "open-pr $branch" '
    [.workflow_runs[] | select(.id > $before and .display_title == $t)] | min_by(.id)
    | select(. != null) | "\(.status) \(.conclusion) \(.html_url)"' || true
}

start=$SECONDS url="" pr=""
while :; do
  read -r status conclusion url <<<"$(run_state)" || true
  if [[ ${status:-} == completed ]]; then
    [[ $conclusion == success ]] || die 1 "the open-pr run failed ($conclusion), and says why: $url"
    pr=$(open_pr_for "$branch")
    [[ -n $pr ]] || die 1 "the open-pr run passed but $branch has no open PR: $url"
    break
  fi
  # With the runs unreadable, the PR's arrival answers; otherwise wait for the run to end, since
  # it links a stack part after opening it.
  pr=$(open_pr_for "$branch") || pr="" # one failed read doesn't end the wait
  [[ -n $pr && -z $before ]] && break
  if ((SECONDS - start >= TIMEOUT)); then
    if [[ -n $pr ]]; then
      echo "open-pr: #$pr is open, but its run hasn't finished${url:+: $url}" >&2
      break
    fi
    die 1 "no PR for $branch after $TIMEOUT s${url:+; the run: $url}. See gh api '$RUNS'"
  fi
  sleep "$POLL"
done
echo "open-pr: opened #$pr as the App" >&2
echo "$pr"

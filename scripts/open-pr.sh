#!/usr/bin/env bash
# The one way a lane opens a PR (#336; ADR-0002, area 2, "Lanes open PRs as sunny-factory"), local
# or cloud: the lane pushes its branch as today, then this sends repository_dispatch, and the
# open-pr workflow on main opens the PR as sunny-factory[bot] with the App's token, which never
# enters a session. So the admin is a reviewer of the PR, not its author. It waits for that run
# and prints the PR's number, alone, on stdout. scripts/stack.sh opens each stack part through it.
# REST only (`gh api`), since the cloud GitHub proxy refuses GraphQL (`gh pr create` uses it).
# --as-admin (#385; ADR-0007, "Acceptance tests") opens the PR with the session's own credentials,
# the admin's, for work the admin commissions on admin-owned paths such as tests/acceptance/**. It
# works only when the admin's launch set OPEN_PR_AS_ADMIN to the issue the PR links.
# Tests: scripts/open-pr.test.sh. Needs bash 4+, git, jq and an authenticated gh.
set -euo pipefail
shopt -s inherit_errexit

REPO=sssoto17/sunny-pastures
P=repos/$REPO
RUNS="$P/actions/workflows/open-pr.yml/runs?event=repository_dispatch&per_page=30"
TIMEOUT=${OPEN_PR_TIMEOUT:-300} POLL=${OPEN_PR_POLL:-5}

usage() {
  cat >&2 <<'EOF'
usage: scripts/open-pr.sh [--as-admin] [--base <branch>] [--label <name>]... [--dry-run]
                          <branch> <body-file>

  Opens <branch>'s PR as sunny-factory[bot] and prints its number. Push the branch first. The
  body file's first line is the PR's title; the rest is its body.
  --base     the branch the PR goes onto (default main); a stack part's base is the part
             below, and the workflow links it into that part's stack. Use scripts/stack.sh for
             stacks: it calls this for each part.
  --label    a label the App adds (it must exist); repeat for more.
  --dry-run  check and print the dispatch request, send nothing.
  --as-admin open the PR as the admin, not the App, for admin-owned paths such as
             tests/acceptance/** only (#385). Refused unless OPEN_PR_AS_ADMIN, set by the admin's
             launch command, names the issue the body links (Closes #N or Part of #N). The body
             gets a line saying a lane opened it as the admin. A stack part opened this way is
             linked by scripts/stack.sh, not the workflow.

A branch that already has an open PR prints that PR's number and sends nothing. The workflow
refuses main, names outside the lanes' (<N>-<slug>, claude/<name>) and a base with no open PR;
this script then prints the run's link. OPEN_PR_TIMEOUT (seconds, default 300) bounds the wait.
Exit codes: 0 the PR is open; 1 a gh command, the run or the wait failed (with --as-admin, a
label too: the PR's number is still printed); 2 refused, nothing sent.
EOF
}

die() { # code message
  printf 'open-pr: %s\n' "$2" >&2
  exit "$1"
}

base=main labels=() dry=0 as_admin=0
while (($#)); do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --base) (($# >= 2)) || die 2 "--base needs a branch"; base=$2; shift 2 ;;
    --label) (($# >= 2)) || die 2 "--label needs a name"; labels+=("$2"); shift 2 ;;
    --dry-run) dry=1; shift ;;
    --as-admin) as_admin=1; shift ;;
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

if ((as_admin)); then # the gate: the admin's launch, not a brief, names the commissioned issue
  issue=${OPEN_PR_AS_ADMIN:-}
  [[ -n $issue ]] || die 2 "--as-admin needs OPEN_PR_AS_ADMIN=<issue>, which only the admin's \
launch command sets (#385): without it, open the PR as the App"
  [[ $issue =~ ^[1-9][0-9]*$ ]] || die 2 "OPEN_PR_AS_ADMIN must be an issue number, got: $issue"
  shopt -s nocasematch
  [[ $body =~ (^|[^[:alnum:]])(closes|part\ of)\ \#$issue([^0-9]|$) ]] ||
    die 2 "the body doesn't link #$issue (Closes #$issue or Part of #$issue), the issue"
  shopt -u nocasematch
  # The workflow's refusals, here since no workflow runs (.github/scripts/open-pr.sh).
  lane='^([0-9]+-[a-z0-9]+(-[a-z0-9]+)*|claude/[A-Za-z0-9._-]+)$'
  [[ $branch != main ]] || die 2 "never from main: a PR comes from a lane branch"
  [[ $branch =~ $lane ]] || die 2 "$branch isn't a lane branch (<N>-<slug> or claude/<name>)"
  [[ $base == main || $base =~ $lane ]] || die 2 "the base $base isn't main or a lane branch"
  [[ $base != "$branch" ]] || die 2 "a PR can't go onto itself"
  ((${#title} <= 256)) || die 2 "the title is over 256 characters"
  for l in ${labels[@]+"${labels[@]}"}; do
    [[ $l =~ ^[A-Za-z0-9:._-]+$ ]] || die 2 "$l is not a label name here"
  done
  body+=$'\n\n'"Opened as the admin by a lane, with \`scripts/open-pr.sh --as-admin\` on a run the"
  body+=" admin started for #$issue (#385)."
fi

open_pr_for() { gh api "$P/pulls?head=${REPO%%/*}:$1&state=open" --jq '.[0].number // empty'; }

# What GitHub has, before anything is sent.
remote=$(gh api "$P/branches/$branch" --jq .commit.sha 2>/dev/null) ||
  die 2 "no branch $branch on origin: push it first (git push origin $branch)"
if local=$(git rev-parse -q --verify "refs/heads/$branch"); then
  [[ $local == "$remote" ]] ||
    die 2 "your $branch isn't the one on origin: push it first (git push origin $branch)"
fi
found=$(open_pr_for "$branch")
if [[ -n $found ]] && ((as_admin)); then # the App's PR would fail guard / acceptance (#384)
  author=$(gh api "$P/pulls/$found" --jq .user.login)
  [[ $author != *'[bot]' ]] ||
    die 2 "#$found was opened by $author, so it can't carry admin-owned paths: close it, then run this again"
fi
if [[ -n $found ]]; then
  printf 'open-pr: %s already open as #%s\n' "$branch" "$found" >&2
  echo "$found"
  exit 0
fi

# The switch (a guard clause on the main path): straight to REST with the session's credentials,
# the admin's; no dispatch, no App.
if ((as_admin)); then
  ((${#body} <= 65536)) || die 2 "the body is over 65536 characters, GitHub's limit"
  for l in ${labels[@]+"${labels[@]}"}; do
    gh api "$P/labels/$l" --silent 2>/dev/null || die 2 "no label $l in the repo, or it couldn't be read"
  done
  if [[ $base != main && -z $(open_pr_for "$base") ]]; then
    die 2 "the base $base has no open PR: a stack part goes onto the part below's PR"
  fi
  request=$(jq -n --arg head "$branch" --arg base "$base" --arg title "$title" --arg body "$body" \
    '{title: $title, head: $head, base: $base, body: $body}')
  if ((dry)); then
    echo "open-pr: dry run, nothing sent; the request to open the PR as the admin:" >&2
    printf '%s\n' "$request"
    exit 0
  fi
  pr=$(gh api -X POST "$P/pulls" --input - --jq .number <<<"$request") ||
    die 1 "GitHub refused to open the PR"
  code=0
  for l in ${labels[@]+"${labels[@]}"}; do
    gh api -X POST "$P/issues/$pr/labels" --silent -f "labels[]=$l" || {
      echo "open-pr: #$pr is open, but adding the label $l failed: add it by hand" >&2
      code=1
    }
  done
  echo "open-pr: opened #$pr as the admin" >&2
  echo "$pr"
  exit "$code"
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

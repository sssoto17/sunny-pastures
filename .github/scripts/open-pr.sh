#!/usr/bin/env bash
# The open-pr workflow's one step (#336; ADR-0002, area 2, "Lanes open PRs as sunny-factory"): opens
# a lane's PR as sunny-factory[bot] with the App token in GH_TOKEN, and links a stack part into the
# stack of the part below. The lane sent the request with scripts/open-pr.sh.
#
# Every input comes from repository_dispatch's client_payload, which anyone with write access can
# send: BRANCH, BASE, TITLE, BODY, LABELS reach this script only as environment variables, are
# checked before any write, and are passed to gh as values (jq --arg, -f), never as shell code.
# Refusals: main, a branch outside the lanes' naming, a branch not on origin, a branch with an
# open PR, a base that isn't main or a lane branch with an open PR, a title or body past
# GitHub's limits. Labels that don't exist are skipped. A refused label or stack link is a warning:
# the PR stands, and scripts/stack.sh links the stack itself.
# Outputs: pr=<number>, stack=<number>|refused|none. Exit codes: 0 opened; 1 GitHub refused the
# PR; 2 the request was refused, nothing written.
# Tests: .github/scripts/tests/open-pr.test.mjs
set -euo pipefail

R=repos/$GITHUB_REPOSITORY
OWNER=${GITHUB_REPOSITORY%%/*}
# The lanes' branch names (ADR-0002, area 1, "Branch names"): <N>-<slug>, or the cloud
# harness's claude/<name>.
LANE='^([0-9]+-[a-z0-9]+(-[a-z0-9]+)*|claude/[A-Za-z0-9._-]+)$'

# A message may quote the payload: escaped as workflow commands require, so a newline in it can't
# start a command of its own (::stop-commands::, ::add-mask:: …).
esc() { local s=${1//'%'/%25}; s=${s//$'\r'/%0D}; printf '%s' "${s//$'\n'/%0A}"; }
refuse() { # message
  echo "::error title=open-pr::$(esc "$1")"
  printf 'Refused: %s\n' "$(esc "$1")" >>"$GITHUB_STEP_SUMMARY"
  exit 2
}
warn() { echo "::warning title=open-pr::$(esc "$1")"; }
# A name of dots only is a path step (`..`), never a name: refused for branches and labels.
dots_only() { [[ $1 =~ ^\.+$ ]]; }
is_lane() { [[ $1 =~ $LANE ]] && ! dots_only "${1#claude/}"; }
on_origin() { gh api "$R/branches/$1" --jq .name >/dev/null 2>&1; }
open_pr() { gh api "$R/pulls?head=$OWNER:$1&state=open" --jq '.[0].number // empty'; }

BASE=${BASE:-main}
[[ $BRANCH != main ]] || refuse "never opens a PR from main"
is_lane "$BRANCH" || refuse "the branch '$BRANCH' isn't a lane branch (<N>-<slug> or claude/<name>)"
[[ $BASE == main ]] || is_lane "$BASE" || refuse "the base $BASE isn't main or a lane branch"
[[ $BASE != "$BRANCH" ]] || refuse "a PR can't go onto itself"
[[ -n ${TITLE//[[:space:]]/} ]] || refuse "no title"
((${#TITLE} <= 256)) || refuse "the title is over 256 characters"
((${#BODY} <= 65536)) || refuse "the body is over 65536 characters, GitHub's limit"

on_origin "$BRANCH" || refuse "no branch $BRANCH on origin: push it first"
on_origin "$BASE" || refuse "no branch $BASE on origin"
existing=$(open_pr "$BRANCH")
[[ -z $existing ]] || refuse "$BRANCH already has PR #$existing"
below=""
if [[ $BASE != main ]]; then
  below=$(open_pr "$BASE")
  [[ -n $below ]] || refuse "the base $BASE has no open PR: a stack part goes onto the part below's PR"
fi

pr=$(jq -n --arg title "$TITLE" --arg head "$BRANCH" --arg base "$BASE" --arg body "$BODY" \
  '{title: $title, head: $head, base: $base, body: $body}' |
  gh api -X POST "$R/pulls" --input - --jq .number) || {
  echo "::error title=open-pr::opening the PR failed (see gh's message above)"
  exit 1
}
echo "pr=$pr" >>"$GITHUB_OUTPUT"
echo "opened #$pr: $BRANCH onto $BASE"

# Labels: only names that exist, so the token never creates one.
add=()
IFS=, read -r -a wanted <<<"${LABELS:-}"
for l in ${wanted[@]+"${wanted[@]}"}; do
  l=${l#"${l%%[![:space:]]*}"} l=${l%"${l##*[![:space:]]}"} # trimmed
  [[ -n $l ]] || continue
  if [[ ! $l =~ ^[A-Za-z0-9:._-]+$ ]] || dots_only "$l"; then warn "label $l: not a label name here, skipped"; continue; fi
  if gh api "$R/labels/$l" --jq .name >/dev/null 2>&1; then
    add+=(-f "labels[]=$l")
  else
    warn "label $l doesn't exist, skipped"
  fi
done
if ((${#add[@]})); then
  gh api -X POST "$R/issues/$pr/labels" --silent "${add[@]}" || warn "adding the labels to #$pr failed"
fi

# A stack part: join the stack of the part below, or start one with it. Whether /stacks takes an
# App token is recorded here; a refusal leaves the linking to scripts/stack.sh.
stack=none
if [[ -n $below ]]; then
  s=$(gh api "$R/pulls/$below" --jq '.stack.number // empty') || s=""
  if [[ -n $s ]]; then
    gh api -X POST "$R/stacks/$s/add" -F "pull_requests[]=$pr" --silent && stack=$s
  else
    s=$(gh api -X POST "$R/stacks" -F "pull_requests[]=$below" -F "pull_requests[]=$pr" --jq .number) &&
      stack=$s
  fi || true
  if [[ $stack == none ]]; then
    stack=refused
    warn "linking #$pr into a stack failed with the App token (see gh's message above); scripts/stack.sh links it"
  fi
fi
echo "stack=$stack" >>"$GITHUB_OUTPUT"

{
  echo "Opened #$pr as the App: \`$BRANCH\` onto \`$BASE\`."
  case $stack in
    none) ;;
    refused) echo "Linking it into a stack with the App token was refused." ;;
    *) echo "Linked into stack #$stack with the App token." ;;
  esac
} >>"$GITHUB_STEP_SUMMARY"

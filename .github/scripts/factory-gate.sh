#!/usr/bin/env bash
# The factory's eligibility gate (#107; ADR-0002, area 2, "How a factory job starts"): after the
# kill switch, before Claude. An issue is worked only when it is an open issue that carries
# `factory:ready` and, on the Sunny Pastures board, has Status Ready and Mode Factory. Writes
# run=true only when all of that holds; every refusal is one `GATE refused:` line in the log, a
# warning annotation and a line in the step summary, and exits 0 (a refusal isn't a failure).
#
# Two phases, so a refusal on the issue alone comes before the App's key mints anything:
#   1. without BOARD_JSON: checks the inputs and the issue; writes issue_ok=true|false, run=false.
#   2. with BOARD_JSON: checks all of it again plus the board; writes run=true|false.
# Both write issue=<n> and turns=<n>, the checked values the later steps use instead of the inputs.
#
# Env: ISSUE and MAX_TURNS (the dispatch inputs, through env:, never ${{ }} in run:), ISSUE_JSON
# (GET /repos/{o}/{r}/issues/{n}), BOARD_JSON (the GraphQL answer for the issue's projectItems, or
# whatever the failed read left), PROJECT_URL (the board's URL), GITHUB_OUTPUT, and
# GITHUB_STEP_SUMMARY (optional). An unreadable ISSUE_JSON fails the step rather than guess; an
# unreadable board is a refusal, since #102 found the App's token can't read the user-owned
# Project: the gate fails closed.
# Tests: .github/scripts/tests/factory-gate.test.mjs
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"
: "${PROJECT_URL:?PROJECT_URL is not set}"
CAP=100 # --max-turns, decided by the admin (21 Nov 2026); the input may only lower it

# A message may quote GitHub's answer or an input: escaped as workflow commands require, so a
# newline can't start a command of its own (::add-mask::, ::stop-commands:: …).
esc() { local s=${1//'%'/%25}; s=${s//$'\r'/%0D}; printf '%s' "${s//$'\n'/%0A}"; }
refuse() { # message
  local m
  m=$(esc "$1")
  echo "GATE refused: $m"
  echo "::warning title=factory refused::$m"
  [[ -z ${GITHUB_STEP_SUMMARY:-} ]] || printf 'Refused: %s\n' "$m" >>"$GITHUB_STEP_SUMMARY"
  echo "issue_ok=false" >>"$GITHUB_OUTPUT"
  echo "run=false" >>"$GITHUB_OUTPUT"
  exit 0
}

# The inputs. Nothing else is written until both are checked, so a forged value never reaches
# GITHUB_OUTPUT.
issue=${ISSUE-}
[[ $issue =~ ^[1-9][0-9]{0,6}$ ]] || refuse "the issue input $(printf %q "$issue") isn't an issue number"
turns=${MAX_TURNS:-$CAP}
if [[ ! $turns =~ ^[1-9][0-9]{0,2}$ ]] || ((turns > CAP)); then
  refuse "max_turns $(printf %q "$turns") must be a whole number from 1 to $CAP"
fi
echo "issue=$issue" >>"$GITHUB_OUTPUT"
echo "turns=$turns" >>"$GITHUB_OUTPUT"

# The issue. jq -e fails the step on a file that isn't the JSON it expects.
number=$(jq -er '.number' "$ISSUE_JSON")
[[ $number == "$issue" ]] || refuse "the issue read back is #$number, not #$issue"
[[ $(jq -r '.pull_request != null' "$ISSUE_JSON") == false ]] || refuse "#$issue is a pull request, not an issue"
state=$(jq -er '.state' "$ISSUE_JSON")
[[ $state == open ]] || refuse "#$issue is $state"
[[ $(jq -r '[.labels[]?.name] | index("factory:ready") != null' "$ISSUE_JSON") == true ]] ||
  refuse "#$issue doesn't carry factory:ready"

if [[ -z ${BOARD_JSON:-} ]]; then
  echo "GATE issue ok: #$issue is open and carries factory:ready; the board is next"
  echo "issue_ok=true" >>"$GITHUB_OUTPUT"
  echo "run=false" >>"$GITHUB_OUTPUT"
  exit 0
fi

# The board. Anything but a clean answer naming this board's item is a refusal.
jq -e . "$BOARD_JSON" >/dev/null 2>&1 ||
  refuse "BOARD unreadable: the read returned no JSON ($(head -c 200 "$BOARD_JSON" | tr -d '\0'))"
err=$(jq -r '[.errors[]?.message] | join("; ")' "$BOARD_JSON")
[[ -z $err ]] || refuse "BOARD unreadable: $err"
found=$(jq -c --arg url "$PROJECT_URL" '[.data.repository.issue.projectItems.nodes[]?
  | select(.project.url == $url)] | .[0] // empty' "$BOARD_JSON")
[[ -n $found ]] ||
  refuse "#$issue isn't on the board $PROJECT_URL, or the App can't read it (#102)"
status=$(jq -r '.status.name // "unset"' <<<"$found")
mode=$(jq -r '.mode.name // "unset"' <<<"$found")
[[ $status == Ready ]] || refuse "#$issue's Status is $status, not Ready"
[[ $mode == Factory ]] || refuse "#$issue's Mode is $mode, not Factory"

echo "GATE run: #$issue is Ready, Mode Factory and carries factory:ready (max-turns $turns)"
echo "issue_ok=true" >>"$GITHUB_OUTPUT"
echo "run=true" >>"$GITHUB_OUTPUT"

#!/usr/bin/env bash
# The factory's eligibility gate (#107; ADR-0002, area 2, "The factory workflow, built"): after the
# kill switch, before Claude. An issue is worked only when it is an open issue, opened by the owner
# or a collaborator, that carries `factory:ready` and has no open PR and no branch yet. Writes
# run=true only when all of that holds; every refusal is one `GATE refused:` line in the log, a
# warning annotation and a line in the step summary, and exits 0 (a refusal isn't a failure).
#
# Signals (admin, 21 Nov 2026, option b): `factory:ready` stands for Mode Factory, which
# triage-labels.md keeps in step with it, and the admin's dispatch stands for Ready. Only the admin
# and collaborators can set labels. The Project isn't read: no Actions token can read this
# user-owned board (#102), and the sweep (#108) waits for #102's native issue fields.
#
# Env: ISSUE and MAX_TURNS (the dispatch inputs, through env:, never ${{ }} in run:), ISSUE_JSON
# (GET /repos/{o}/{r}/issues/{n}, or {} when that read failed), PULLS_JSON (the open PRs, as one
# array), REFS_JSON (GET …/git/matching-refs/heads/<n>-), GITHUB_OUTPUT, and GITHUB_STEP_SUMMARY
# (optional). Writes issue=<n> and turns=<n>, the checked values later steps use instead of the
# inputs. A PULLS_JSON or REFS_JSON that isn't the JSON it expects fails the step rather than guess.
# Tests: .github/scripts/tests/factory-gate.test.mjs
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"
CAP=100 # --max-turns, decided by the admin (21 Nov 2026); the input may only lower it

# A message may quote an input: escaped as workflow commands require, so a newline can't start a
# command of its own (::add-mask::, ::stop-commands:: …).
esc() { local s=${1//'%'/%25}; s=${s//$'\r'/%0D}; printf '%s' "${s//$'\n'/%0A}"; }
refuse() { # message
  local m
  m=$(esc "$1")
  echo "GATE refused: $m"
  echo "::warning title=factory refused::$m"
  [[ -z ${GITHUB_STEP_SUMMARY:-} ]] || printf 'Refused: %s\n' "$m" >>"$GITHUB_STEP_SUMMARY"
  echo "run=false" >>"$GITHUB_OUTPUT"
  exit 0
}

# The inputs. Nothing is written until both are checked, so a forged value never reaches
# GITHUB_OUTPUT.
issue=${ISSUE-}
[[ $issue =~ ^[1-9][0-9]{0,6}$ ]] || refuse "the issue input $(printf %q "$issue") isn't an issue number"
turns=${MAX_TURNS:-$CAP}
if [[ ! $turns =~ ^[1-9][0-9]{0,2}$ ]] || ((turns > CAP)); then
  refuse "max_turns $(printf %q "$turns") must be a whole number from 1 to $CAP"
fi
echo "issue=$issue" >>"$GITHUB_OUTPUT"
echo "turns=$turns" >>"$GITHUB_OUTPUT"

# The issue. A read that failed (no such issue) leaves {}.
number=$(jq -r '.number // empty' "$ISSUE_JSON" 2>/dev/null) || number=""
[[ -n $number ]] || refuse "#$issue doesn't exist or can't be read"
[[ $number == "$issue" ]] || refuse "the issue read back is #$number, not #$issue"
[[ $(jq -r '.pull_request != null' "$ISSUE_JSON") == false ]] || refuse "#$issue is a pull request, not an issue"
state=$(jq -r '.state' "$ISSUE_JSON")
[[ $state == open ]] || refuse "#$issue is $state"
# The repo is public: anyone can open an issue, and its author can edit the body after it's
# labelled. So its text reaches Claude only when its author is the owner or a collaborator.
author=$(jq -r '.author_association // "NONE"' "$ISSUE_JSON")
[[ $author =~ ^(OWNER|MEMBER|COLLABORATOR)$ ]] ||
  refuse "#$issue was opened by a $author, not the owner or a collaborator"
[[ $(jq -r '[.labels[]?.name] | index("factory:ready") != null' "$ISSUE_JSON") == true ]] ||
  refuse "#$issue doesn't carry factory:ready"

# The duplicate guard: one factory branch per issue, <n>-<slug>.
pr=$(jq -er --arg p "$issue-" '[.[] | select(.head.ref | startswith($p)) | .number] | first // ""' "$PULLS_JSON")
[[ -z $pr ]] || refuse "#$issue already has PR #$pr from a $issue- branch"
ref=$(jq -er --arg p "refs/heads/$issue-" '[.[] | .ref | select(startswith($p))] | first // ""' "$REFS_JSON")
[[ -z $ref ]] || refuse "#$issue already has the branch ${ref#refs/heads/}"

echo "GATE run: #$issue is open, opened by a $author, carries factory:ready and has no PR or branch (max-turns $turns)"
echo "run=true" >>"$GITHUB_OUTPUT"

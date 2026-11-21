#!/usr/bin/env bash
# Reads what the factory's gate decides on, then runs it (#107): the issue, the open PRs and the
# issue's <n>- branches, over REST with the read-only GITHUB_TOKEN in GH_TOKEN. factory.yml runs it
# in the gate job, and again in the factory job just before Claude reads the issue. A missing issue
# reads as {}, so the gate logs `GATE refused` instead of failing the step; a failed read of the
# PRs or branches fails it.
#
# Env: ISSUE and MAX_TURNS (the inputs; factory-gate.sh checks them before they reach a URL here),
# GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP, GITHUB_OUTPUT.
# Tests: .github/scripts/tests/factory-gate.test.mjs ("factory-gather.sh")
set -euo pipefail

dir=$RUNNER_TEMP/factory-gate
mkdir -p "$dir"
r="repos/$GITHUB_REPOSITORY"
issue=${ISSUE-}
echo '{}' >"$dir/issue.json"
echo '[]' >"$dir/pulls.json"
echo '[]' >"$dir/refs.json"
# Only a number reaches a URL; anything else the gate refuses with the files as they are.
if [[ $issue =~ ^[1-9][0-9]{0,6}$ ]]; then
  gh api "$r/issues/$issue" >"$dir/issue.json" 2>/dev/null || echo '{}' >"$dir/issue.json"
  gh api --paginate "$r/pulls?state=open&per_page=100" --jq '.[] | {number, head: {ref: .head.ref}}' |
    jq -s . >"$dir/pulls.json"
  gh api "$r/git/matching-refs/heads/$issue-" --jq '[.[] | {ref}]' >"$dir/refs.json"
fi
ISSUE_JSON=$dir/issue.json PULLS_JSON=$dir/pulls.json REFS_JSON=$dir/refs.json \
  bash "$(dirname "$0")/factory-gate.sh"

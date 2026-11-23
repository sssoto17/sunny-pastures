#!/usr/bin/env bash
# Reads what the factory's gate decides on, then runs it (#107): the issue, its open native
# blockers (#619), the open PRs and the issue's <n>- branches, over REST with the read-only
# GITHUB_TOKEN in GH_TOKEN. factory.yml runs it in the gate job, and again in the factory job just
# before Claude reads the issue. A missing issue reads as {} (and its blockers aren't read), so the
# gate logs `GATE refused` instead of failing the step; a failed read of the blockers, PRs or
# branches fails it.
# Fix mode (#588): with a `pr` input it reads that PR and its reviews instead, and runs
# factory-fix-gate.mjs, which writes the Required findings to findings.md beside them.
#
# Env: ISSUE, PR, HEAD and MAX_TURNS (the inputs; the gates check them, and only a number reaches a
# URL here), GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP, GITHUB_OUTPUT; FACTORY_BOT_ID in fix mode
# (factory.yml's workflow env).
# Tests: .github/scripts/tests/factory-gate.test.mjs ("factory-gather.sh")
set -euo pipefail

dir=$RUNNER_TEMP/factory-gate
mkdir -p "$dir"
r="repos/$GITHUB_REPOSITORY"
issue=${ISSUE-}
if [[ -n ${PR-} ]]; then
  echo '{}' >"$dir/pr.json"
  echo '[]' >"$dir/reviews.json"
  echo '[]' >"$dir/commits.json"
  if [[ $PR =~ ^[1-9][0-9]{0,6}$ ]]; then
    gh api "$r/pulls/$PR" >"$dir/pr.json" 2>/dev/null || echo '{}' >"$dir/pr.json"
    gh api --paginate "$r/pulls/$PR/reviews?per_page=100" | jq -s 'add // []' >"$dir/reviews.json"
    gh api --paginate "$r/pulls/$PR/commits?per_page=100" | jq -s 'add // []' >"$dir/commits.json"
  fi
  PR_JSON=$dir/pr.json REVIEWS_JSON=$dir/reviews.json COMMITS_JSON=$dir/commits.json \
    BOT_EMAIL="${FACTORY_BOT_ID:?FACTORY_BOT_ID is not set}+sunny-factory[bot]@users.noreply.github.com" \
    FINDINGS=$dir/findings.md \
    exec node "$(dirname "$0")/factory-fix-gate.mjs"
fi
echo '{}' >"$dir/issue.json"
echo '[]' >"$dir/blockers.json"
echo '[]' >"$dir/pulls.json"
echo '[]' >"$dir/refs.json"
# Only a number reaches a URL; anything else the gate refuses with the files as they are.
if [[ $issue =~ ^[1-9][0-9]{0,6}$ ]]; then
  gh api "$r/issues/$issue" >"$dir/issue.json" 2>/dev/null || echo '{}' >"$dir/issue.json"
  if [[ $(jq -r '.number // empty' "$dir/issue.json") == "$issue" ]]; then
    gh api --paginate "$r/issues/$issue/dependencies/blocked_by?per_page=100" --jq '.[]
      | select(.state == "open") | .number' | jq -s . >"$dir/blockers.json"
  fi
  gh api --paginate "$r/pulls?state=open&per_page=100" --jq '.[] | {number, head: {ref: .head.ref}}' |
    jq -s . >"$dir/pulls.json"
  gh api "$r/git/matching-refs/heads/$issue-" --jq '[.[] | {ref}]' >"$dir/refs.json"
fi
ISSUE_JSON=$dir/issue.json BLOCKERS_JSON=$dir/blockers.json PULLS_JSON=$dir/pulls.json \
  REFS_JSON=$dir/refs.json bash "$(dirname "$0")/factory-gate.sh"

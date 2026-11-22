#!/usr/bin/env bash
# The reviewer-stopped alert (#514): when review.yml ends in startup_failure, the admin hears of it.
# On 15-16 Nov it ended so 29 times over ~3 h after a Dependabot bump of claude-code-action (#261)
# went past the allowed-actions list, and nobody noticed. reviewer-stopped.yml runs this hourly.
#
# Lists review.yml's runs that ended in startup_failure since SINCE (REST: GET
# .../actions/workflows/review.yml/runs?status=startup_failure&created=>=SINCE). A run already
# linked from a "Reviewer stopped" issue, open or closed since SINCE, is left out, so each
# run is reported once and a closed issue isn't filed again for the runs it already holds. Then:
# - no new run: nothing is written;
# - an open "Reviewer stopped" issue: one comment on it, linking the new runs;
# - none open: one new issue, labelled blocked:admin, linking them.
# Every outcome is one `ALERT` line in the log.
#
# Env: GITHUB_REPOSITORY (owner/repo), GH_TOKEN (for gh: actions read, issues write), SINCE (an
# ISO 8601 UTC time, the start of the window), DRY_RUN (optional: `true` reads and logs the
# outcome but writes nothing), RUNNER_TEMP (optional, for the body file).
# Tests: .github/scripts/tests/reviewer-stopped.test.mjs
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
: "${SINCE:?SINCE is not set}"
# SINCE goes into a query string: only the shape `date -u +%FT%TZ` prints.
[[ $SINCE =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
  echo "reviewer-stopped: SINCE must look like 2026-11-22T10:00:00Z" >&2
  exit 2
}
dry=${DRY_RUN:-false}
[[ $dry == true || $dry == false ]] || {
  echo "reviewer-stopped: DRY_RUN must be true or false" >&2
  exit 2
}
repo=$GITHUB_REPOSITORY
TITLE="Reviewer stopped: startup_failure on review.yml"
LABEL="blocked:admin"
# The labels every issue in this repo carries (docs/agents/triage-labels.md): one type, one area,
# and `triage` because a workflow can't set the Project's fields.
LABELS=("$LABEL" chore area:ci-cd triage)

# The failed runs, oldest first: `<id>\t<created_at>\t<html_url>`.
runs=$(gh api -X GET --paginate "repos/$repo/actions/workflows/review.yml/runs" \
  -f status=startup_failure -f "created=>=$SINCE" -f per_page=100 \
  --jq '.workflow_runs[] | [.id, .created_at, .html_url] | @tsv' | sort -t$'\t' -k2,2)

if [[ -z $runs ]]; then
  echo "ALERT none: no startup_failure on review.yml since $SINCE"
  exit 0
fi

# The "Reviewer stopped" issues: every open one, and those closed and updated in the window (their
# runs count as reported). `<number>\t<state>`, open first, oldest first.
list_issues() { # extra query fields
  gh api -X GET --paginate "repos/$repo/issues" -f "labels=$LABEL" -f per_page=100 "$@" \
    --jq ".[] | select(has(\"pull_request\") | not) | select(.title == \"$TITLE\") | [.number, .state] | @tsv"
}
issues=$({
  list_issues -f state=open
  list_issues -f state=closed -f "since=$SINCE"
} | sort -t$'\t' -k2,2r -k1,1n)

# The run ids those issues already link, from their bodies and comments.
seen=""
while IFS=$'\t' read -r n _; do
  [[ -n $n ]] || continue
  [[ $n =~ ^[0-9]+$ ]] || {
    echo "reviewer-stopped: odd issue number from the API" >&2
    exit 1
  }
  seen+=$(
    {
      gh api "repos/$repo/issues/$n" --jq '.body // ""'
      gh api --paginate "repos/$repo/issues/$n/comments" --jq '.[].body'
    } | grep -oE 'actions/runs/[0-9]+' || true
  )$'\n'
done <<<"$issues"

new=()
while IFS=$'\t' read -r id created url; do
  [[ $id =~ ^[0-9]+$ ]] || continue
  grep -qxF "actions/runs/$id" <<<"$seen" && continue
  new+=("- [$id]($url), $created")
done <<<"$runs"

if ((${#new[@]} == 0)); then
  echo "ALERT none: every startup_failure since $SINCE is already reported"
  exit 0
fi

open=$(awk -F'\t' '$2 == "open" { print $1; exit }' <<<"$issues")
body="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/reviewer-stopped-body.md"
links=$(printf '%s\n' "${new[@]}")

if [[ -n $open ]]; then
  printf '%s more `review.yml` run(s) ended in `startup_failure`:\n\n%s\n' \
    "${#new[@]}" "$links" >"$body"
  if [[ $dry == true ]]; then
    echo "ALERT dry run: would comment on #$open with ${#new[@]} run(s)"
  else
    gh api --silent "repos/$repo/issues/$open/comments" -F "body=@$body"
    echo "ALERT commented: #$open, ${#new[@]} run(s)"
  fi
  cat "$body"
  exit 0
fi

cat >"$body" <<EOF
\`review.yml\`, the CI reviewer (\`sunny-reviewer\`), ended in \`startup_failure\`: GitHub refused
the run before any job started, so PRs get no review. Opened by \`reviewer-stopped.yml\` (#514);
it comments here on each new failure while this stays open.

Runs:

$links

Likely causes: an action or a pin \`review.yml\` uses isn't on the allowed-actions list (15-16 Nov:
a Dependabot bump of \`claude-code-action\`, #261), or an invalid \`review.yml\`. Open a failed run
for GitHub's reason, fix it, and close this issue once \`review.yml\` runs again.
EOF
if [[ $dry == true ]]; then
  echo "ALERT dry run: would open \"$TITLE\" with ${#new[@]} run(s)"
else
  label_args=()
  for l in "${LABELS[@]}"; do label_args+=(-f "labels[]=$l"); done
  n=$(gh api "repos/$repo/issues" -f "title=$TITLE" -F "body=@$body" "${label_args[@]}" --jq .number)
  echo "ALERT opened: #$n, ${#new[@]} run(s)"
fi
cat "$body"

#!/usr/bin/env bash
# Reads what the sweep (#108) decides on, into SWEEP_DIR, for .github/scripts/factory-sweep.mjs:
# - runs.json: the factory workflow's newest 100 runs (the serial rule, the fix rounds' loop guard
#   and the reconcile's live runs), with the read-only GITHUB_TOKEN (actions: read);
# - issues.json: every issue, open or closed, carrying a factory:* label (ready, working, review,
#   failed; #619), one read per label, with its state, author's standing and labels (issues: read).
#   Each open one carrying factory:ready gets `blocked_by`, the numbers of its open native blockers
#   (`GET …/issues/{n}/dependencies/blocked_by`), one read each;
# - pulls.json and refs.json: the open PRs (head branch and SHA, author, drafts included) and every
#   branch, for the open-PR cap, the gate's duplicate guard and the reconcile (pull-requests: read,
#   contents: read);
# - closed.json: the newest 100 closed PRs opened by sunny-factory[bot], with merged_at, so the
#   reconcile can tell a factory:review issue whose PR closed unmerged (pull-requests: read);
# - for the fix rounds (#588; pull-requests: read): each open PR by sunny-factory[bot] gets
#   `factory`, true only when every one of its commits is authored and committed by the App's bot
#   user, as factory-publish.sh makes the factory's own (lanes open their PRs as sunny-factory[bot]
#   too, #336, but commit as themselves); and reviews.json holds sunny-reviewer[bot]'s reviews of
#   those factory PRs, each with its PR's number. The rounds already run are factory runs in
#   runs.json ("factory fix #<pr> at <sha>"), so nothing else is read for them;
# - items.json: the board's issue items with Priority, in the order the REST Projects API lists
#   them, through scripts/lib/project-rest.sh with BOARD_PROJECT_TOKEN in PROJECT_GH_TOKEN, used on
#   the Project's calls only. Status, Mode and Track aren't read (#619).
# The kill switch comes first: with FACTORY_ENABLED anything but `true` it reads nothing. A failed
# read fails the step: the sweep never decides on part of the data. REST only; no token is printed.
#
# Env: FACTORY_ENABLED, GH_TOKEN, PROJECT_GH_TOKEN, GITHUB_REPOSITORY, SWEEP_DIR.
# Tests: .github/scripts/tests/factory-sweep.test.mjs ("factory-sweep-gather.sh")
set -euo pipefail

if [[ ${FACTORY_ENABLED-} != true ]]; then
  echo "SWEEP gather: switch off, nothing read"
  exit 0
fi
[[ -n ${PROJECT_GH_TOKEN-} ]] || { echo "::error::BOARD_PROJECT_TOKEN isn't set in environment board"; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
# PROJECT_API, PROJECT_JQ_DEFS, project_gh.
# shellcheck source=scripts/lib/project-rest.sh
. "$here/../../scripts/lib/project-rest.sh"

dir=${SWEEP_DIR:?SWEEP_DIR is not set}
mkdir -p "$dir"
r="repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

gh api "$r/actions/workflows/factory.yml/runs?per_page=100" --jq '[.workflow_runs[]
  | {id, display_title, status, conclusion, run_started_at, created_at, updated_at}]' >"$dir/runs.json"
: >"$dir/issues.ndjson"
for state in ready working review failed; do
  gh api --paginate "$r/issues?state=all&labels=factory:$state&per_page=100" --jq '.[]
    | {number, state, author_association, labels: [.labels[] | {name}], pull_request}' >>"$dir/issues.ndjson"
done
# One entry per issue (an issue with two factory:* labels is listed under both), then the open
# blockers of each open factory:ready issue.
jq -s 'unique_by(.number)' "$dir/issues.ndjson" >"$dir/issues.json"
rm "$dir/issues.ndjson"
blocked='{}'
for n in $(jq -r '.[] | select(.state == "open" and .pull_request == null
  and any(.labels[]; .name == "factory:ready")) | .number' "$dir/issues.json"); do
  [[ $n =~ ^[1-9][0-9]*$ ]] || { echo "::error::unexpected issue number: $n"; exit 1; }
  b=$(gh api --paginate "$r/issues/$n/dependencies/blocked_by?per_page=100" --jq '.[]
    | select(.state == "open") | .number' | jq -sc .)
  blocked=$(jq -c --arg n "$n" --argjson b "$b" '. + {($n): $b}' <<<"$blocked")
done
jq --argjson b "$blocked" 'map(if $b[.number | tostring] then .blocked_by = $b[.number | tostring] else . end)' \
  "$dir/issues.json" >"$dir/issues.tmp"
mv "$dir/issues.tmp" "$dir/issues.json"
gh api --paginate "$r/pulls?state=open&per_page=100" --jq '.[]
  | {number, head: {ref: .head.ref, sha: .head.sha}, user: {login: .user.login}}' | jq -s . >"$dir/pulls.json"
# Which of the App's open PRs the factory made (every commit its bot user's: factory.yml's
# FACTORY_BOT_ID), and the reviewer's reviews of those, one read each.
bot_email='355564973+sunny-factory[bot]@users.noreply.github.com'
factory='[]'
: >"$dir/reviews.ndjson"
for n in $(jq -r '.[] | select(.user.login == "sunny-factory[bot]") | .number' "$dir/pulls.json"); do
  [[ $n =~ ^[1-9][0-9]*$ ]] || { echo "::error::unexpected PR number: $n"; exit 1; }
  pages=$(gh api --paginate "$r/pulls/$n/commits?per_page=100" --jq "[.[] | .commit.author.email,
    .commit.committer.email] | length > 0 and all(. == \"$bot_email\")")
  if [[ -z $pages ]] || grep -qvx true <<<"$pages"; then continue; fi
  factory=$(jq -c --argjson n "$n" '. + [$n]' <<<"$factory")
  gh api --paginate "$r/pulls/$n/reviews?per_page=100" --jq ".[] | select(.user.login == \"sunny-reviewer[bot]\")
    | {pr: $n, user: {login: .user.login}, state, commit_id, submitted_at, body}" >>"$dir/reviews.ndjson"
done
jq -s . "$dir/reviews.ndjson" >"$dir/reviews.json"
rm "$dir/reviews.ndjson"
jq --argjson f "$factory" 'map(.factory = (.number | IN($f[])))' "$dir/pulls.json" >"$dir/pulls.tmp"
mv "$dir/pulls.tmp" "$dir/pulls.json"
gh api --paginate "$r/git/matching-refs/heads/" --jq '.[] | {ref}' | jq -s . >"$dir/refs.json"
gh api "$r/pulls?state=closed&sort=updated&direction=desc&per_page=100" --jq '[.[]
  | select(.user.login == "sunny-factory[bot]") | {number, head: {ref: .head.ref}, merged_at}]' >"$dir/closed.json"

ids=$(project_gh api "$PROJECT_API/fields?per_page=100" --jq '[.[]
  | select(.name == "Priority") | .id | tostring] | join(",")')
[[ $ids =~ ^[0-9]+$ ]] || { echo "::error::the board's Priority field wasn't found: $ids"; exit 1; }
project_gh api --paginate "$PROJECT_API/items?per_page=100&fields=$ids" --jq "$PROJECT_JQ_DEFS"'
  .[] | select(.content_type == "Issue")
  | {number: .content.number,
     repository_url: (.content.repository_url // (.content.url // "" | sub("/issues/[0-9]+$"; ""))),
     priority: fv("Priority")}' | jq -s . >"$dir/items.json"

echo "SWEEP gather: runs=$(jq length "$dir/runs.json") issues=$(jq length "$dir/issues.json")" \
  "pulls=$(jq length "$dir/pulls.json") closed=$(jq length "$dir/closed.json")" \
  "branches=$(jq length "$dir/refs.json") reviews=$(jq length "$dir/reviews.json")" \
  "items=$(jq length "$dir/items.json")"

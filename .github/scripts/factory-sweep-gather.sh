#!/usr/bin/env bash
# Reads what the sweep (#108) decides on, into SWEEP_DIR, for .github/scripts/factory-sweep.mjs:
# - runs.json: the factory workflow's newest 100 runs (the active check and each issue's last run),
#   with the read-only GITHUB_TOKEN (actions: read). Each gets `claude_ran`: true only for a
#   completed run of an open factory:ready issue whose `factory` job has a successful "Claude ran"
#   step (factory.yml), read from that run's jobs; false for every other run (#582);
# - issues.json: the open issues carrying factory:ready, with updated_at (issues: read);
# - pulls.json and refs.json: the open PRs (head branch and SHA, author, drafts included) and every
#   branch, for the open-PR cap and the gate's duplicate guard (pull-requests: read, contents: read);
# - for the fix rounds (#588; pull-requests: read): each open PR by sunny-factory[bot] gets
#   `factory`, true only when every one of its commits is authored and committed by the App's bot
#   user, as factory-publish.sh makes the factory's own (lanes open their PRs as sunny-factory[bot]
#   too, #336, but commit as themselves); and reviews.json holds sunny-reviewer[bot]'s reviews of
#   those factory PRs, each with its PR's number. The rounds already run are factory runs in
#   runs.json ("factory fix #<pr> at <sha>"), so nothing else is read for them;
# - comments.json: the comments updated since the oldest of those runs, with their authors' standing
#   (issues: read), so a stranger's comment doesn't retry an issue whose run opened no PR;
# - items.json: the board's issue items with Status, Mode and Priority, in the order the REST
#   Projects API lists them, through scripts/lib/project-rest.sh with BOARD_PROJECT_TOKEN in
#   PROJECT_GH_TOKEN, used on the Project's calls only.
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
gh api --paginate "$r/issues?state=open&labels=factory:ready&per_page=100" --jq '.[]
  | {number, author_association, updated_at, labels: [.labels[] | {name}], pull_request}' | jq -s . >"$dir/issues.json"
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
# Did Claude run? Only the completed runs of the open factory:ready issues are read, one jobs call
# each: a run that failed before Claude ran (#582) mustn't make the sweep skip its issue.
run_ids=$(jq -r --slurpfile issues "$dir/issues.json" '[$issues[0][] | "factory #\(.number)"] as $t
  | .[] | select(.status == "completed" and (.display_title | IN($t[]))) | .id' "$dir/runs.json")
ran='[]'
for id in $run_ids; do
  [[ $id =~ ^[1-9][0-9]*$ ]] || { echo "::error::unexpected run id: $id"; exit 1; }
  v=$(gh api "$r/actions/runs/$id/jobs?per_page=100" --jq '[.jobs[] | select(.name == "factory")
    | .steps[]? | select(.name == "Claude ran" and .conclusion == "success")] | length > 0')
  if [[ $v == true ]]; then ran=$(jq -c --argjson id "$id" '. + [$id]' <<<"$ran"); fi
done
jq --argjson ran "$ran" 'map(.claude_ran = (.id | IN($ran[])))' "$dir/runs.json" >"$dir/runs.tmp"
mv "$dir/runs.tmp" "$dir/runs.json"
# The comments updated since the oldest of those runs, repo-wide in one read: whose comment last
# moved an issue's updated_at.
since=$(jq -r '[.[].created_at] | min // empty' "$dir/runs.json")
if [[ -z $since ]]; then
  echo '[]' >"$dir/comments.json"
else
  [[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "::error::unexpected run time: $since"; exit 1; }
  gh api --paginate "$r/issues/comments?since=$since&per_page=100" --jq '.[]
    | {issue: (.issue_url | sub(".*/"; "") | tonumber), author_association, updated_at}' |
    jq -s . >"$dir/comments.json"
fi

ids=$(project_gh api "$PROJECT_API/fields?per_page=100" --jq '[.[]
  | select(.name == "Status" or .name == "Mode" or .name == "Priority") | .id | tostring] | join(",")')
[[ $ids =~ ^[0-9]+,[0-9]+,[0-9]+$ ]] || {
  echo "::error::the board's Status, Mode and Priority fields weren't all found: $ids"
  exit 1
}
project_gh api --paginate "$PROJECT_API/items?per_page=100&fields=$ids" --jq "$PROJECT_JQ_DEFS"'
  .[] | select(.content_type == "Issue")
  | {number: .content.number,
     repository_url: (.content.repository_url // (.content.url // "" | sub("/issues/[0-9]+$"; ""))),
     status: fv("Status"), mode: fv("Mode"), priority: fv("Priority")}' | jq -s . >"$dir/items.json"

echo "SWEEP gather: runs=$(jq length "$dir/runs.json") issues=$(jq length "$dir/issues.json")" \
  "pulls=$(jq length "$dir/pulls.json") branches=$(jq length "$dir/refs.json")" \
  "comments=$(jq length "$dir/comments.json") reviews=$(jq length "$dir/reviews.json")" \
  "items=$(jq length "$dir/items.json")"

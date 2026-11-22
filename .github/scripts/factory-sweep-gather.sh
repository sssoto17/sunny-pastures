#!/usr/bin/env bash
# Reads what the sweep (#108) decides on, into SWEEP_DIR, for .github/scripts/factory-sweep.mjs:
# - runs.json: the factory workflow's newest 100 runs (the active check and each issue's last run),
#   with the read-only GITHUB_TOKEN (actions: read);
# - issues.json: the open issues carrying factory:ready, with updated_at (issues: read);
# - pulls.json and refs.json: the open PRs (head branch and author, drafts included) and every
#   branch, for the open-PR cap and the gate's duplicate guard (pull-requests: read, contents: read);
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
  | {id, display_title, status, conclusion, run_started_at, created_at}]' >"$dir/runs.json"
gh api --paginate "$r/issues?state=open&labels=factory:ready&per_page=100" --jq '.[]
  | {number, author_association, updated_at, labels: [.labels[] | {name}], pull_request}' | jq -s . >"$dir/issues.json"
gh api --paginate "$r/pulls?state=open&per_page=100" --jq '.[] | {number, head: {ref: .head.ref}, user: {login: .user.login}}' |
  jq -s . >"$dir/pulls.json"
gh api --paginate "$r/git/matching-refs/heads/" --jq '.[] | {ref}' | jq -s . >"$dir/refs.json"

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
  "pulls=$(jq length "$dir/pulls.json") branches=$(jq length "$dir/refs.json") items=$(jq length "$dir/items.json")"

#!/usr/bin/env bash
# Tests for scripts/lib/project-rest.sh: the jq definitions read field values the way GitHub's REST
# Projects API returns them, a 403 is told apart from other failures, and a finishing command is
# quoted so it can be pasted. The item below is cut from the example of "Get an item for a user
# owned project" in GitHub's REST description (github/rest-api-description,
# components/examples/projects-v2-item-with-content), so the expected values come from GitHub,
# not from this code.
# Run: bash scripts/lib/project-rest.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/project-rest.sh
. "$here/project-rest.sh"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/project-rest-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

check() { # message expected actual
  if [[ $2 == "$3" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"
  fi
}

ITEM='{"id": 13, "content_type": "PullRequest", "fields": [
  {"id": 1, "name": "Title", "data_type": "title",
   "value": {"raw": "It seemed to me", "html": "It seemed to me", "number": 6}},
  {"id": 3, "name": "Status", "data_type": "single_select",
   "value": {"id": "98236657", "name": {"raw": "Done", "html": "Done"}, "color": "PURPLE",
             "description": {"raw": "This has been completed", "html": "This has been completed"}}},
  {"id": 8, "name": "Type", "data_type": "issue_type", "value": null},
  {"id": 12, "name": "Estimate", "data_type": "number", "value": 3},
  {"id": 13, "name": "Week", "data_type": "iteration",
   "value": {"id": "iter_1", "title": {"raw": "Sprint 1", "html": "Sprint 1"},
             "start_date": "2022-07-01", "duration": 14}}]}'

fv() { jq -r "$PROJECT_JQ_DEFS"' fv($ARGS.positional[0]) // "-"' --args "$1" <<<"$ITEM"; }
check "a single-select value reads as its option's name" Done "$(fv Status)"
check "a null value reads as null" - "$(fv Type)"
check "a number value reads as itself" 3 "$(fv Estimate)"
check "an iteration value reads as its title" "Sprint 1" "$(fv Week)"
check "a field the item lacks reads as null" - "$(fv Priority)"

check "the endpoints are the user-owned Project's" users/sssoto17/projectsV2/3 "$PROJECT_API"
check "the skipped-step exit code is its own" 4 "$PROJECT_SKIPPED"

# The cloud proxy's answer, as gh printed it on 18 Nov 2026 from a cloud session.
echo 'gh: This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...). (HTTP 403)' >"$work/err"
project_refused "$work/err"
check "the proxy's 403 is a refusal" 0 "$?"
echo 'gh: Not Found (HTTP 404)' >"$work/err"
project_refused "$work/err"
check "a 404 is not a refusal" 1 "$?"
project_refused "$work/none"
check "no error file is not a refusal" 1 "$?"

check "a finishing command quotes its arguments" 'scripts/issue-fields.sh 47 --week Wk\ 2' \
  "$(project_rerun scripts/issue-fields.sh 47 --week "Wk 2")"
check "a finishing command with no arguments" scripts/missing-fields.sh \
  "$(project_rerun scripts/missing-fields.sh)"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

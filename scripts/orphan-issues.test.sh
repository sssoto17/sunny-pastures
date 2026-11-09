#!/usr/bin/env bash
# Tests for orphan-issues.sh through its command line, with `gh` replaced by a fake on PATH.
# The fake logs every call and never reaches GitHub. Most cases serve $work/rows: the tab-separated
# rows the script's --jq filter produces, one per open issue or PR. The filter cases instead serve
# $work/page.json, a page of the REST answer, through the script's own --jq filter run by jq (gh
# runs it with gojq; this filter uses nothing they differ on).
# Run: bash scripts/orphan-issues.test.sh (needs jq)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/orphan-issues.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/orphan-issues-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# --- fake gh ----------------------------------------------------------------------------------
# Each call appends its arguments to $work/calls, one per line, then a "--" line. `gh api` prints
# $work/rows, unless $work/fail-api exists: then it prints that file to stderr and exits 1, as gh
# does on an HTTP error. If $work/page.json exists, it runs the call's --jq filter over that file
# instead, printing strings raw as gh does.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
if [[ $1 == api ]]; then
  if [[ -f $dir/fail-api ]]; then
    cat "$dir/fail-api" >&2
    exit 1
  fi
  if [[ -f $dir/page.json ]]; then
    while (($#)) && [[ $1 != --jq ]]; do shift; done
    [[ -n ${2-} ]] || { echo "fake: no --jq filter given" >&2; exit 98; }
    jq -r "$2" "$dir/page.json"
    exit
  fi
  cat "$dir/rows"
  exit
fi
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"

# --- fixtures ---------------------------------------------------------------------------------
# One row as the --jq filter emits it: number, kind (issue/pr), parent (parent/none),
# sub-issue total, labels joined by the unit separator \x1f ("-" for none), title. Fixtures
# write the labels joined by "|" for readability; row() swaps in the separator.
T=$'\t'
US=$'\x1f'
row() { # number kind parent subs labels title
  printf '%s%s%s%s%s%s%s%s%s%s%s\n' "$1" "$T" "$2" "$T" "$3" "$T" "$4" "$T" "${5//|/$US}" "$T" "$6"
}

reset() { # rows... -> a fresh state serving those rows
  rm -f "$work"/calls "$work"/rows "$work"/fail-api "$work"/page.json
  printf '%s' "$*" >"$work/rows"
}

run() { # args... -> sets code, out, err, calls
  out=$(PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls:\n%s\n' \
    "$1" "${args[*]-}" "$code" "$out" "$err" "    ${calls//$'\n'/$'\n'    }"
}
assert() { # message command... -> ok if the command succeeds
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out_is() { assert "expected stdout to be exactly: $1" test "$out" == "$1"; }
expect_no_gh() { assert "expected no gh calls at all" test -z "$calls"; }
# The gh calls joined into one line each: "api -X GET repos/... --paginate ...".
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
expect_call() { # substring of one joined call line
  if call_lines | grep -qF -- "$1"; then ok; else bad "expected a gh call containing: $1"; fi
}
case_() { args=("$@"); run "$@"; }

# --- usage ------------------------------------------------------------------------------------
for flag in --help -h; do
  reset ""
  case_ "$flag"
  expect_code 0
  expect_err "usage:"
  expect_no_gh
done

for bad_args in "--colour" "28" "--help extra"; do
  reset ""
  read -ra words <<<"$bad_args"
  case_ "${words[@]}"
  expect_code 2
  expect_err "usage:"
  expect_no_gh
done

# --- one read-only, paginated REST read -------------------------------------------------------
reset ""
case_
expect_call "api -X GET repos/sssoto17/sunny-pastures/issues -f state=open -f per_page=100 --paginate --jq"
assert "expected exactly one gh call" test "$(call_lines | wc -l)" -eq 1

# --- an issue without a parent is listed --------------------------------------------------------
reset "$(row 28 issue none 0 'bug|area:db' 'Check transaction use under load')"
case_
expect_code 1
expect_out_is "#28${T}Check transaction use under load"

# --- an issue with a parent is not listed; none left means exit 0 -------------------------------
reset "$(row 76 issue parent 0 'chore|area:tools' 'Every issue sits under a workstream parent')"
case_
expect_code 0
expect_out_is ""
expect_err "every open issue has a workstream parent"

reset "$(row 76 issue parent 0 'chore|area:tools' 'Parented')
$(row 31 issue none 0 'design|area:sim' 'Orphan')"
case_
expect_code 1
expect_out_is "#31${T}Orphan"
expect_err "1 open issue without a workstream parent"

# --- exclusions -------------------------------------------------------------------------------
# A top-level parent is an issue with no parent and at least one sub-issue, open or closed
# (GitHub's sub_issues_summary.total counts both). One whose sub-issues are all closed is still a
# parent: it waits to be closed, not parented.
reset "$(row 1 issue none 0 'triage|idea|area:ui' 'Idea: admin dashboard')
$(row 55 issue none 0 'area:docs|chore' 'Retro inbox')
$(row 73 issue none 9 'chore|area:tools' 'Agent workflow')
$(row 74 issue none 2 'feature|area:api' 'All sub-issues closed')
$(row 120 pr none 0 - 'chore: a pull request')"
case_
expect_code 0
expect_out_is ""

# Each rule is exact: a label that only contains "idea" (even split at a comma inside its name),
# a title that only contains "Retro inbox" and an issue with no sub-issues are all still listed.
reset "$(row 2 issue none 0 'area:ideas|chore' 'Not an idea')
$(row 3 issue none 0 chore 'Retro inbox follow-up')
$(row 4 issue none 0 chore 'No sub-issues')
$(row 5 issue none 0 'x,idea|chore' 'Comma in a label')"
case_
expect_code 1
expect_out_is "#2${T}Not an idea
#3${T}Retro inbox follow-up
#4${T}No sub-issues
#5${T}Comma in a label"
expect_err "4 open issues without a workstream parent"

# A wayfinder map has sub-issues (its tickets) but is never a top-level parent: Kickoff step 2
# makes it a sub-issue of its workstream's parent. A parentless map is listed, open tickets or
# not; a parented one isn't.
reset "$(row 59 issue none 14 'design|area:ci-cd|wayfinder:map' 'Wayfinder: CI/CD')
$(row 60 issue parent 3 'design|wayfinder:map' 'Wayfinder: parented')"
case_
expect_code 1
expect_out_is "#59${T}Wayfinder: CI/CD"

# The list is in ascending issue order, whatever order the pages arrive in (GitHub sends newest
# first), so #78 and a person reading it get the same order on every run.
reset "$(row 110 issue none 0 chore 'Newest')
$(row 33 issue none 0 design 'Middle')
$(row 9 issue none 0 chore 'Oldest')"
case_
expect_code 1
expect_out_is "#9${T}Oldest
#33${T}Middle
#110${T}Newest"

# --- a failed or unreadable answer is exit 3, never a clean or an orphan result ------------------
reset ""
printf 'HTTP 502: Bad Gateway\n' >"$work/fail-api"
case_
expect_code 3
expect_out_is ""
expect_err "could not read the open issues"
expect_err "HTTP 502"

# A row that isn't the filter's shape (the API or the filter changed) fails the same way.
reset "$(row 28 issue none many bug 'Bad sub-issue count')"
case_
expect_code 3
expect_out_is ""

# No open issues at all is a clean result, not a parse error.
reset ""
case_
expect_code 0
expect_out_is ""

# --- the --jq filter over a REST page ---------------------------------------------------------
# The cases above serve rows the filter already produced; this one runs the script's own filter
# over JSON shaped like GitHub's answer. It covers: a PR (has pull_request); an issue with no
# parent_issue_url key at all (how GitHub sends a parentless issue, seen 9 Nov) and one with an
# explicit null; one with sub_issues_summary missing (the // 0 default); one with no labels;
# the label join (idea among others, a map, a comma inside a name); a parented issue; a
# top-level parent; and the Retro inbox.
# A missing jq is a failure, not a skip (CONSTRAINTS.md, "Guarding the bar").
args=("--jq filter")
if ! command -v jq >/dev/null; then
  code="" out="" err="" calls=""
  bad "jq is not installed: install it to run the --jq filter case"
else
  reset ""
  cat >"$work/page.json" <<'JSON'
[
  {"number": 120, "title": "chore: a pull request", "pull_request": {"url": "x"},
   "labels": [], "sub_issues_summary": {"total": 0, "completed": 0}},
  {"number": 28, "title": "No parent key", "labels": [{"name": "bug"}, {"name": "area:db"}],
   "sub_issues_summary": {"total": 0, "completed": 0}},
  {"number": 31, "title": "Explicit null parent", "parent_issue_url": null, "labels": [],
   "sub_issues_summary": {"total": 0, "completed": 0}},
  {"number": 33, "title": "No sub-issue summary", "labels": [{"name": "design"}]},
  {"number": 76, "title": "Parented", "parent_issue_url": "https://api.github.com/repos/o/r/issues/73",
   "labels": [{"name": "chore"}], "sub_issues_summary": {"total": 0, "completed": 0}},
  {"number": 1, "title": "Idea: a dashboard",
   "labels": [{"name": "triage"}, {"name": "idea"}, {"name": "area:ui"}],
   "sub_issues_summary": {"total": 0, "completed": 0}},
  {"number": 5, "title": "Comma in a label", "labels": [{"name": "x,idea"}, {"name": "chore"}],
   "sub_issues_summary": {"total": 0, "completed": 0}},
  {"number": 73, "title": "Agent workflow", "labels": [{"name": "chore"}],
   "sub_issues_summary": {"total": 9, "completed": 9}},
  {"number": 59, "title": "Wayfinder: CI/CD",
   "labels": [{"name": "design"}, {"name": "wayfinder:map"}],
   "sub_issues_summary": {"total": 14, "completed": 5}},
  {"number": 55, "title": "Retro inbox", "labels": [{"name": "chore"}],
   "sub_issues_summary": {"total": 0, "completed": 0}}
]
JSON
  run
  expect_code 1
  expect_out_is "#5${T}Comma in a label
#28${T}No parent key
#31${T}Explicit null parent
#33${T}No sub-issue summary
#59${T}Wayfinder: CI/CD"
  expect_err "5 open issues without a workstream parent"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

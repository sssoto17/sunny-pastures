#!/usr/bin/env bash
# Tests for missing-fields.sh through its command line, with `gh` replaced by a fake on PATH that
# never reaches GitHub. Most cases serve $work/rows, the rows the script's --jq filter produces;
# the filter case runs that filter with jq over a GraphQL page (gh uses gojq; nothing here differs).
# Run: bash scripts/missing-fields.test.sh (needs jq)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/missing-fields.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/missing-fields-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# --- fake gh ----------------------------------------------------------------------------------
# Each call appends its arguments to $work/calls, then a "--" line. `gh api` prints $work/rows,
# or runs the call's --jq filter over $work/page.json if it exists; $work/fail-api makes it print
# that file to stderr and exit 1, as gh does on an error.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
if [[ $1 == api ]]; then
  [[ -f $dir/fail-api ]] && { cat "$dir/fail-api" >&2; exit 1; }
  if [[ -f $dir/page.json ]]; then
    while (($#)) && [[ $1 != --jq ]]; do shift; done
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
# A filter row: number, type, labels joined by \x1f (written "|"), Priority, Size, Week, title. ok_row is an issue with all four set and no triage.
T=$'\t'
US=$'\x1f'
row() { # number type labels priority size week title
  local IFS=$T
  local r="$*"
  printf '%s\n' "${r//|/$US}"
}
ok_row() { row "$1" Chore 'chore|area:tools' P2 S "Wk 2 · 9–15 Nov" "$2"; }
reset() { # rows -> a fresh state serving them
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
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n' \
    "$1" "${args[*]-}" "$code" "$out" "$err"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out_is() { assert "expected stdout to be exactly: $1" test "$out" == "$1"; }
case_() { args=("$@"); run "$@"; }

# --- usage ------------------------------------------------------------------------------------
for pair in "--help:0" "-h:0" "--colour:2" "28:2" "--help extra:2"; do
  reset ""
  read -ra words <<<"${pair%:*}"
  case_ "${words[@]}"
  expect_code "${pair##*:}"
  expect_err "usage:"
  assert "expected no gh calls" test -z "$calls"
done

# --- one read-only, paginated GraphQL read; all set means exit 0 --------------------------------
reset "$(ok_row 76 Fine)"
case_
expect_code 0
expect_out_is ""
expect_err "every open issue has its fields"
assert "expected one paginated graphql call" test "$(head -3 <<<"$calls" | tr '\n' ' ')" == "api graphql --paginate "

# --- each missing field is named; triage expected while one is -------------------------------
reset "$(row 10 - 'chore|triage' P2 S "Wk 2" 'No type')
$(row 11 Chore 'chore|triage' - S "Wk 2" 'No priority')
$(row 12 Bug 'bug|triage' P1 - "Wk 2" 'No size')
$(row 13 Feature 'feature|triage' P1 M - 'No week')
$(row 14 - 'chore' - - - 'Nothing, no triage')
$(ok_row 15 Fine)"
case_
expect_code 1
expect_out_is "#10${T}missing: Type${T}No type
#11${T}missing: Priority${T}No priority
#12${T}missing: Size${T}No size
#13${T}missing: Week${T}No week
#14${T}missing: Type, Priority, Size, Week; no triage${T}Nothing, no triage"
expect_err "5 open issues to fix"

# --- triage on an issue with all four set ----------------------------------------------------
# A label that only contains "triage" doesn't count.
reset "$(row 20 Chore 'chore|triage' P2 S "Wk 2" 'Done but triaged')
$(row 21 Chore 'chore|needs-triage' P2 S "Wk 2" 'Other label')"
case_
expect_code 1
expect_out_is "#20${T}triage, though its fields are set${T}Done but triaged"
expect_err "1 open issue to fix"

# --- workstream parents need all four too (Issue fields, "No exceptions") -----------------------
reset "$(row 73 Chore 'chore|area:tools' P1 - - 'Agent workflow')"
case_
expect_code 1
expect_out_is "#73${T}missing: Size, Week; no triage${T}Agent workflow"

# --- failures are exit 3 with no list ----------------------------------------------------------
reset ""
printf 'HTTP 502: Bad Gateway\n' >"$work/fail-api"
case_
expect_code 3
expect_out_is ""
expect_err "could not read the open issues"
expect_err "HTTP 502"

reset "x28${T}Chore${T}chore${T}P2${T}S${T}W${T}Bad number"
case_
expect_code 3
expect_out_is ""
expect_err "unexpected row from GitHub"

# --- the --jq filter over a GraphQL page ------------------------------------------------------
# Covers: fields read from this Project's item only (another project's Priority is ignored); a
# single-select and an iteration value; a field value with no field (skipped); a null type; no
# labels and no Project item at all.
# A missing jq is a failure, not a skip (CONSTRAINTS.md, "Guarding the bar").
args=("--jq filter")
if ! command -v jq >/dev/null; then
  code="" out="" err=""
  bad "jq is not installed: install it to run the --jq filter case"
else
  reset ""
  cat >"$work/page.json" <<'JSON'
{"data": {"repository": {"issues": {"pageInfo": {"hasNextPage": false, "endCursor": "x"}, "nodes": [
  {"number": 40, "title": "All set", "issueType": {"name": "Chore"},
   "labels": {"nodes": [{"name": "chore"}]},
   "projectItems": {"nodes": [{"project": {"url": "https://github.com/users/sssoto17/projects/3"},
     "fieldValues": {"nodes": [{}, {"name": "P2", "field": {"name": "Priority"}},
       {"name": "S", "field": {"name": "Size"}}, {"title": "Wk 2 · 9–15 Nov", "field": {"name": "Week"}}]}}]}},
  {"number": 41, "title": "Other project", "issueType": null,
   "labels": {"nodes": []},
   "projectItems": {"nodes": [{"project": {"url": "https://github.com/users/someone/projects/3"},
     "fieldValues": {"nodes": [{"name": "P0", "field": {"name": "Priority"}}]}},
     {"project": {"url": "https://github.com/users/sssoto17/projects/3"},
     "fieldValues": {"nodes": [{"name": "M", "field": {"name": "Size"}}]}}]}},
  {"number": 42, "title": "Off the Project", "issueType": {"name": "Bug"},
   "labels": {"nodes": [{"name": "bug"}, {"name": "triage"}]},
   "projectItems": {"nodes": []}}
]}}}}
JSON
  run
  expect_code 1
  expect_out_is "#41${T}missing: Type, Priority, Week; no triage${T}Other project
#42${T}missing: Priority, Size, Week${T}Off the Project"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

#!/usr/bin/env bash
# Tests for missing-fields.sh through its command line, with `gh` replaced by the REST fake
# (scripts/lib/gh-rest-fake.sh) on PATH. It never reaches GitHub, refuses anything but `gh api`,
# and runs the script's --jq filters through jq over JSON shaped like GitHub's REST answers: the
# open issues, the Project's fields and its items (as in GitHub's REST description's examples).
# Run: bash scripts/missing-fields.test.sh (needs jq)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/missing-fields.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/missing-fields-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cp "$here/lib/gh-rest-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
st=$work/gh
R=repos/sssoto17/sunny-pastures
PA=users/sssoto17/projectsV2/3

# --- fixtures ---------------------------------------------------------------------------------
# One issue per row: number, type ("-" for none), labels joined by "|", Priority, Size, Week ("-"
# for unset; "off" in Priority: not on the Project), title. ok_row has all four and no triage.
T=$'\t'
row() { local IFS=$T; printf '%s\n' "$*"; }
ok_row() { row "$1" Chore 'chore|area:tools' P2 S "Wk 2 · 9–15 Nov" "$2"; }
reset() { # rows -> a fresh state: the open issues and their items on the Project
  rm -rf "$st"
  mkdir -p "$st/get/$R" "$st/get/$PA"
  jq -n '[{id: 1, name: "Title", data_type: "title"}, {id: 11, name: "Status", data_type: "single_select"},
    {id: 12, name: "Priority", data_type: "single_select"}, {id: 13, name: "Size", data_type: "single_select"},
    {id: 14, name: "Week", data_type: "iteration"}]' >"$st/get/$PA/fields"
  local rows=$1
  jq -Rn --arg T "$T" '[inputs | select(. != "") | split($T)
    | {number: (.[0] | tonumber? // .), title: .[6],
       type: (if .[1] == "-" then null else {name: .[1]} end),
       labels: (.[2] | split("|") | map(select(. != "") | {name: .}))}]' <<<"$rows" >"$st/get/$R/issues"
  jq -Rn --arg T "$T" '
    def sel($v): if $v == "-" then null else {id: "x", name: {raw: $v, html: $v}} end;
    def it($v): if $v == "-" then null else {id: "w", title: {raw: $v, html: $v}} end;
    [inputs | select(. != "") | split($T) | select(.[3] != "off")
    | {id: (1000 + (.[0] | tonumber? // 0)), content_type: "Issue",
       content: {number: (.[0] | tonumber? // .),
                 html_url: "https://github.com/sssoto17/sunny-pastures/issues/\(.[0])"},
       fields: [{id: 1, name: "Title", value: {raw: .[6]}},
                {id: 12, name: "Priority", value: sel(.[3])}, {id: 13, name: "Size", value: sel(.[4])},
                {id: 14, name: "Week", value: it(.[5])}]}]' <<<"$rows" >"$st/get/$PA/items"
}
run() { # args... -> sets code, out, err, calls
  out=$(PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$st/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n' \
    "$1" "${args[*]-}" "$code" "$out" "$err"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out_is() { assert "expected stdout to be exactly: $1" test "$out" == "$1"; }
expect_call() { if call_lines | grep -qF -- "$1"; then ok; else bad "expected a gh call containing: $1"; fi; }
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

# --- REST reads only; all set means exit 0 ----------------------------------------------------
reset "$(ok_row 76 Fine)"
case_
expect_code 0
expect_out_is ""
expect_err "every open issue has its fields"
expect_call "api --paginate $R/issues?state=open&per_page=100 --jq"
expect_call "api $PA/fields?per_page=100 --jq"
# Only Priority, Size and Week are asked for, by id (without fields, only the title comes back).
expect_call "api --paginate $PA/items?per_page=100&fields=12,13,14 --jq"
assert "expected only gh api calls, none graphql" test "$(call_lines | grep -c -v '^api ' ; call_lines | grep -c graphql)" == "0
0"

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

# --- what the issues list holds that isn't an issue on this repo's Project --------------------
# A PR in the issues list is left out; an issue off the Project misses all three; another repo's
# item with the same number doesn't count; no labels at all reads as no triage.
reset "$(row 40 Chore 'chore' P2 S "Wk 2" 'All set')
$(row 42 Bug 'bug|triage' off - - 'Off the Project')
$(row 43 - '' off - - 'No labels')"
jq '. + [{number: 99, title: "A PR", type: null, labels: [], pull_request: {url: "x"}}]' \
  "$st/get/$R/issues" >"$st/x" && mv "$st/x" "$st/get/$R/issues"
jq '. + [{id: 5, content_type: "Issue", content: {number: 43,
  html_url: "https://github.com/someone/else/issues/43"},
  fields: [{id: 12, name: "Priority", value: {id: "x", name: {raw: "P0", html: "P0"}}}]}]' \
  "$st/get/$PA/items" >"$st/x" && mv "$st/x" "$st/get/$PA/items"
case_
expect_code 1
expect_out_is "#42${T}missing: Priority, Size, Week${T}Off the Project
#43${T}missing: Type, Priority, Size, Week; no triage${T}No labels"

# --- the Project refused (the cloud proxy, #346) -----------------------------------------------
# The Type checks still run and list; the Project's checks are named as skipped; exit 4.
reset "$(row 10 - 'chore|triage' P2 S "Wk 2" 'No type')
$(row 14 - 'chore' - - - 'No type, no triage')
$(row 20 Chore 'chore|triage' P2 S "Wk 2" 'Typed, triaged')
$(ok_row 15 Fine)"
touch "$st/refuse_projects"
case_
expect_code 4
expect_out_is "#10${T}missing: Type${T}No type
#14${T}missing: Type; no triage${T}No type, no triage"
expect_err "(HTTP 403)"
expect_err "2 open issues without a type. Skipped: the Priority, Size and Week checks"
expect_err "Run it again from a local session: scripts/missing-fields.sh"

reset "$(ok_row 15 Fine)"
touch "$st/refuse_projects"
case_
expect_code 4
expect_out_is ""
expect_err "0 open issues without a type. Skipped:"

# --- failures are exit 3 with no list ----------------------------------------------------------
reset ""
printf 'gh: Bad Gateway (HTTP 502)\n' >"$st/fail_GET_${R//\//_}_issues"
case_
expect_code 3
expect_out_is ""
expect_err "could not read the open issues"
expect_err "HTTP 502"

# Another failure reading the Project is not a skip.
reset "$(ok_row 15 Fine)"
printf 'gh: Not Found (HTTP 404)\n' >"$st/fail_GET_${PA//\//_}_fields"
case_
expect_code 3
expect_err "could not read the Project's fields"

reset "$(ok_row 15 Fine)"
printf 'gh: Bad Gateway (HTTP 502)\n' >"$st/fail_GET_${PA//\//_}_items"
case_
expect_code 3
expect_out_is ""
expect_err "could not read the Project's items"

# A Project without the three fields is a changed Project, not "all missing".
reset "$(ok_row 15 Fine)"
echo '[{"id": 1, "name": "Title"}]' >"$st/get/$PA/fields"
case_
expect_code 3
expect_err "the Project has no Priority, Size and Week fields"

reset "$(ok_row 15 Fine)"
echo '[{"number": "x28", "title": "Bad number", "labels": []}]' >"$st/get/$R/issues"
case_
expect_code 3
expect_out_is ""
expect_err "unexpected row from GitHub"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

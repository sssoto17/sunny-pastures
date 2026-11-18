#!/usr/bin/env bash
# Tests for backfill-issue-types.sh through its command line, with `gh` replaced by a fake on
# PATH that never reaches GitHub. Cases serve the rows the script's --jq filter produces; the
# filter case runs that filter with jq over a REST page (gh uses gojq; nothing here differs).
# Run: bash scripts/backfill-issue-types.test.sh (needs jq)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/backfill-issue-types.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/backfill-issue-types-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# --- fake gh ----------------------------------------------------------------------------------
# Each call appends its arguments to $work/calls, one per line, then a "--" line. Only `gh api`
# over REST is answered (#346): the issue types serve $work/types (enabled names, as the --jq
# filter prints them); PATCH .../issues/<N> records "N<TAB>type name" in $work/set; the issue
# list serves $work/rows (or its --jq filter over $work/page.json); the read-back of #N serves
# $work/readback.N, else the name of the type set on #N, else "-". $work/fail-types,
# fail-set.<N> and fail-list make those calls exit 1.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
if [[ $1 == api && $2 == -X && $3 == PATCH && $4 =~ /issues/([0-9]+)$ ]]; then
  n=${BASH_REMATCH[1]}
  [[ $5 == -f && $6 == type=* ]] || { echo "fake: unexpected PATCH: $*" >&2; exit 99; }
  [[ -f $dir/fail-set.$n ]] && { echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; }
  printf '%s\t%s\n' "$n" "${6#type=}" >>"$dir/set"
  exit
fi
if [[ $1 == api && $2 == */issue-types ]]; then
  [[ -f $dir/fail-types ]] && { echo "gh: Server Error (HTTP 502)" >&2; exit 1; }
  cat "$dir/types"
  exit
fi
if [[ $1 == api && $2 == -X && $3 == GET ]]; then
  [[ -f $dir/fail-list ]] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
  if [[ -f $dir/page.json ]]; then
    while (($#)) && [[ $1 != --jq ]]; do shift; done
    jq -r "$2" "$dir/page.json"
    exit
  fi
  cat "$dir/rows"
  exit
fi
if [[ $1 == api && $2 =~ /issues/([0-9]+)$ ]]; then
  n=${BASH_REMATCH[1]}
  [[ -f $dir/readback.$n ]] && { cat "$dir/readback.$n"; exit; }
  name=$(awk -F'\t' -v n="$n" '$1 == n { t = $2 } END { print t }' "$dir/set" 2>/dev/null)
  echo "${name:--}"
  exit
fi
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"

# --- fixtures ---------------------------------------------------------------------------------
# A filter row: number, kind, native type or "-", labels joined by \x1f (written "|").
T=$'\t'
US=$'\x1f'
row() { # number kind type labels
  printf '%s%s%s%s%s%s%s\n' "$1" "$T" "$2" "$T" "$3" "$T" "${4//|/$US}"
}
reset() { # rows... -> a fresh state serving those rows
  rm -f "$work"/calls "$work"/rows "$work"/set "$work"/fail-* "$work"/readback.* "$work"/page.json
  printf '%s\n' Chore Bug Feature Design >"$work/types"
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
expect_no_writes() {
  if grep -qx PATCH <<<"$calls"; then bad "expected no writes"; else ok; fi
}
# The gh calls joined into one line each.
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
expect_call() { # substring of one joined call line
  if call_lines | grep -qF -- "$1"; then ok; else bad "expected a gh call containing: $1"; fi
}
case_() { args=("$@"); run "$@"; }

mixed="$(row 41 issue - 'chore|area:ci-cd')
$(row 28 issue - 'bug|area:db')
$(row 154 issue - 'area:sim|feature')
$(row 1 issue - 'triage|idea|area:ui')
$(row 33 issue - 'design|area:docs')
$(row 102 issue - 'spike|area:tools')"

# --- usage ------------------------------------------------------------------------------------
for bad_args in "--help:0" "-h:0" "--force:2" "28:2" "--apply --dry-run:2"; do
  reset ""
  read -ra words <<<"${bad_args%:*}"
  case_ "${words[@]}"
  expect_code "${bad_args##*:}"
  expect_err "usage:"
  expect_no_gh
done

# --- the dry run is the default and writes nothing ----------------------------------------------
# Every type label maps (triage-labels.md, Types; #266), and the list is in ascending issue order.
want="#1${T}idea${T}Chore
#28${T}bug${T}Bug
#33${T}design${T}Design
#41${T}chore${T}Chore
#102${T}spike${T}Chore
#154${T}feature${T}Feature"
for mode in "" --dry-run; do
  reset "$mixed"
  if [[ -n $mode ]]; then case_ "$mode"; else case_; fi
  expect_code 0
  expect_out_is "$want"
  expect_err "dry run: would set 6, skipped 0, already right 0. Run with --apply to write."
  expect_no_writes
done
expect_call "api -X GET repos/sssoto17/sunny-pastures/issues -f state=open -f per_page=100 --paginate --jq"

# --- skipped, already right, re-typed and PRs ---------------------------------------------------
# A type that doesn't follow the label is set again (issue-tracker.md, "Issue fields"): the design
# issues moved from Chore to Design (#266). A typed issue without one type label is left alone.
reset "$(row 10 issue - 'area:docs')
$(row 11 issue - 'bug|chore|area:db')
$(row 12 issue Chore 'chore')
$(row 13 issue Bug 'feature')
$(row 14 pr - 'chore')
$(row 15 issue - '-')
$(row 16 issue - 'chore|area:ideas')
$(row 17 issue Chore 'design|area:docs')
$(row 18 issue Feature 'area:docs')
$(row 19 issue Bug 'bug|chore')"
case_
expect_code 0
expect_out_is "#10${T}skip: no type label
#11${T}skip: 2 type labels (bug, chore)
#13${T}feature${T}Bug -> Feature
#15${T}skip: no type label
#16${T}chore${T}Chore
#17${T}design${T}Chore -> Design"
expect_err "would set 3, skipped 3, already right 1, typed without one type label 2"
expect_err "scripts/issue-fields.sh <n> --type <Chore|Bug|Feature|Design>"
expect_no_writes

reset "$(row 17 issue Chore 'design|area:docs')"
case_ --apply
expect_code 0
expect_out_is "#17${T}design${T}Chore -> Design${T}set"
expect_call "api -X PATCH repos/sssoto17/sunny-pastures/issues/17 -f type=Design --silent"

# --- apply: writes each by id, reads each back --------------------------------------------------
reset "$mixed"
case_ --apply
expect_code 0
expect_out_is "#1${T}idea${T}Chore${T}set
#28${T}bug${T}Bug${T}set
#33${T}design${T}Design${T}set
#41${T}chore${T}Chore${T}set
#102${T}spike${T}Chore${T}set
#154${T}feature${T}Feature${T}set"
expect_err "set 6, failed 0, skipped 0, already right 0"
expect_call "api -X PATCH repos/sssoto17/sunny-pastures/issues/154 -f type=Feature --silent"
expect_call "api repos/sssoto17/sunny-pastures/issue-types --jq"
assert "expected no graphql call" test "$(grep -c graphql <<<"$calls")" -eq 0
expect_call "api repos/sssoto17/sunny-pastures/issues/41 --jq .type.name // \"-\""

# A failed write and a read-back that differs are listed; the rest still run.
reset "$mixed"
touch "$work/fail-set.28"
echo Chore >"$work/readback.154"
case_ --apply
expect_code 1
expect_out_is "#1${T}idea${T}Chore${T}set
#33${T}design${T}Design${T}set
#41${T}chore${T}Chore${T}set
#102${T}spike${T}Chore${T}set"
expect_err "#28: the write failed"
expect_err "#154: the read-back shows Chore, expected Feature"
expect_err "set 4, failed 2"

# --- reads that fail write nothing ---------------------------------------------------------------
reset "$mixed"
touch "$work/fail-types"
case_ --apply
expect_code 3
expect_err "could not read the repo's issue types; nothing was written"
expect_no_writes

# The repo's types and the mapping must agree, so a rename stops the run before it lists (#266).
reset "$mixed"
printf '%s\n' Task Bug Feature Design >"$work/types"
case_ --apply
expect_code 3
expect_out_is ""
expect_err "the repo's issue types (Task, Bug, Feature, Design) and the mapping in scripts/lib/issue-types.sh (Feature, Bug, Design, Chore) disagree: the repo offers no Chore; nothing maps to Task;"
expect_err "nothing was written"
expect_no_writes

reset "$mixed"
touch "$work/fail-list"
case_ --apply
expect_code 3
expect_out_is ""
expect_err "could not read the open issues"
expect_no_writes

reset "28${T}issue"
case_ --apply
expect_code 3
expect_err "unexpected row from GitHub"
expect_no_writes

# --- the --jq filter over a REST page ---------------------------------------------------------
# GitHub's REST issue carries the native type as .type, null when unset (seen on #158, 12 Nov).
# A missing jq is a failure, not a skip (CONSTRAINTS.md, "Guarding the bar").
args=("--jq filter")
if ! command -v jq >/dev/null; then
  code="" out="" err="" calls=""
  bad "jq is not installed: install it to run the --jq filter case"
else
  reset ""
  cat >"$work/page.json" <<'JSON'
[
  {"number": 120, "node_id": "PR_1", "pull_request": {"url": "x"}, "labels": [], "type": null},
  {"number": 28, "node_id": "I_28", "type": null, "labels": [{"name": "bug"}, {"name": "area:db"}]},
  {"number": 33, "node_id": "I_33", "type": {"id": 7, "name": "Design"}, "labels": [{"name": "design"}]},
  {"number": 5, "node_id": "I_5", "labels": [{"name": "x,chore"}, {"name": "idea"}]},
  {"number": 6, "node_id": "I_6", "type": null, "labels": []}
]
JSON
  run
  expect_code 0
  expect_out_is "#5${T}idea${T}Chore
#6${T}skip: no type label
#28${T}bug${T}Bug"
  expect_err "would set 2, skipped 1, already right 1"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

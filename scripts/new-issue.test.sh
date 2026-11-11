#!/usr/bin/env bash
# Tests for new-issue.sh through its command line. The script runs from a copy in a temp folder,
# beside a fake issue-fields.sh, with `gh` replaced by a fake on PATH. Neither reaches GitHub.
# The fake gh logs every call and answers each read with the rows the script's --jq filter would
# produce (gh evaluates the filter; these tests don't depend on jq). The filters themselves run
# only against the real API (see the PR's dry run).
# Run: bash scripts/new-issue.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/new-issue-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/scripts"
cp "$here/new-issue.sh" "$work/scripts/new-issue.sh"
script="$work/scripts/new-issue.sh"

# --- fakes ------------------------------------------------------------------------------------
# gh: each call appends its arguments to $work/calls, one per line, then a "--" line.
#   label list           -> $work/labels, or exit 1 if $work/fail-labels exists
#   api .../milestones   -> $work/milestones
#   api .../issues/<N>   -> $work/issue.<N> (the parent check before, the read-back after);
#                           exit 1 if that file is missing, as gh does on a 404
#   issue create         -> the new issue's URL, or exit 1 if $work/fail-create exists
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
if [[ $1 == label && $2 == list ]]; then
  [[ -f $dir/fail-labels ]] && { echo "fake: label list failed" >&2; exit 1; }
  cat "$dir/labels"
  exit
fi
if [[ $1 == api && $2 == */milestones* ]]; then
  cat "$dir/milestones"
  exit
fi
if [[ $1 == api && $2 =~ /issues/([0-9]+)$ ]]; then
  f=$dir/issue.${BASH_REMATCH[1]}
  [[ -f $f ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
  cat "$f"
  exit
fi
if [[ $1 == issue && $2 == create ]]; then
  [[ -f $dir/fail-create ]] && { echo "fake: create failed" >&2; exit 1; }
  echo "https://github.com/sssoto17/sunny-pastures/issues/200"
  exit
fi
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"

# issue-fields.sh: logs its arguments on one line to $work/fields-calls and prints what the real
# one prints; exits with the code in $work/fail-fields if that file exists.
cat >"$work/scripts/issue-fields.sh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/fields-calls"
if [[ -f $dir/fail-fields ]]; then
  echo "issue-fields: unknown Size \"XL\". Valid names: S, M, L. Nothing was changed." >&2
  exit "$(cat "$dir/fail-fields")"
fi
printf 'https://github.com/sssoto17/sunny-pastures/issues/%s\nStatus:   Backlog\n' "$1"
FAKE
chmod +x "$work/scripts/issue-fields.sh"

T=$'\t'
reset() {
  rm -f "$work"/calls "$work"/fields-calls "$work"/fail-* "$work"/issue.*
  printf '%s\n' bug feature chore spike design idea area:sim area:tools area:docs review:admin \
    >"$work/labels"
  printf '%s\n' "M2 Sim properties + factory" "M3 Game API" >"$work/milestones"
  printf 'open%sissue\n' "$T" >"$work/issue.73"
  printf 'closed%sissue\n' "$T" >"$work/issue.40"
  printf 'open%spr\n' "$T" >"$work/issue.151"
  # The read-back of the new issue: labels, milestone, parent number.
  printf 'chore,area:tools%sM2 Sim properties + factory%s73\n' "$T" "$T" >"$work/issue.200"
  printf 'Some body.\n' >"$work/body.md"
  : >"$work/empty.md"
}

run() { # args... -> sets code, out, err, calls, fields
  out=$(cd "$work" && PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
  fields=$(cat "$work/fields-calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls:\n%s\n  issue-fields: %s\n' \
    "$1" "${args[*]}" "$code" "$out" "$err" "    ${calls//$'\n'/$'\n'    }" "$fields"
}
assert() { # message command... -> ok if the command succeeds
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
expect_no_gh() { assert "expected no gh calls at all" test -z "$calls$fields"; }
# A write is an issue create or an issue-fields run.
expect_no_writes() {
  if grep -qx create <<<"$calls" || [[ -n $fields ]]; then bad "expected no writes"; else ok; fi
}
# The gh calls joined into one line each.
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
expect_call() { # substring of one joined call line
  if call_lines | grep -qF -- "$1"; then ok; else bad "expected a gh call containing: $1"; fi
}
expect_no_call() {
  if call_lines | grep -qF -- "$1"; then bad "expected no gh call containing: $1"; else ok; fi
}
case_() { args=("$@"); run "$@"; }

base=(--title "Add a thing" --type chore --area tools --milestone "M2 Sim properties + factory"
  --body-file body.md --parent 73)

# --- usage ------------------------------------------------------------------------------------
reset
case_
expect_code 2
expect_err "usage:"
expect_no_gh

case_ --help
expect_code 0
expect_err "usage:"
expect_no_gh

# Each required flag, left out, is refused before any gh call.
for drop in --title --type --area --milestone --body-file --parent; do
  reset
  a=()
  for ((i = 0; i < ${#base[@]}; i += 2)); do
    [[ ${base[i]} == "$drop" ]] || a+=("${base[i]}" "${base[i + 1]}")
  done
  case_ "${a[@]}"
  expect_code 2
  expect_err "${drop}"
  expect_no_gh
done

for bad_args in "--colour red" "--title" "--title x --title y" "extra" "--parent abc" \
  "--parent 0" "--type story" "--area AREA:Sim" "--size"; do
  reset
  read -ra words <<<"$bad_args"
  case_ "${base[@]}" "${words[@]}"
  expect_code 2
  expect_no_gh
done
reset
case_ "${base[@]}" --colour red
expect_err 'unknown option "--colour"'
case_ "${base[@]}" --type story
expect_err "--type given twice"
case_ --title x --type story --area tools --milestone M2 --body-file body.md --parent 73
expect_err 'unknown type "story". Valid types: feature, bug, spike, design, chore, idea'

# Admin-only values are refused before anything is created.
reset
case_ "${base[@]}" --status Ready
expect_code 2
expect_err "a new issue always starts in Backlog"
expect_no_gh
case_ "${base[@]}" --status Backlog
expect_code 2
expect_no_gh
case_ "${base[@]}" --mode Factory
expect_code 2
expect_err "only the admin sets Mode to Factory"
expect_no_gh
case_ "${base[@]}" --mode factory
expect_code 2
expect_no_gh

# Parents: every issue sits under one, except an idea, which has none (issue-tracker.md, Grouping).
reset
case_ --title x --type idea --area tools --milestone M2 --body-file body.md --parent 73
expect_code 2
expect_err "an idea has no parent"
expect_no_gh

# The body file must exist and hold something.
reset
case_ --title x --type chore --area tools --milestone M2 --body-file missing.md --parent 73
expect_code 2
expect_err "missing.md"
expect_no_gh
case_ --title x --type chore --area tools --milestone M2 --body-file empty.md --parent 73
expect_code 2
expect_err "empty.md"
expect_no_gh

# --- names checked against GitHub before the first write -------------------------------------
reset
case_ --title x --type chore --area ui --milestone "M2 Sim properties + factory" \
  --body-file body.md --parent 73
expect_code 2
expect_err 'unknown area "area:ui". Valid areas: area:sim, area:tools, area:docs'
expect_err "Nothing was created"
expect_no_writes

reset
case_ --title x --type chore --area tools --milestone "M9" --body-file body.md --parent 73
expect_code 2
expect_err 'unknown milestone "M9". Open milestones: M2 Sim properties + factory, M3 Game API'
expect_no_writes

reset
case_ --title x --type chore --area tools --milestone "M3 Game API" --body-file body.md --parent 40
expect_code 2
expect_err "parent #40 is closed"
expect_no_writes

reset
case_ --title x --type chore --area tools --milestone "M3 Game API" --body-file body.md --parent 151
expect_code 2
expect_err "#151 is a pull request"
expect_no_writes

reset
case_ --title x --type chore --area tools --milestone "M3 Game API" --body-file body.md --parent 999
expect_code 3
expect_err "could not read parent #999"
expect_no_writes

reset
touch "$work/fail-labels"
case_ "${base[@]}"
expect_code 3
expect_err "could not read"
expect_no_writes

# --- the write path ---------------------------------------------------------------------------
reset
case_ "${base[@]}" --track Build --size S --priority P1 --week "Wk 2"
expect_code 0
expect_call "issue create --repo sssoto17/sunny-pastures --title Add a thing --body-file body.md --label chore --label area:tools --milestone M2 Sim properties + factory --parent 73"
assert "issue-fields gets the new number and the fields" test "$fields" = "200 --track Build --size S --priority P1 --week Wk 2"
expect_out "https://github.com/sssoto17/sunny-pastures/issues/200"
expect_out "Status:   Backlog"
expect_out "Labels:   chore, area:tools"
expect_out "Milestone: M2 Sim properties + factory"
expect_out "Parent:   #73"

# Forms the coordinator types: "area:tools", "#73", --flag=value.
reset
case_ --title="Add a thing" --type=chore --area=area:tools \
  --milestone="M2 Sim properties + factory" --body-file=body.md --parent="#73"
expect_code 0
expect_call "--label chore --label area:tools --milestone M2 Sim properties + factory --parent 73"
assert "issue-fields runs with no fields, so the issue lands in Backlog" test "$fields" = "200"

# An idea has no parent: no --parent on create, and none expected on read-back.
reset
printf 'idea,area:tools%sM3 Game API%s-\n' "$T" "$T" >"$work/issue.200"
case_ --title x --type idea --area tools --milestone "M3 Game API" --body-file body.md
expect_code 0
expect_no_call "--parent"
expect_out "Parent:   -"

# --- failures after the first write say what exists -------------------------------------------
reset
touch "$work/fail-create"
case_ "${base[@]}"
expect_code 1
expect_err "gh issue create failed"
expect_err "before re-running"
assert "issue-fields isn't run" test -z "$fields"

reset
echo 2 >"$work/fail-fields"
case_ "${base[@]}" --size XL
expect_code 1
expect_err 'unknown Size "XL"'
expect_err "#200 was created"
expect_err "scripts/issue-fields.sh 200 --size XL"

reset
printf 'chore,area:tools%sM2 Sim properties + factory%s-\n' "$T" "$T" >"$work/issue.200"
case_ "${base[@]}"
expect_code 1
expect_err "parent is -, expected #73"

reset
printf 'chore%sM2 Sim properties + factory%s73\n' "$T" "$T" >"$work/issue.200"
case_ "${base[@]}"
expect_code 1
expect_err "missing label area:tools"

rm -f "$work/issue.200"
reset
rm -f "$work/issue.200"
case_ "${base[@]}"
expect_code 1
expect_err "couldn't be read back"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

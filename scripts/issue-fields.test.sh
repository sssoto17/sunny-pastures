#!/usr/bin/env bash
# Tests for issue-fields.sh through its command line, with `gh` replaced by a fake on PATH.
# The fake logs every call and never reaches GitHub. It holds the issue's Project item as the
# tab-separated rows the script's --jq filter produces, applies each item-add / item-edit, type
# mutation and label removal to them, and serves them to the next lookup, so the read-back sees
# what was written.
# The --jq filter itself runs only against the real API (see the PR's dry run): gh evaluates it,
# and these tests don't depend on jq.
# Run: bash scripts/issue-fields.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/issue-fields.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/issue-fields-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# --- fake gh ----------------------------------------------------------------------------------
# Each call appends its arguments to $work/calls, one per line, then a "--" line.
# Lookup N serves $work/state, unless $work/fail-lookup.N exists: then it prints that file to
# stderr and exits 1, as gh does on a GraphQL error.
# item-add adds an item row. item-edit replaces the field's value row with the option's name,
# unless $work/drop-edit exists (the edit "succeeds" but GitHub doesn't show it yet). If
# $work/fail-edit exists, edit number N (its content, default 1) and later ones exit 1.
# The updateIssue mutation replaces the Type value row (exit 1 if $work/fail-type exists).
# issue edit --remove-label drops the label row (exit 1 if $work/fail-remove exists; kept, with
# exit 0, if $work/drop-remove exists).
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
state=$dir/state
T=$'\t'
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
if [[ $1 == api && $2 == graphql && $* == *"query=mutation"* ]]; then
  [[ -f $dir/fail-type ]] && { echo "fake: updateIssue failed" >&2; exit 1; }
  for a in "$@"; do
    case $a in
      type=*) type_id=${a#type=} ;;
      issue=*) issue_id=${a#issue=} ;;
    esac
  done
  grep -qxF "issue${T}https://github.com/sssoto17/sunny-pastures/issues/47${T}$issue_id" "$state" ||
    { echo "fake: no issue $issue_id" >&2; exit 1; }
  name=$(awk -F'\t' -v o="$type_id" '$1 == "option" && $2 == "Type" && $5 == o { print $6 }' "$state")
  [[ -n $name ]] || { echo "fake: no issue type $type_id" >&2; exit 1; }
  awk -F'\t' '!($1 == "value" && $2 == "Type")' "$state" >"$state.new"
  printf 'value\tType\t%s\n' "$name" >>"$state.new"
  mv "$state.new" "$state"
  echo '{"data":{}}'
  exit
fi
if [[ $1 == issue && $2 == edit ]]; then
  [[ -f $dir/fail-remove ]] && { echo "fake: issue edit failed" >&2; exit 1; }
  [[ -f $dir/drop-remove ]] && exit
  [[ $* == *"--remove-label triage"* ]] || { echo "fake: unexpected issue edit: $*" >&2; exit 99; }
  awk -F'\t' '!($1 == "label" && $2 == "triage")' "$state" >"$state.new"
  mv "$state.new" "$state"
  exit
fi
if [[ $1 == api && $2 == graphql ]]; then
  n=$(($(cat "$dir/lookups" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$dir/lookups"
  if [[ -f $dir/fail-lookup.$n ]]; then
    cat "$dir/fail-lookup.$n" >&2
    exit 1
  fi
  cat "$state"
  exit
fi
if [[ $1 == project && $2 == item-add ]]; then
  [[ -f $dir/fail-add ]] && { echo "fake: item-add failed" >&2; exit 1; }
  printf 'item\tPVTI_new\n' >>"$state"
  echo PVTI_new
  exit
fi
if [[ $1 == project && $2 == item-edit ]]; then
  edits=$(($(cat "$dir/edits" 2>/dev/null || echo 0) + 1))
  echo "$edits" >"$dir/edits"
  if [[ -f $dir/fail-edit ]]; then # holds the number of the edit that fails; empty means the 1st
    fail_at=$(cat "$dir/fail-edit")
    if ((edits >= ${fail_at:-1})); then
      echo "fake: item-edit failed" >&2
      exit 1
    fi
  fi
  shift 2
  while (($#)); do
    case $1 in
      --field-id) field_id=$2 ;;
      --single-select-option-id | --iteration-id) option_id=$2 ;;
    esac
    shift 2
  done
  [[ -f $dir/drop-edit ]] && exit
  row=$(awk -F'\t' -v f="$field_id" -v o="$option_id" \
    '$1 == "option" && $3 == f && $5 == o { print $2 "\t" $6 }' "$state")
  [[ -n $row ]] || { echo "fake: no option $option_id on field $field_id" >&2; exit 1; }
  awk -F'\t' -v f="${row%%$'\t'*}" '!($1 == "value" && $2 == f)' "$state" >"$state.new"
  printf 'value\t%s\n' "$row" >>"$state.new"
  mv "$state.new" "$state"
  echo "Edited item"
  exit
fi
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"

# --- fixtures ---------------------------------------------------------------------------------
# The Project's fields as the --jq filter emits them, one row per option (ids copied from the
# live Project on 7 Nov): option, field name, field id, select/iteration, option id, option name.
T=$'\t'
project_rows() {
  local field id kind rest opt
  printf 'project%sPVT_kwHOCI1msM4BqXYM\n' "$T"
  while read -r field id kind rest; do
    IFS=, read -ra opts <<<"$rest"
    for opt in "${opts[@]}"; do
      printf 'option%s%s%s%s%s%s%s%s%s%s\n' "$T" "$field" "$T" "$id" "$T" "$kind" "$T" "${opt%%=*}" "$T" "${opt#*=}"
    done
  done <<'ROWS'
Status PVTSSF_status select 97a20eba=Backlog,eb23e874=Ready,03b81b61=In progress,e763de54=In review,04fb4a2b=Done
Mode PVTSSF_mode select ca9bd7b8=Manual,f92520e5=Factory
Track PVTSSF_track select 60e95dc9=Build,df832856=Design,d064f0c0=Report,3200c1d7=Infra,145afb58=Evaluation
Size PVTSSF_size select 7a7f9f73=S,e0e2efb6=M,c7dede81=L
Week PVTIF_week iteration 7f9c9b7a=Wk 2 · 9–15 Nov,b40f9349=Wk 3 · 16–22 Nov,f9409a73=Wk 1 · 2–8 Nov
Priority PVTSSF_priority select 598fd74b=P0,ad39d061=P1,a38a49d8=P2,cad16246=P3
Type - type IT_chore=Chore,IT_bug=Bug,IT_feature=Feature,IT_design=Design
ROWS
}
issue_row() { printf 'issue%shttps://github.com/sssoto17/sunny-pastures/issues/47%sI_kw47\n' "$T" "$T"; }
# Label rows on the issue, one per name.
label_rows() {
  local name
  for name in "$@"; do printf 'label%s%s\n' "$T" "$name"; done
}
# The issue's item on the Project, with "Field=Value" pairs (Type=... is the issue's native
# type, which the filter emits as a value row too); "null" means not on the Project.
item() {
  local pair
  printf 'item%sPVTI_existing\n' "$T"
  for pair in "$@"; do
    printf 'value%s%s%s%s\n' "$T" "${pair%%=*}" "$T" "${pair#*=}"
  done
}

reset() { # item rows, or "null" -> a fresh state: the Project, the issue and its item
  rm -f "$work"/calls "$work"/lookups "$work"/edits "$work"/state "$work"/fail-* "$work"/drop-*
  { project_rows; issue_row; [[ $1 == null ]] || printf '%s\n' "$1"; } >"$work/state"
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
    "$1" "${args[*]}" "$code" "$out" "$err" "    ${calls//$'\n'/$'\n'    }"
}
assert() { # message command... -> ok if the command succeeds
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
count() { grep -c "$1" <<<"$calls"; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
expect_no_gh() { assert "expected no gh calls at all" test -z "$calls"; }
# A write is any gh call other than the read-only GraphQL lookup.
expect_no_writes() {
  if grep -qx 'item-add\|item-edit\|edit' <<<"$calls" || grep -q '^query=mutation' <<<"$calls"; then
    bad "expected no writes"
  else
    ok
  fi
}
# The gh calls joined into one line each: "project item-edit --project-id ... --id ...".
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
expect_call() { # substring of one joined call line
  if call_lines | grep -qF -- "$1"; then ok; else bad "expected a gh call containing: $1"; fi
}
expect_no_call() {
  if call_lines | grep -qF -- "$1"; then bad "expected no gh call containing: $1"; else ok; fi
}
case_() { args=("$@"); run "$@"; }

# --- usage ------------------------------------------------------------------------------------
reset null
case_
expect_code 2
expect_err "usage:"
expect_no_writes

for bad_args in "abc --size M" "47 --colour red" "47 --size" "47 --size M --size L" \
  "47 --size --track Build" "47 extra" "0 --size M" "--size M"; do
  reset null
  read -ra words <<<"$bad_args"
  case_ "${words[@]}"
  expect_code 2
  expect_no_gh
done
reset null
case_ 47 --colour red
expect_err 'unknown option "--colour"'
case_ 47 --size M --size L
expect_err "--size given twice"
case_ 47 --size
expect_err "--size needs a value"
case_ abc
expect_err 'not an issue number: "abc"'

reset null
case_ --help
expect_code 0
expect_err "usage:"
expect_no_gh

# "#47" is accepted as issue 47.
reset "$(item Status=Backlog)"
case_ "#47" --size S
expect_code 0
expect_call "number=47"

# --- names in, ids out ------------------------------------------------------------------------
reset "$(item Status=Backlog)"
case_ 47 --priority P1
expect_code 0
expect_call "project item-edit --project-id PVT_kwHOCI1msM4BqXYM --id PVTI_existing --field-id PVTSSF_priority --single-select-option-id ad39d061"
expect_no_call "item-add"

reset "$(item Status=Backlog)"
case_ 47 --track Infra --mode Manual --size M --week "Wk 2"
expect_code 0
edit="project item-edit --project-id PVT_kwHOCI1msM4BqXYM --id PVTI_existing"
expect_call "$edit --field-id PVTSSF_track --single-select-option-id 3200c1d7"
expect_call "$edit --field-id PVTSSF_mode --single-select-option-id ca9bd7b8"
expect_call "$edit --field-id PVTSSF_size --single-select-option-id e0e2efb6"
expect_call "$edit --field-id PVTIF_week --iteration-id 7f9c9b7a"

# The full iteration title works too, a completed week is still a valid name, and names ignore case.
reset "$(item Status=Backlog)"
case_ 47 --week "Wk 1 · 2–8 Nov" --track infra
expect_code 0
expect_call "$edit --field-id PVTIF_week --iteration-id f9409a73"
expect_call "$edit --field-id PVTSSF_track --single-select-option-id 3200c1d7"

# --flag=value, and a value with a space survives (the zsh/bash word-splitting bug of 7 Nov).
reset "$(item Status=Backlog)"
case_ 47 --size=S "--week=Wk 3"
expect_code 0
expect_call "$edit --field-id PVTSSF_size --single-select-option-id 7a7f9f73"
expect_call "$edit --field-id PVTIF_week --iteration-id b40f9349"

# --- adding to the Project, and Status --------------------------------------------------------
# Not on the Project yet: add it, then set Backlog and the fields.
reset null
case_ 47 --size S
expect_code 0
expect_call "project item-add 3 --owner sssoto17 --url https://github.com/sssoto17/sunny-pastures/issues/47"
new="project item-edit --project-id PVT_kwHOCI1msM4BqXYM --id PVTI_new"
expect_call "$new --field-id PVTSSF_status --single-select-option-id 97a20eba"
expect_call "$new --field-id PVTSSF_size --single-select-option-id 7a7f9f73"

# On the Project with no Status (added by hand): Backlog.
reset "$(item Size=S)"
case_ 47 --size M
expect_code 0
expect_call "$edit --field-id PVTSSF_status --single-select-option-id 97a20eba"

# On the Project with a Status: left alone, so fixing a field never undoes the admin's Ready.
reset "$(item Status=Ready)"
case_ 47 --size M
expect_code 0
expect_no_call "PVTSSF_status"

# --status sets any status but Ready.
reset "$(item Status=Backlog)"
case_ 47 --status "In progress"
expect_code 0
expect_call "$edit --field-id PVTSSF_status --single-select-option-id 03b81b61"

for ready in Ready ready "--status=Ready"; do
  reset "$(item Status=Backlog)"
  if [[ $ready == --* ]]; then case_ 47 "$ready"; else case_ 47 --size S --status "$ready"; fi
  expect_code 2
  expect_err "only the admin moves an issue to Ready"
  expect_no_gh
done

# If adding to the Project fails, stop before any edit.
reset null
touch "$work/fail-add"
case_ 47 --size S
expect_code 1
expect_no_call "item-edit"

# --- the result is read back and printed ------------------------------------------------------
reset null
case_ 47 --track Infra --size S --priority P1 --week "Wk 2"
expect_code 0
expect_out "https://github.com/sssoto17/sunny-pastures/issues/47"
expect_out "Status:   Backlog"
expect_out "Track:    Infra"
expect_out "Mode:     -"
expect_out "Size:     S"
expect_out "Priority: P1"
expect_out "Week:     Wk 2 · 9–15 Nov"
assert "expected a second lookup after the writes" test "$(count '^query=query')" -eq 2

# --- lookup failures stop before any write -----------------------------------------------------
# A lookup with no issue row (the filter emits none when the issue is null).
reset null
project_rows >"$work/state"
case_ 9999 --size S
expect_code 1
expect_err "issue #9999 not found"
expect_no_writes

reset null
issue_row >"$work/state"
case_ 47 --size S
expect_code 1
expect_err "Project 3 of sssoto17 not found"
expect_no_writes

# An edit that fails stops the run and says so.
reset "$(item Status=Backlog)"
touch "$work/fail-edit"
case_ 47 --size S --priority P1
expect_code 1
expect_err "could not set Size"
assert "expected to stop after the failed edit" test "$(count '^item-edit$')" -eq 1


# The real API's answer to a missing issue: a GraphQL error, and gh exits 1.
reset null
echo "GraphQL: Could not resolve to an Issue with the number of 9999. (repository.issue)" \
  >"$work/fail-lookup.1"
case_ 9999 --size S
expect_code 1
expect_err "Could not resolve to an Issue"
expect_err "nothing was changed"
expect_no_writes

# --- read-back failures after the writes -------------------------------------------------------
# The writes went through but the second lookup failed: don't claim nothing changed.
reset "$(item Status=Backlog)"
echo "fake: lookup failed" >"$work/fail-lookup.2"
case_ 47 --size S
expect_code 1
expect_err "fields were written but couldn't be read back; re-run to check"
assert 'expected no "nothing was changed" after writes' test "${err/nothing was changed/}" == "$err"

# The edit "succeeded" but the read-back doesn't show it: fail and name the field.
reset "$(item Status=Backlog Size=M)"
touch "$work/drop-edit"
case_ 47 --size S --priority P1
expect_code 1
expect_out "Size:     M"
expect_err "Size is M, expected S"
expect_err "Priority is -, expected P1"
expect_err "re-run to check"

# A part-way failure names what was set and what wasn't.
reset "$(item Status=Backlog)"
printf '2\n' >"$work/fail-edit"
case_ 47 --size S --priority P1 --mode Manual
expect_code 1
expect_err "could not set Priority"
expect_err "set: Size; not set: Priority, Mode"

# --- admin-only values ---------------------------------------------------------------------------
for factory in Factory factory "--mode=Factory"; do
  reset "$(item Status=Backlog)"
  if [[ $factory == --* ]]; then case_ 47 "$factory"; else case_ 47 --size S --mode "$factory"; fi
  expect_code 2
  expect_err "only the admin sets Mode to Factory"
  expect_no_gh
done

# The valid-names lists don't offer what the script refuses.
reset "$(item Status=Backlog)"
case_ 47 --status Blocked
expect_code 2
expect_err "Valid names: Backlog, In progress, In review, Done."
reset "$(item Status=Backlog)"
case_ 47 --mode Robot
expect_code 2
expect_err "Valid names: Manual."

# --- unknown names fail loudly and change nothing ---------------------------------------------
reset "$(item Status=Backlog)"
case_ 47 --size M --priority P9
expect_code 2
expect_err 'unknown Priority "P9"'
expect_err "P0, P1, P2, P3"
expect_no_writes

reset "$(item Status=Backlog)"
case_ 47 --week "Wk 99"
expect_code 2
expect_err "Wk 2, Wk 3, Wk 1"
expect_no_writes

# An empty value is an unknown name, not a skipped field.
reset "$(item Status=Backlog)"
case_ 47 --track ""
expect_code 2
expect_err 'unknown Track ""'
expect_no_writes

# --- the native issue type ---------------------------------------------------------------------
# Set on the issue with updateIssue's issueTypeId, by the id the lookup found for the name.
reset "$(item Status=Backlog)"
case_ 47 --type Chore
expect_code 0
expect_call "-f issue=I_kw47 -f type=IT_chore"
expect_no_call "item-edit"
expect_out "Type:     Chore"

# Names ignore case, like the Project fields.
reset "$(item Status=Backlog Type=Chore)"
case_ 47 --type bug
expect_code 0
expect_call "-f issue=I_kw47 -f type=IT_bug"
expect_out "Type:     Bug"

# Design, the type a `design` issue maps to (#266).
reset "$(item Status=Backlog Type=Chore)"
case_ 47 --type Design
expect_code 0
expect_call "-f issue=I_kw47 -f type=IT_design"
expect_out "Type:     Design"

# An unknown type fails with the valid names and writes nothing.
reset "$(item Status=Backlog)"
case_ 47 --type Epic --size S
expect_code 2
expect_err 'unknown Type "Epic". Valid names: Chore, Bug, Feature, Design.'
expect_no_writes

reset "$(item Status=Backlog)"
touch "$work/fail-type"
case_ 47 --type Chore --size S
expect_code 1
expect_err "could not set Type"
expect_err "not set: Type, Size"

# --- triage comes off once type, Priority, Size and Week are all set ----------------------------
four=(Type=Chore Priority=P2 Size=S "Week=Wk 2 · 9–15 Nov")

# Set by this run.
reset "$(item Status=Backlog; label_rows triage chore)"
case_ 47 --type Chore --size S --priority P2 --week "Wk 2"
expect_code 0
expect_call "issue edit 47 --repo sssoto17/sunny-pastures --remove-label triage"
expect_out "Triage:   removed (type, Priority, Size and Week are set)"
assert "expected a third lookup after removing triage" test "$(count '^query=query')" -eq 3

# Already set (the admin set them in the UI): a run with no flags removes it.
reset "$(item Status=Backlog "${four[@]}"; label_rows triage)"
case_ 47
expect_code 0
expect_call "--remove-label triage"
expect_out "Triage:   removed"

# Each one missing keeps triage, and the line names it.
for drop in Type Priority Size Week; do
  pairs=()
  for pair in "${four[@]}"; do [[ ${pair%%=*} == "$drop" ]] || pairs+=("$pair"); done
  reset "$(item Status=Backlog "${pairs[@]}"; label_rows triage)"
  case_ 47 --track Build
  expect_code 0
  expect_no_call "--remove-label"
  expect_out "Triage:   yes (missing: $drop)"
done

# No triage label: nothing to remove; a missing field is still named.
reset "$(item Status=Backlog "${four[@]}")"
case_ 47
expect_code 0
expect_no_call "issue edit"
expect_out "Triage:   -"
reset "$(item Status=Backlog Size=S)"
case_ 47
expect_code 0
expect_out "Triage:   - (missing: Type, Priority, Week)"

# The removal fails: say the fields are set and print the command that finishes it.
reset "$(item Status=Backlog "${four[@]}"; label_rows triage)"
touch "$work/fail-remove"
case_ 47
expect_code 1
expect_err "the fields are set, but \`triage\` couldn't be removed"
expect_err "gh issue edit 47 --repo sssoto17/sunny-pastures --remove-label triage"

# The removal "succeeds" but the read-back still shows triage.
reset "$(item Status=Backlog "${four[@]}"; label_rows triage)"
touch "$work/drop-remove"
case_ 47
expect_code 1
expect_out "Triage:   yes"
expect_err "triage is still on, though all four are set"

# --- called from zsh ---------------------------------------------------------------------------
# zsh doesn't split unquoted $var, which silently dropped 5 of #47's fields on 7 Nov. The script
# runs under bash whatever the caller's shell, so a zsh caller gets the same calls.
# A missing zsh is a failure, not a skip (CONSTRAINTS.md, "Guarding the bar").
args=(zsh -c "...")
if ! command -v zsh >/dev/null; then
  code="" out="" err="" calls=""
  bad "zsh is not installed: install it to run the zsh caller case"
else
  reset "$(item Status=Backlog)"
  out=$(PATH="$work/bin:$PATH" zsh -fc '"$1" 47 --size M --week "Wk 2"' zsh "$script" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
  expect_code 0
  expect_call "$edit --field-id PVTSSF_size --single-select-option-id e0e2efb6"
  expect_call "$edit --field-id PVTIF_week --iteration-id 7f9c9b7a"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

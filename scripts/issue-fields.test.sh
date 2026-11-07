#!/usr/bin/env bash
# Tests for issue-fields.sh through its command line, with `gh` replaced by a stub on PATH.
# The stub logs every call, answers the GraphQL lookup from a fixture shaped like the real
# response (applying the script's own --jq filter with jq), and never reaches GitHub.
# Run: bash scripts/issue-fields.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/issue-fields.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/issue-fields-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# --- gh stub ----------------------------------------------------------------------------------
# Each call appends its arguments to $work/calls, one per line, then a "--" line.
# `gh api graphql` answers with fixture.N.json (N = how many lookups so far), else fixture.json.
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
if [[ $1 == api && $2 == graphql ]]; then
  n=$(($(cat "$dir/lookups" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$dir/lookups"
  fixture=$dir/fixture.$n.json
  [[ -f $fixture ]] || fixture=$dir/fixture.json
  filter=.
  while (($#)); do
    if [[ $1 == --jq ]]; then filter=$2; fi
    shift
  done
  jq -r "$filter" "$fixture"
  exit
fi
if [[ $1 == project && $2 == item-add ]]; then
  [[ -f $dir/fail-add ]] && { echo "stub: item-add failed" >&2; exit 1; }
  echo PVTI_new
  exit
fi
if [[ $1 == project && $2 == item-edit ]]; then
  [[ -f $dir/fail-edit ]] && { echo "stub: item-edit failed" >&2; exit 1; }
  echo "Edited item"
  exit
fi
echo "stub: unexpected gh call: $*" >&2
exit 99
STUB
chmod +x "$work/bin/gh"

# --- fixtures ---------------------------------------------------------------------------------
# The Project's fields as GitHub returns them (ids copied from the live Project on 7 Nov), and an
# issue whose project item, if any, is given as JSON.
fixture() { # item-json-or-null -> stdout
  cat <<JSON
{"data":{
 "user":{"projectV2":{"id":"PVT_kwHOCI1msM4BqXYM","fields":{"nodes":[
  {},
  {"id":"PVTSSF_status","name":"Status","options":[{"id":"97a20eba","name":"Backlog"},{"id":"eb23e874","name":"Ready"},{"id":"03b81b61","name":"In progress"},{"id":"e763de54","name":"In review"},{"id":"04fb4a2b","name":"Done"}]},
  {"id":"PVTSSF_mode","name":"Mode","options":[{"id":"ca9bd7b8","name":"Manual"},{"id":"f92520e5","name":"Factory"}]},
  {"id":"PVTSSF_track","name":"Track","options":[{"id":"60e95dc9","name":"Build"},{"id":"df832856","name":"Design"},{"id":"d064f0c0","name":"Report"},{"id":"3200c1d7","name":"Infra"},{"id":"145afb58","name":"Evaluation"}]},
  {"id":"PVTSSF_size","name":"Size","options":[{"id":"7a7f9f73","name":"S"},{"id":"e0e2efb6","name":"M"},{"id":"c7dede81","name":"L"}]},
  {"id":"PVTIF_week","name":"Week","configuration":{
    "iterations":[{"id":"7f9c9b7a","title":"Wk 2 · 9–15 Nov"},{"id":"b40f9349","title":"Wk 3 · 16–22 Nov"}],
    "completedIterations":[{"id":"f9409a73","title":"Wk 1 · 2–8 Nov"}]}},
  {"id":"PVTSSF_priority","name":"Priority","options":[{"id":"598fd74b","name":"P0"},{"id":"ad39d061","name":"P1"},{"id":"a38a49d8","name":"P2"},{"id":"cad16246","name":"P3"}]}
 ]}}},
 "repository":{"issue":{"url":"https://github.com/sssoto17/sunny-pastures/issues/47","title":"Some issue","projectItems":{"nodes":[
  {"id":"PVTI_other","project":{"id":"PVT_someone_else"},"fieldValues":{"nodes":[]}}
  $( [[ $1 != null ]] && printf ',%s' "$1" )
 ]}}}
}}
JSON
}
item() { # status track... as "Field=Value" pairs -> item JSON on the Sunny Pastures Project
  local values="" pair
  for pair in "$@"; do
    local field=${pair%%=*} value=${pair#*=} key=name
    [[ $field == Week ]] && key=title
    values+="${values:+,}{\"$key\":\"$value\",\"field\":{\"name\":\"$field\"}}"
  done
  printf '{"id":"PVTI_existing","project":{"id":"PVT_kwHOCI1msM4BqXYM"},"fieldValues":{"nodes":[{},%s]}}' "$values"
}

reset() { # item-json-or-null for every lookup
  rm -f "$work"/calls "$work"/lookups "$work"/fixture*.json "$work"/fail-*
  fixture "$1" >"$work/fixture.json"
}
after() { # item-json for the lookup after the writes (the second lookup)
  fixture "$1" >"$work/fixture.2.json"
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
  if grep -qx 'item-add\|item-edit' <<<"$calls"; then bad "expected no writes"; else ok; fi
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
# Not on the Project yet (only on someone else's): add it, then set Backlog and the fields.
reset null
case_ 47 --size S
expect_code 0
expect_call "project item-add 3 --owner sssoto17 --url https://github.com/sssoto17/sunny-pastures/issues/47"
new="project item-edit --project-id PVT_kwHOCI1msM4BqXYM --id PVTI_new"
expect_call "$new --field-id PVTSSF_status --single-select-option-id 97a20eba"
expect_call "$new --field-id PVTSSF_size --single-select-option-id 7a7f9f73"
expect_no_call "PVTI_other"

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
after "$(item Status=Backlog Track=Infra Size=S Priority=P1 "Week=Wk 2 · 9–15 Nov")"
case_ 47 --track Infra --size S --priority P1 --week "Wk 2"
expect_code 0
expect_out "https://github.com/sssoto17/sunny-pastures/issues/47"
expect_out "Status:   Backlog"
expect_out "Track:    Infra"
expect_out "Mode:     -"
expect_out "Size:     S"
expect_out "Priority: P1"
expect_out "Week:     Wk 2 · 9–15 Nov"
assert "expected a second lookup after the writes" test "$(count '^api$')" -eq 2

# --- lookup failures stop before any write -----------------------------------------------------
reset null
fixture null | jq '.data.repository.issue = null' >"$work/fixture.json"
case_ 9999 --size S
expect_code 1
expect_err "issue #9999 not found"
expect_no_writes

reset null
fixture null | jq '.data.user.projectV2 = null' >"$work/fixture.json"
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

reset null
printf 'not json' >"$work/fixture.json"
case_ 47 --size S
expect_code 1
expect_no_writes

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

# --- called from zsh ---------------------------------------------------------------------------
# zsh doesn't split unquoted $var, which silently dropped 5 of #47's fields on 7 Nov. The script
# runs under bash whatever the caller's shell, so a zsh caller gets the same calls.
if command -v zsh >/dev/null; then
  reset "$(item Status=Backlog)"
  args=(zsh -c "...")
  out=$(PATH="$work/bin:$PATH" zsh -fc '"$1" 47 --size M --week "Wk 2"' zsh "$script" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
  expect_code 0
  expect_call "$edit --field-id PVTSSF_size --single-select-option-id e0e2efb6"
  expect_call "$edit --field-id PVTIF_week --iteration-id 7f9c9b7a"
else
  echo "skip: zsh not installed, the zsh caller case did not run"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

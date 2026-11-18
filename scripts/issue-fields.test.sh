#!/usr/bin/env bash
# Tests for issue-fields.sh through its command line, with `gh` replaced by the REST fake
# (scripts/lib/gh-rest-fake.sh) on PATH. It never reaches GitHub, refuses anything but `gh api`,
# and runs the script's --jq filters through jq over JSON shaped like GitHub's REST answers (the
# examples in GitHub's REST description for issues, issue types, project fields and items). A
# hook applies each write (add item, item update, type, label removal) to that JSON, so the
# read-back sees what was written.
# Run: bash scripts/issue-fields.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/issue-fields.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/issue-fields-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cp "$here/lib/gh-rest-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
st=$work/gh
R=repos/sssoto17/sunny-pastures
PA=users/sssoto17/projectsV2/3

# --- fixtures ---------------------------------------------------------------------------------
# The Project's fields as REST lists them (option ids copied from the live Project on 7 Nov; field
# ids are made up): one line per field: name, id, kind, then id=name options.
fields_json() {
  local name id kind rest
  while read -r name id kind rest; do
    IFS=, read -ra opts <<<"$rest"
    printf '%s\n' "${opts[@]}" | jq -R --arg n "$name" --argjson id "$id" --arg k "$kind" \
      '{id: (split("=")[0]), name: (split("=")[1:] | join("="))}' | jq -s --arg n "$name" \
      --argjson id "$id" --arg k "$kind" '
        if $k == "single_select" then
          {id: $id, name: $n, data_type: $k,
           options: map({id, name: {raw: .name, html: .name}, color: "GRAY"})}
        else
          {id: $id, name: $n, data_type: $k,
           configuration: {duration: 7, start_day: 1,
             iterations: map({id, title: {raw: .name, html: .name}, start_date: "2026-11-09", duration: 7})}}
        end'
  done <<'ROWS' | jq -s '[{id: 100, name: "Title", data_type: "title"}] + .'
Status 101 single_select 97a20eba=Backlog,eb23e874=Ready,03b81b61=In progress,e763de54=In review,04fb4a2b=Done
Mode 102 single_select ca9bd7b8=Manual,f92520e5=Factory
Track 103 single_select 60e95dc9=Build,df832856=Design,d064f0c0=Report,3200c1d7=Infra,145afb58=Evaluation
Size 104 single_select 7a7f9f73=S,e0e2efb6=M,c7dede81=L
Week 105 iteration 7f9c9b7a=Wk 2 · 9–15 Nov,b40f9349=Wk 3 · 16–22 Nov,f9409a73=Wk 1 · 2–8 Nov
Priority 106 single_select 598fd74b=P0,ad39d061=P1,a38a49d8=P2,cad16246=P3
ROWS
}
types_json() {
  jq -n '[{id: 1, name: "Chore", is_enabled: true}, {id: 2, name: "Bug", is_enabled: true},
    {id: 3, name: "Feature", is_enabled: true}, {id: 4, name: "Design", is_enabled: true},
    {id: 5, name: "Epic", is_enabled: false}]'
}
issue_json() { # type-or-empty labels... -> issue 47
  local type=$1
  shift
  printf '%s\n' "$@" | jq -R . | jq -s --arg t "$type" '{number: 47, id: 4747,
    html_url: "https://github.com/sssoto17/sunny-pastures/issues/47", title: "A thing",
    type: (if $t == "" then null else {id: 1, name: $t} end),
    labels: map(select(. != "") | {name: .})}'
}
# The value object a field holds for the option of that name, as REST returns it.
value_of() { # field name option-name -> JSON value
  jq --arg f "$1" --arg o "$2" '.[] | select(.name == $f) |
    if .data_type == "single_select" then
      (.options[] | select(.name.raw == $o) | {id, name, color})
    else
      (.configuration.iterations[] | select(.title.raw == $o))
    end' "$st/get/$PA/fields"
}
# The items: another issue's (#12), then #47's with "Field=Value" pairs; "null" means #47 isn't
# on the Project. The Type field of an item mirrors the issue's type; it's set from the issue.
items_json() { # null | pairs...
  local pair item='[]'
  if [[ ${1-} != null ]]; then
    item=$(jq -n '[{id: 900, name: "Title", data_type: "title", value: {raw: "A thing", number: 47}}]')
    for pair in "$@"; do
      item=$(jq --arg n "${pair%%=*}" --argjson v "$(value_of "${pair%%=*}" "${pair#*=}")" \
        '. + [{id: 0, name: $n, data_type: "x", value: $v}]' <<<"$item")
    done
    item=$(jq '[{id: 4701, node_id: "PVTI_existing", content_type: "Issue",
      content: {id: 4747, number: 47}, fields: .}]' <<<"$item")
  fi
  jq -n --argjson mine "$item" '[{id: 1201, content_type: "Issue", content: {id: 1212, number: 12},
    fields: [{id: 101, name: "Status", data_type: "single_select",
      value: {id: "eb23e874", name: {raw: "Ready", html: "Ready"}}}]}] + $mine'
}

# The writes, applied to the JSON above. Each one's fail_/drop- switch is noted.
cat >"$work/hook" <<'HOOK'
items=$st/get/users/sssoto17/projectsV2/3/items
issue=$st/get/repos/sssoto17/sunny-pastures/issues/47
fieldsf=$st/get/users/sssoto17/projectsV2/3/fields
case "$method $path" in
  "POST users/sssoto17/projectsV2/3/items") # add item
    [[ $(jq -r '.type, .id' <<<"$input" | paste -sd' ') == "Issue 4747" ]] ||
      { echo "fake: bad add-item body $input" >&2; exit 1; }
    jq '. + [{id: 4799, content_type: "Issue", content: {id: 4747, number: 47}, fields: []}]' \
      "$items" >"$items.new" && mv "$items.new" "$items"
    out='{"id": 4799, "node_id": "PVTI_new", "content_type": "Issue"}' ;;
  "PATCH users/sssoto17/projectsV2/3/items/"*) # update item; drop-edit: accepted, not stored
    id=${path##*/}
    [[ -f $st/drop-edit ]] || {
      jq --argjson id "$id" --argjson body "$input" --slurpfile f "$fieldsf" '
        ($f[0]) as $fs
        | map(if .id != $id then . else
            reduce $body.fields[] as $u (.;
              ($fs[] | select(.id == $u.id)) as $fd
              | ($fd.options // $fd.configuration.iterations | .[] | select(.id == $u.value)
                 | del(.color, .description)) as $v
              | .fields = ([.fields[] | select(.name != $fd.name)] + [{id: $fd.id, name: $fd.name,
                  data_type: $fd.data_type, value: $v}]))
          end)' "$items" >"$items.new" && mv "$items.new" "$items"
    }
    out='{}' ;;
  "PATCH repos/sssoto17/sunny-pastures/issues/47") # set type
    jq --arg t "$(jq -r .type <<<"$input")" '.type = {id: 1, name: $t}' "$issue" >"$issue.new" &&
      mv "$issue.new" "$issue"
    out='{}' ;;
  "DELETE repos/sssoto17/sunny-pastures/issues/47/labels/triage") # drop-remove: kept
    [[ -f $st/drop-remove ]] ||
      { jq '.labels |= map(select(.name != "triage"))' "$issue" >"$issue.new" && mv "$issue.new" "$issue"; }
    out='[]' ;;
  *) return 1 ;;
esac
HOOK

reset() { # null | "Field=Value"... [-- type labels...] -> a fresh state
  local pairs=() type="" labels=()
  while (($#)) && [[ $1 != -- ]]; do pairs+=("$1"); shift; done
  if [[ ${1-} == -- ]]; then shift; type=${1-}; shift; labels=("$@"); fi
  rm -rf "$st"
  mkdir -p "$st/get/$R/issues" "$st/get/$PA"
  cp "$work/hook" "$st/hook"
  fields_json >"$st/get/$PA/fields"
  types_json >"$st/get/$R/issue-types"
  issue_json "$type" "${labels[@]}" >"$st/get/$R/issues/47"
  # Type pairs describe the issue's type, not an item field.
  local item_pairs=() p
  for p in "${pairs[@]}"; do
    if [[ $p == Type=* ]]; then type=${p#Type=}; else item_pairs+=("$p"); fi
  done
  issue_json "$type" "${labels[@]}" >"$st/get/$R/issues/47"
  if [[ ${pairs[0]-} == null ]]; then items_json null; else items_json "${item_pairs[@]}"; fi \
    >"$st/get/$PA/items"
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
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls:\n%s\n' \
    "$1" "${args[*]}" "$code" "$out" "$err" "    $(call_lines | sed 's/^/    /')"
}
assert() { # message command... -> ok if the command succeeds
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
# The gh calls joined into one line each: "api -X PATCH users/... --input - --silent".
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
count() { call_lines | grep -c -- "$1"; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
expect_no_gh() { assert "expected no gh calls at all" test -z "$calls"; }
# A write is any call with -X POST, PATCH or DELETE.
expect_no_writes() {
  if call_lines | grep -qE -- '-X (POST|PATCH|DELETE)'; then bad "expected no writes"; else ok; fi
}
expect_call() { # substring of one joined call line
  if call_lines | grep -qF -- "$1"; then ok; else bad "expected a gh call containing: $1"; fi
}
expect_no_call() {
  if call_lines | grep -qF -- "$1"; then bad "expected no gh call containing: $1"; else ok; fi
}
expect_item() { # Field=option-id ... -> the item now holds exactly these values for those fields
  local pair got
  for pair in "$@"; do
    got=$(jq -r --arg n "${pair%%=*}" '.[] | select(.content.number == 47) | .fields[] |
      select(.name == $n) | .value.id' "$st/get/$PA/items")
    assert "expected ${pair%%=*} to hold option ${pair#*=}, got ${got:-none}" test "$got" == "${pair#*=}"
  done
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
reset Status=Backlog
case_ "#47" --size S
expect_code 0
expect_call "api $R/issues/47 --jq"

# --- REST only ----------------------------------------------------------------------------------
# Every call is `gh api` on a REST path: the fake refuses anything else, and nothing is graphql.
reset null
case_ 47 --type Chore --track Infra --size S --priority P1 --week "Wk 2"
expect_code 0
expect_no_call "graphql"
assert "expected every call to be gh api" test "$(call_lines | grep -vc '^api ')" -eq 0

# --- names in, ids out ------------------------------------------------------------------------
# All the Project's fields go in one item update, by field id and option id.
reset Status=Backlog
case_ 47 --priority P1
expect_code 0
expect_call "api -X PATCH $PA/items/4701 --input - --silent"
expect_item Priority=ad39d061
expect_no_call "-X POST $PA/items"
assert "expected one item update" test "$(count "PATCH $PA/items")" -eq 1

reset Status=Backlog
case_ 47 --track Infra --mode Manual --size M --week "Wk 2"
expect_code 0
expect_item Track=3200c1d7 Mode=ca9bd7b8 Size=e0e2efb6 Week=7f9c9b7a
assert "expected one item update" test "$(count "PATCH $PA/items")" -eq 1

# The full iteration title works too, a completed week is still a valid name, and names ignore case.
reset Status=Backlog
case_ 47 --week "Wk 1 · 2–8 Nov" --track infra
expect_code 0
expect_item Week=f9409a73 Track=3200c1d7

# --flag=value, and a value with a space survives (the zsh/bash word-splitting bug of 7 Nov).
reset Status=Backlog
case_ 47 --size=S "--week=Wk 3"
expect_code 0
expect_item Size=7a7f9f73 Week=b40f9349

# The item is read for the field ids the Project has, not only the title (REST "List items":
# without fields[], only the title comes back).
reset Status=Backlog
case_ 47 --size S
expect_call "$PA/items?per_page=100&fields=101,102,103,104,105,106"

# --- adding to the Project, and Status --------------------------------------------------------
# Not on the Project yet: add it by the issue's id, then set Backlog and the fields.
reset null
case_ 47 --size S
expect_code 0
expect_call "api -X POST $PA/items -f type=Issue -F id=4747 --jq .id"
expect_call "api -X PATCH $PA/items/4799"
expect_item Status=97a20eba Size=7a7f9f73

# On the Project with no Status (added by hand): Backlog.
reset Size=S
case_ 47 --size M
expect_code 0
expect_item Status=97a20eba Size=e0e2efb6

# On the Project with a Status: left alone, so fixing a field never undoes the admin's Ready.
reset Status=Ready
case_ 47 --size M
expect_code 0
expect_item Status=eb23e874 Size=e0e2efb6

# --status sets any status but Ready.
reset Status=Backlog
case_ 47 --status "In progress"
expect_code 0
expect_item Status=03b81b61

for ready in Ready ready "--status=Ready"; do
  reset Status=Backlog
  if [[ $ready == --* ]]; then case_ 47 "$ready"; else case_ 47 --size S --status "$ready"; fi
  expect_code 2
  expect_err "only the admin moves an issue to Ready"
  expect_no_gh
done

# If adding to the Project fails, stop before any update.
reset null
echo "gh: Validation Failed (HTTP 422)" >"$st/fail_POST_users_sssoto17_projectsV2_3_items"
case_ 47 --size S
expect_code 1
expect_err "could not add https://github.com/sssoto17/sunny-pastures/issues/47 to the Project; nothing was set"
expect_no_call "-X PATCH"

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
assert "expected a second read of the item after the writes" test "$(count "$PA/items?")" -eq 2

# --- lookup failures stop before any write -----------------------------------------------------
reset null
case_ 9999 --size S
expect_code 1
expect_err "could not read issue #9999"
expect_err "nothing was changed"
expect_no_writes

reset Status=Backlog
echo "gh: Not Found (HTTP 404)" >"$st/fail_GET_users_sssoto17_projectsV2_3_fields"
case_ 47 --size S
expect_code 1
expect_err "could not read Project 3 of sssoto17 from GitHub; nothing was changed"
expect_no_writes

# An update that fails stops the run and names what was and wasn't set.
reset Status=Backlog
echo "gh: Validation Failed (HTTP 422)" >"$st/fail_PATCH_users_sssoto17_projectsV2_3_items_4701"
case_ 47 --type Chore --size S --priority P1
expect_code 1
expect_err "could not set Size, Priority. set: Type; not set: Size, Priority"

# --- read-back failures after the writes -------------------------------------------------------
# The writes went through but the second read failed: don't claim nothing changed.
reset Status=Backlog
echo "gh: Server Error (HTTP 502)" >"$st/fail_GET_repos_sssoto17_sunny-pastures_issues_47.2"
case_ 47 --size S
expect_code 1
expect_err "fields were written but couldn't be read back; re-run to check"
assert 'expected no "nothing was changed" after writes' test "${err/nothing was changed/}" == "$err"

# The update "succeeded" but the read-back doesn't show it: fail and name the field.
reset Status=Backlog Size=M
touch "$st/drop-edit"
case_ 47 --size S --priority P1
expect_code 1
expect_out "Size:     M"
expect_err "Size is M, expected S"
expect_err "Priority is -, expected P1"
expect_err "re-run to check"

# --- admin-only values ---------------------------------------------------------------------------
for factory in Factory factory "--mode=Factory"; do
  reset Status=Backlog
  if [[ $factory == --* ]]; then case_ 47 "$factory"; else case_ 47 --size S --mode "$factory"; fi
  expect_code 2
  expect_err "only the admin sets Mode to Factory"
  expect_no_gh
done

# The valid-names lists don't offer what the script refuses.
reset Status=Backlog
case_ 47 --status Blocked
expect_code 2
expect_err "Valid names: Backlog, In progress, In review, Done."
reset Status=Backlog
case_ 47 --mode Robot
expect_code 2
expect_err "Valid names: Manual."

# --- unknown names fail loudly and change nothing ---------------------------------------------
reset Status=Backlog
case_ 47 --size M --priority P9
expect_code 2
expect_err 'unknown Priority "P9"'
expect_err "P0, P1, P2, P3"
expect_no_writes

reset Status=Backlog
case_ 47 --week "Wk 99"
expect_code 2
expect_err "Wk 2, Wk 3, Wk 1"
expect_no_writes

# An empty value is an unknown name, not a skipped field.
reset Status=Backlog
case_ 47 --track ""
expect_code 2
expect_err 'unknown Track ""'
expect_no_writes

# --- the native issue type ---------------------------------------------------------------------
# Set on the issue by name (REST "Update an issue", type), never on the item.
reset Status=Backlog
case_ 47 --type Chore
expect_code 0
expect_call "api -X PATCH $R/issues/47 -f type=Chore --silent"
expect_no_call "PATCH $PA/items"
expect_out "Type:     Chore"

# Names ignore case, like the Project fields; GitHub gets the type's own spelling.
reset Status=Backlog Type=Chore
case_ 47 --type bug
expect_code 0
expect_call "-f type=Bug"
expect_out "Type:     Bug"

# Design, the type a `design` issue maps to (#266).
reset Status=Backlog Type=Chore
case_ 47 --type Design
expect_code 0
expect_out "Type:     Design"

# An unknown or disabled type fails with the enabled names and writes nothing.
reset Status=Backlog
case_ 47 --type Epic --size S
expect_code 2
expect_err 'unknown Type "Epic". Valid names: Chore, Bug, Feature, Design.'
expect_no_writes

reset Status=Backlog
echo "gh: Validation Failed (HTTP 422)" >"$st/fail_PATCH_repos_sssoto17_sunny-pastures_issues_47"
case_ 47 --type Chore --size S
expect_code 1
expect_err "could not set Type"
expect_err "not set: Type, Size"

# --- triage comes off once type, Priority, Size and Week are all set ----------------------------
four=(Type=Chore Priority=P2 Size=S "Week=Wk 2 · 9–15 Nov")

# Set by this run.
reset Status=Backlog -- "" triage chore
case_ 47 --type Chore --size S --priority P2 --week "Wk 2"
expect_code 0
expect_call "api -X DELETE $R/issues/47/labels/triage --silent"
expect_out "Triage:   removed (type, Priority, Size and Week are set)"
assert "expected a third read after removing triage" test "$(count "api $R/issues/47 --jq")" -eq 3

# Already set (the admin set them in the UI): a run with no flags removes it.
reset Status=Backlog "${four[@]}" -- "" triage
case_ 47
expect_code 0
expect_call "labels/triage"
expect_out "Triage:   removed"

# Each one missing keeps triage, and the line names it.
for drop in Type Priority Size Week; do
  pairs=()
  for pair in "${four[@]}"; do [[ ${pair%%=*} == "$drop" ]] || pairs+=("$pair"); done
  reset Status=Backlog "${pairs[@]}" -- "" triage
  case_ 47 --track Build
  expect_code 0
  expect_no_call "labels/triage"
  expect_out "Triage:   yes (missing: $drop)"
done

# No triage label: nothing to remove; a missing field is still named.
reset Status=Backlog "${four[@]}"
case_ 47
expect_code 0
expect_no_call "-X DELETE"
expect_out "Triage:   -"
reset Status=Backlog Size=S
case_ 47
expect_code 0
expect_out "Triage:   - (missing: Type, Priority, Week)"

# The removal fails: say the fields are set and print the command that finishes it.
reset Status=Backlog "${four[@]}" -- "" triage
echo "gh: Server Error (HTTP 500)" >"$st/fail_DELETE_repos_sssoto17_sunny-pastures_issues_47_labels_triage"
case_ 47
expect_code 1
expect_err "the fields are set, but \`triage\` couldn't be removed"
expect_err "gh api -X DELETE repos/sssoto17/sunny-pastures/issues/47/labels/triage"

# The removal "succeeds" but the read-back still shows triage.
reset Status=Backlog "${four[@]}" -- "" triage
touch "$st/drop-remove"
case_ 47
expect_code 1
expect_out "Triage:   yes"
expect_err "triage is still on, though all four are set"

# --- the Project refused (the cloud proxy, #346) -----------------------------------------------
# The issue's part runs; the Project's is skipped with exit 4, the reason, and the command that
# finishes it. Nothing on the Project is written, and triage is left alone.
reset Status=Backlog -- "" triage
touch "$st/refuse_projects"
case_ 47 --type chore --size S --week "Wk 2"
expect_code 4
expect_call "api -X PATCH $R/issues/47 -f type=Chore --silent"
expect_no_call "-X POST $PA"
expect_no_call "-X PATCH $PA"
expect_no_call "-X DELETE"
expect_err "(HTTP 403)"
expect_err "skipped the Project step: GitHub refused the Project here"
expect_err "the type is set"
expect_err "Skipped: add #47 to Project 3 if it isn't on it, set Status if unset, set Size, Week, and remove \`triage\` once the four are set."
expect_err "Finish from a local session, or the admin runs: scripts/issue-fields.sh 47 --type chore --size S --week Wk\\ 2"
expect_out "Type:     Chore"
expect_out "Size:     ?"
expect_out "Triage:   ? (the Project couldn't be read)"

# A bad type is still caught before anything is written, with the Project refused.
reset Status=Backlog
touch "$st/refuse_projects"
case_ 47 --type Epic --size S
expect_code 2
expect_no_writes

# No type asked for: nothing is written at all, and it still says what's left.
reset Status=Backlog
touch "$st/refuse_projects"
case_ 47 --size S
expect_code 4
expect_no_writes
expect_err "Skipped: add #47 to Project 3"

# --- called from zsh ---------------------------------------------------------------------------
# zsh doesn't split unquoted $var, which silently dropped 5 of #47's fields on 7 Nov. The script
# runs under bash whatever the caller's shell, so a zsh caller gets the same calls.
# A missing zsh is a failure, not a skip (CONSTRAINTS.md, "Guarding the bar").
args=(zsh -c "...")
if ! command -v zsh >/dev/null; then
  code="" out="" err="" calls=""
  bad "zsh is not installed: install it to run the zsh caller case"
else
  reset Status=Backlog
  out=$(PATH="$work/bin:$PATH" zsh -fc '"$1" 47 --size M --week "Wk 2"' zsh "$script" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$st/calls" 2>/dev/null || true)
  expect_code 0
  expect_item Size=e0e2efb6 Week=7f9c9b7a
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

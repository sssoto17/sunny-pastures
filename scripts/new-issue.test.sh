#!/usr/bin/env bash
# Tests for new-issue.sh through its command line. The script runs from a copy in a temp folder,
# beside a fake issue-fields.sh, with `gh` replaced by the REST fake (scripts/lib/gh-rest-fake.sh)
# on PATH. Neither reaches GitHub. The fake refuses anything but `gh api` and runs the script's
# --jq filters through jq over JSON shaped like GitHub's REST answers (labels, issue types,
# milestones, issues), so the filters are tested too.
# Run: bash scripts/new-issue.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/new-issue-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/scripts/lib"
cp "$here/new-issue.sh" "$work/scripts/new-issue.sh"
cp "$here/lib/issue-types.sh" "$work/scripts/lib/issue-types.sh"
cp "$here/lib/gh-rest-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
script="$work/scripts/new-issue.sh"
st=$work/gh
R=repos/sssoto17/sunny-pastures

# --- fakes ------------------------------------------------------------------------------------
# gh: the REST fake, state in $st. Reads are files under $st/get/; the hook answers the two
# writes: POST .../issues (keeps the body in $st/created, answers #200, id 20000) and POST
# .../issues/<parent>/sub_issues (keeps the body in $st/linked).
cat >"$work/hook" <<'HOOK'
case "$method $path" in
  "POST repos/sssoto17/sunny-pastures/issues")
    printf '%s\n' "$input" >"$st/created"
    out='{"number": 200, "id": 20000, "html_url": "https://github.com/sssoto17/sunny-pastures/issues/200"}' ;;
  "POST repos/sssoto17/sunny-pastures/issues/200/labels")
    printf '%s\n' "$(jq -c . <<<"$input")" >"$st/labelled"
    out='[]' ;;
  "POST repos/sssoto17/sunny-pastures/issues/"*/sub_issues)
    printf '%s %s\n' "${path#repos/sssoto17/sunny-pastures/issues/}" "$(jq -c . <<<"$input")" >"$st/linked"
    out='{}' ;;
  *) return 1 ;;
esac
HOOK

# issue-fields.sh: logs its arguments on one line to $work/fields-calls and prints what the real
# one prints; exits with the code in $work/fail-fields if that file exists (4: the Project step
# skipped, as in the cloud).
cat >"$work/scripts/issue-fields.sh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/fields-calls"
if [[ -f $dir/fail-fields ]]; then
  code=$(cat "$dir/fail-fields")
  if ((code == 4)); then
    printf 'https://github.com/sssoto17/sunny-pastures/issues/%s\nType:     Chore\nStatus:   ?\n' "$1"
    echo "issue-fields: skipped the Project step: GitHub refused the Project here (HTTP 403, above)" >&2
  else
    echo "issue-fields: unknown Size \"XL\". Valid names: S, M, L. Nothing was changed." >&2
  fi
  exit "$code"
fi
printf 'https://github.com/sssoto17/sunny-pastures/issues/%s\nStatus:   Backlog\n' "$1"
FAKE
chmod +x "$work/scripts/issue-fields.sh"

json_list() { printf '%s\n' "$@" | jq -R . | jq -sc "${JQ:-.}"; }
labels() { JQ='map({name: .})' json_list "$@" >"$st/get/$R/labels"; }
types() { JQ='map({name: ., is_enabled: true}) + [{name: "Epic", is_enabled: false}]' json_list "$@" \
  >"$st/get/$R/issue-types"; }
readback() { # labels milestone parent type -> the new issue as REST returns it ("-" for none)
  jq -n --arg l "$1" --arg m "$2" --arg p "$3" --arg t "$4" '{number: 200, id: 20000,
    labels: ($l | split(",") | map({name: .})),
    milestone: (if $m == "-" then null else {title: $m} end),
    type: (if $t == "-" then null else {name: $t} end)}
    + (if $p == "-" then {} else {parent_issue_url: "https://api.github.com/repos/sssoto17/sunny-pastures/issues/\($p)"} end)' \
    >"$st/get/$R/issues/200"
}
reset() {
  rm -rf "$st" "$work"/fields-calls "$work"/fail-*
  mkdir -p "$st/get/$R/issues"
  cp "$work/hook" "$st/hook"
  labels bug feature chore spike design idea area:sim area:tools area:docs review:admin triage \
    factory:ready blocked:admin blocked:decision
  types Chore Bug Feature Design
  jq -n '[{number: 2, title: "M2 Sim properties + factory"}, {number: 5, title: "M3 Game API"}]' \
    >"$st/get/$R/milestones"
  echo '{"number": 73, "state": "open"}' >"$st/get/$R/issues/73"
  echo '{"number": 40, "state": "closed"}' >"$st/get/$R/issues/40"
  echo '{"number": 151, "state": "open", "pull_request": {}}' >"$st/get/$R/issues/151"
  # The read-back of the new issue: labels, milestone, parent number, native type.
  readback chore,area:tools "M2 Sim properties + factory" 73 Chore
  printf 'Some body.\n' >"$work/body.md"
  : >"$work/empty.md"
}

run() { # args... -> sets code, out, err, calls, fields
  out=$(cd "$work" && PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$st/calls" 2>/dev/null || true)
  fields=$(cat "$work/fields-calls" 2>/dev/null || true)
}
created() { jq -c "$1" "$st/created" 2>/dev/null; } # jq filter over the create's body

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
# A write is a gh call with -X POST, or an issue-fields run.
expect_no_writes() {
  if grep -qx POST <<<"$calls" || [[ -n $fields ]]; then bad "expected no writes"; else ok; fi
}
expect_created() { # jq filter expected -> the create's body, through the filter
  assert "expected the create's $1 to be $2, got $(created "$1")" test "$(created "$1")" == "$2"
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
# Priority, Size and Week: with the type, the four every issue carries.
three=(--priority P2 --size S --week "Wk 2")

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
# factory:ready is the admin's to add (docs/agents/triage-labels.md; #621), in any
# case and either flag form.
for flag in "--label factory:ready" "--label=factory:ready" "--label Factory:Ready" \
  "--label blocked:admin --label factory:ready"; do
  reset
  read -ra words <<<"$flag"
  case_ "${base[@]}" "${words[@]}"
  expect_code 2
  expect_err "only the admin adds factory:ready"
  expect_no_gh
done

# Mode and Track are gone (#621): --mode and --track are refused by name, whatever the value.
for gone in "--mode Factory" "--mode Manual" "--mode=Manual" "--track Infra" "--track=Build"; do
  reset
  read -ra words <<<"$gone"
  case_ "${base[@]}" "${words[@]}"
  expect_code 2
  flag=${words[0]%%=*}
  expect_err "$flag is gone: the Project's Mode and Track fields were dropped (#621)"
  expect_no_gh
done

# --label adds a label beyond the type and area (a blocked:* one, say). The labels other flags
# or rules own are refused before any gh call: the type, the area and triage.
for owned in chore Area:tools triage; do
  reset
  case_ "${base[@]}" --label "$owned"
  expect_code 2
  expect_no_gh
done
reset
case_ "${base[@]}" --label chore
expect_err "--label chore: the type label is set with --type"
case_ "${base[@]}" --label area:docs
expect_err "--label area:docs: the area label is set with --area"
case_ "${base[@]}" --label triage
expect_err "--label triage: new-issue.sh adds triage itself"
case_ "${base[@]}" --label ""
expect_err "--label is empty"
expect_no_gh
case_ "${base[@]}" --label blocked:admin --label blocked:admin
expect_err "--label blocked:admin given twice"
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
echo "gh: Server Error (HTTP 502)" >"$st/fail_GET_${R//\//_}_labels"
case_ "${base[@]}"
expect_code 3
expect_err "could not read"
expect_no_writes

# --- the write path ---------------------------------------------------------------------------
# REST only: one create with labels, milestone number and type, then the sub-issue link by the
# new issue's id. The fake refuses any gh subcommand but api, and nothing calls graphql.
reset
case_ "${base[@]}" --size S --priority P1 --week "Wk 2"
expect_code 0
expect_call "api -X POST $R/issues -f title=Add a thing -F body=@body.md"
expect_created '[.title, .body, .labels, .milestone, .type]' \
  '["Add a thing","Some body.\n",["chore","area:tools"],2,"Chore"]'
expect_call "api -X POST $R/issues/73/sub_issues -F sub_issue_id=20000 --silent"
assert "the link carries the new issue's id" test "$(cat "$st/linked")" == '73/sub_issues {"sub_issue_id":20000}'
expect_no_call "graphql"
assert "expected every call to be gh api" test "$(call_lines | grep -vc '^api ')" -eq 0
assert "issue-fields gets the new number, the native type and the fields" test "$fields" = "200 --type Chore --size S --priority P1 --week Wk 2"
assert "no warning when all four are set" test -z "$err"
expect_out "https://github.com/sssoto17/sunny-pastures/issues/200"
expect_out "Status:   Backlog"
expect_out "Labels:   chore, area:tools"
expect_out "Milestone: M2 Sim properties + factory"
expect_out "Parent:   #73"

# --label: each one is checked against the repo's labels, goes into the create beside the type and
# area, and must be on the issue at read-back. issue-fields.sh never sees it.
reset
readback chore,area:tools,blocked:admin,blocked:decision "M2 Sim properties + factory" 73 Chore
case_ "${base[@]}" "${three[@]}" --label blocked:admin --label=blocked:decision
expect_code 0
expect_created .labels '["chore","area:tools","blocked:admin","blocked:decision"]'
assert "issue-fields gets no label" test "$fields" = "200 --type Chore --priority P2 --size S --week Wk 2"
expect_out "Labels:   chore, area:tools, blocked:admin, blocked:decision"

# Labels match without case, as on GitHub: the create carries the repo's spelling.
reset
readback chore,area:tools,blocked:admin "M2 Sim properties + factory" 73 Chore
case_ "${base[@]}" "${three[@]}" --label Blocked:Admin
expect_code 0
expect_created .labels '["chore","area:tools","blocked:admin"]'

reset
case_ "${base[@]}" "${three[@]}" --label blocked:nope
expect_code 2
expect_err 'unknown label "blocked:nope"'
expect_err "Nothing was created."
expect_no_writes

reset
case_ "${base[@]}" "${three[@]}" --label blocked:admin
expect_code 1
expect_err "missing label blocked:admin"

# Forms the coordinator types: "area:tools", "#73", --flag=value.
reset
case_ --title="Add a thing" --type=chore --area=area:tools \
  --milestone="M2 Sim properties + factory" --body-file=body.md --parent="#73" \
  --priority=P2 --size=S "--week=Wk 2"
expect_code 0
expect_created '[.labels, .milestone]' '[["chore","area:tools"],2]'
expect_call "$R/issues/73/sub_issues"
assert "issue-fields gets the type and the three fields" test "$fields" = "200 --type Chore --priority P2 --size S --week Wk 2"

# An idea has no parent: no sub-issue link, and none expected on read-back. The milestone goes
# by its own number.
reset
readback idea,area:tools "M3 Game API" - Chore
case_ --title x --type idea --area tools --milestone "M3 Game API" --body-file body.md "${three[@]}"
expect_code 0
expect_no_call "sub_issues"
expect_created .milestone 5
expect_out "Parent:   -"

# The link under the parent fails: the issue exists, so say so and print both commands that
# finish it; issue-fields isn't run.
reset
echo "gh: Validation Failed (HTTP 422)" >"$st/fail_POST_${R//\//_}_issues_73_sub_issues"
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "#200 was created (https://github.com/sssoto17/sunny-pastures/issues/200), but not linked under #73"
expect_err "gh api -X POST repos/sssoto17/sunny-pastures/issues/73/sub_issues -F sub_issue_id=20000"
expect_err "scripts/issue-fields.sh 200 --type Chore --priority P2 --size S --week Wk\\ 2"
assert "issue-fields isn't run" test -z "$fields"

# --- the Project refused (the cloud proxy, #346) -------------------------------------------------
# issue-fields.sh skips the Project step (exit 4): the issue is filed, gets `triage` (its
# Priority, Size and Week aren't on the Project yet), is read back, and this exits 4 too, after
# saying what is done. Without triage the issue showed in no triage search (#359, 18 Nov).
reset
echo 4 >"$work/fail-fields"
readback chore,area:tools,triage "M2 Sim properties + factory" 73 Chore
case_ "${base[@]}" "${three[@]}"
expect_code 4
expect_out "Status:   ?"
expect_out "Parent:   #73"
expect_call "api -X POST $R/issues/200/labels -f labels[]=triage --silent"
assert "triage is added by name" test "$(cat "$st/labelled" 2>/dev/null)" == '{"labels":["triage"]}'
expect_err "skipped the Project step"
expect_err "#200 is filed with its labels, milestone, type and parent, and carries \`triage\` until its Project step runs"
expect_no_call "graphql"

# A field left out already put triage on at create: no second label call.
reset
echo 4 >"$work/fail-fields"
readback chore,area:tools,triage "M2 Sim properties + factory" 73 Chore
case_ "${base[@]}" --size S
expect_code 4
expect_created .labels '["chore","area:tools","triage"]'
expect_no_call "/issues/200/labels"

# The read-back must show triage after a skipped Project step.
reset
echo 4 >"$work/fail-fields"
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "missing label triage"

# Adding triage fails: the issue exists, so say so and print the command that finishes it.
reset
echo 4 >"$work/fail-fields"
echo "gh: Server Error (HTTP 502)" >"$st/fail_POST_${R//\//_}_issues_200_labels"
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "#200 was created (https://github.com/sssoto17/sunny-pastures/issues/200) and its Project step skipped, but \`triage\` couldn't be added"
expect_err "gh api -X POST repos/sssoto17/sunny-pastures/issues/200/labels -f 'labels[]=triage'"

# --- the native issue type ----------------------------------------------------------------------
# Each type label maps to a native type (triage-labels.md, Types), passed to issue-fields.sh and
# read back.
for pair in feature=Feature bug=Bug design=Design spike=Chore chore=Chore idea=Chore; do
  reset
  label=${pair%%=*} native=${pair#*=}
  parent_args=(--parent 73) want_parent=73
  [[ $label == idea ]] && parent_args=() want_parent=-
  readback "$label,area:tools" "M3 Game API" "$want_parent" "$native"
  case_ --title x --type "$label" --area tools --milestone "M3 Game API" --body-file body.md \
    "${parent_args[@]}" "${three[@]}"
  expect_code 0
  assert "$label: issue-fields gets --type $native" test "$fields" = "200 --type $native --priority P2 --size S --week Wk 2"
done

# NATIVE_TYPES lists exactly the types native_type maps the labels to, so the check compares the
# repo with the mapping itself.
mapped=$(bash -c '. "$1"; for l in "${TYPE_LABELS[@]}"; do native_type "$l"; done | sort -u' _ "$here/lib/issue-types.sh")
listed=$(bash -c '. "$1"; printf "%s\n" "${NATIVE_TYPES[@]}" | sort' _ "$here/lib/issue-types.sh")
# bad() prints the last run's args, code and output; this check runs nothing, so clear them.
args=("lib") code="" out="" err="" calls=""
assert "NATIVE_TYPES ($listed) is the set native_type maps to ($mapped)" test "$mapped" = "$listed"

# The repo's types and the mapping must agree before anything is created, whatever --type is,
# so a rename of the repo's types is caught on the next filing (#266).
reset
types Task Bug Feature Design
case_ "${base[@]/chore/feature}" "${three[@]}"
expect_code 2
expect_err "the repo's issue types (Task, Bug, Feature, Design) and the mapping in scripts/lib/issue-types.sh (Feature, Bug, Design, Chore) disagree: the repo offers no Chore; nothing maps to Task;"
expect_err "Nothing was created."
expect_no_writes

# A type the repo adds that nothing maps to is a disagreement too.
reset
jq -n '[{name: "Chore"}, {name: "Bug"}, {name: "Feature"}, {name: "Design"}, {name: "Epic"}]
  | map(. + {is_enabled: true})' >"$st/get/$R/issue-types"
case_ "${base[@]}" "${three[@]}"
expect_code 2
expect_err "disagree: nothing maps to Epic; update the mapping and docs/agents/triage-labels.md (Types)"
expect_no_writes

reset
echo "gh: Server Error (HTTP 502)" >"$st/fail_GET_${R//\//_}_issue-types"
case_ "${base[@]}" "${three[@]}"
expect_code 3
expect_err "could not read the repo's issue types; nothing was created"
expect_no_writes

# The read-back must show the type.
reset
readback chore,area:tools "M2 Sim properties + factory" 73 -
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "issue type is -, expected Chore"
reset
readback chore,area:tools "M2 Sim properties + factory" 73 Bug
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "issue type is Bug, expected Chore"

# --- triage while Priority, Size or Week is missing ---------------------------------------------
# Each one left out adds triage at create, and a warning names it and the command to finish.
for drop in priority size week; do
  reset
  a=()
  for ((i = 0; i < ${#three[@]}; i += 2)); do
    [[ ${three[i]} == "--$drop" ]] || a+=("${three[i]}" "${three[i + 1]}")
  done
  readback chore,area:tools,triage "M2 Sim properties + factory" 73 Chore
  case_ "${base[@]}" "${a[@]}"
  expect_code 0
  expect_created .labels '["chore","area:tools","triage"]'
  Drop=${drop^}
  expect_err "warning: #200 has no $Drop, so it carries \`triage\`"
  expect_err "scripts/issue-fields.sh 200 --$drop <$Drop>"
done

# All three missing: one warning names them all.
reset
readback chore,area:tools,triage "M2 Sim properties + factory" 73 Chore
case_ "${base[@]}"
expect_code 0
expect_err "#200 has no Priority, Size, Week"
expect_err "200 --priority <Priority> --size <Size> --week <Week>"

# The read-back must agree: triage on when one is missing, off when all four are set.
reset
case_ "${base[@]}" --size S
expect_code 1
expect_err "missing label triage"
reset
readback chore,area:tools,triage "M2 Sim properties + factory" 73 Chore
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "triage is on, though all four are set"

# --- failures after the first write say what exists -------------------------------------------
reset
echo "gh: Server Error (HTTP 502)" >"$st/fail_POST_${R//\//_}_issues"
case_ "${base[@]}"
expect_code 1
expect_err "creating the issue failed"
expect_err "before re-running"
assert "issue-fields isn't run" test -z "$fields"

reset
echo 2 >"$work/fail-fields"
case_ "${base[@]}" --size XL
expect_code 1
expect_err 'unknown Size "XL"'
expect_err "#200 was created"
expect_err "scripts/issue-fields.sh 200 --type Chore --size XL"

# The re-run hint quotes each value, so it pastes back as one command.
reset
echo 2 >"$work/fail-fields"
case_ "${base[@]}" --week "Wk 2"
expect_code 1
expect_err 'scripts/issue-fields.sh 200 --type Chore --week Wk\ 2'

reset
readback chore,area:tools "M2 Sim properties + factory" - Chore
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "parent is -, expected #73"

reset
readback chore "M2 Sim properties + factory" 73 Chore
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "missing label area:tools"

reset
readback chore,area:tools "M3 Actions persist end to end" 73 Chore
case_ "${base[@]}" "${three[@]}"
expect_code 1
expect_err "milestone is M3 Actions persist end to end, expected M2 Sim properties + factory"

reset
rm -f "$st/get/$R/issues/200"
case_ "${base[@]}"
expect_code 1
expect_err "couldn't be read back"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

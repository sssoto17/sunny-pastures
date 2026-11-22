#!/usr/bin/env bash
# Tests for milestone-review.sh through its command line (#517). The script runs from a copy in a
# temp folder, beside a fake new-issue.sh that logs its arguments and the body it was given, with
# `gh` replaced by the REST fake (scripts/lib/gh-rest-fake.sh) on PATH, so nothing reaches
# GitHub and the script's --jq filters run through jq over JSON shaped like GitHub's REST answers.
# Run: bash scripts/milestone-review.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/milestone-review-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/scripts/lib"
cp "$here/milestone-review.sh" "$work/scripts/milestone-review.sh"
cp "$here/lib/project-rest.sh" "$work/scripts/lib/project-rest.sh"
cp "$here/lib/gh-rest-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
script="$work/scripts/milestone-review.sh"
st=$work/gh
R=repos/sssoto17/sunny-pastures
P=users/sssoto17/projectsV2/3

# new-issue.sh: logs its arguments, one per line, to $work/filed, copies the body file to
# $work/body, and exits with the code in $work/new-issue-code if that file exists.
cat >"$work/scripts/new-issue.sh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$@" >"$dir/filed"
while (($#)); do
  [[ $1 == --body-file ]] && cp "$2" "$dir/body"
  shift
done
echo "new-issue: filed"
[[ -f $dir/new-issue-code ]] && exit "$(cat "$dir/new-issue-code")"
exit 0
FAKE
chmod +x "$work/scripts/new-issue.sh"

milestone() { # number state due_on(or null) title
  jq -n --argjson n "$1" --arg s "$2" --argjson d "$3" --arg t "$4" \
    '{number: $n, state: $s, due_on: $d, title: $t}' >"$st/get/$R/milestones/$1"
}
issues() { # JSON array: the milestone's issues, as GET repos/.../issues returns them
  printf '%s\n' "$1" >"$st/get/$R/issues"
}
reset() {
  rm -rf "$st" "$work"/filed "$work"/body "$work"/new-issue-code
  mkdir -p "$st/get/$R/milestones" "$st/get/$P"
  milestone 4 open '"2026-11-29T00:00:00Z"' "M4 Playable slice live"
  issues '[{"number": 500, "title": "Something else"}]'
  # The Project's fields as the REST Projects API lists them: a select field, and Week with two
  # current iterations and one completed one. Titles are {raw, html}, as on GitHub.
  jq -n '[
    {id: 1, name: "Size", data_type: "single_select", options: [{id: "a", name: {raw: "S", html: "S"}}]},
    {id: 2, name: "Week", data_type: "iteration", configuration: {
      iterations: [
        {id: "w4", title: {raw: "Wk 4 · 23–29 Nov", html: "Wk 4"}, start_date: "2026-11-23", duration: 7},
        {id: "w5", title: {raw: "Wk 5 · 30 Nov–6 Dec", html: "Wk 5"}, start_date: "2026-11-30", duration: 7}],
      completed_iterations: [
        {id: "w3", title: {raw: "Wk 3 · 16–22 Nov", html: "Wk 3"}, start_date: "2026-11-16", duration: 7}]}}]' \
    >"$st/get/$P/fields"
}

run() { # args... -> sets code, out, err, calls, filed, tokens
  out=$(cd "$work" && PATH="$work/bin:$PATH" GH_TOKEN=repo-token PROJECT_GH_TOKEN=project-token \
    GITHUB_ACTIONS="${ACTIONS-}" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$st/calls" 2>/dev/null || true)
  filed=$(cat "$work/filed" 2>/dev/null || true)
  tokens=$(cat "$st/tokens" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  filed:\n%s\n' \
    "$1" "${args[*]}" "$code" "$out" "$err" "    ${filed//$'\n'/$'\n'    }"
}
assert() { # message command...
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
expect_no_gh() { assert "expected no gh calls at all" test -z "$calls"; }
expect_not_filed() { assert "expected new-issue.sh not to run" test -z "$filed"; }
# new-issue.sh got the flag with this value, as one argument after it.
expect_arg() { # flag value
  if grep -qxF -- "$1" <<<"$filed" && [[ $(grep -xF -A1 -- "$1" <<<"$filed" | sed -n 2p) == "$2" ]]; then
    ok
  else
    bad "expected new-issue.sh to get $1 \"$2\""
  fi
}
expect_no_arg() { # flag
  if grep -qxF -- "$1" <<<"$filed"; then bad "expected new-issue.sh not to get $1"; else ok; fi
}
case_() { args=("$@"); run "$@"; }

# --- usage ------------------------------------------------------------------------------------
reset
case_
expect_code 2
expect_err "usage:"
expect_no_gh

case_ --help
expect_code 0
expect_no_gh

for a in abc 0 -4 "4 5" "M4" "#4"; do
  reset
  read -ra words <<<"$a"
  case_ "${words[@]}"
  expect_code 2
  expect_no_gh
  expect_not_filed
done

# --- filing: title, milestone and the fields --------------------------------------------------
reset
case_ 4
expect_code 0
expect_arg --title "Architecture review, M4 Playable slice live"
expect_arg --milestone "M4 Playable slice live"
expect_arg --type chore
expect_arg --area tools
expect_arg --parent 73
expect_arg --track Infra
expect_arg --mode Manual
expect_arg --priority P2
expect_arg --size M
# 29 Nov is Wk 4's last day: the iteration runs 23 Nov plus 7 days.
expect_arg --week "Wk 4 · 23–29 Nov"
assert "expected the body to name the skill and Fallow" \
  grep -q 'improve-codebase-architecture.*Fallow' "$work/body"
assert "expected the body to link the parent" grep -qF 'issues/73' "$work/body"
assert "expected the body to have acceptance criteria" grep -qF -- '- [ ] ' "$work/body"
# The milestone's issues are read with closed ones too.
assert "expected the issue list to ask for state=all" contains "$calls" "milestone=4&state=all"
# The Project's call carries the Project token, and only it does.
assert "expected the Project call to use PROJECT_GH_TOKEN" \
  grep -qxF "project-token GET $P/fields" <<<"$tokens"
assert "expected no other call to use PROJECT_GH_TOKEN" \
  test "$(grep -c '^project-token ' <<<"$tokens")" -eq 1
assert "expected the repo calls to use GH_TOKEN" \
  grep -qxF "repo-token GET $R/milestones/4" <<<"$tokens"

# The first day of an iteration, and a completed iteration, count too.
reset
milestone 4 open '"2026-11-30T00:00:00Z"' "M4 Playable slice live"
case_ 4
expect_arg --week "Wk 5 · 30 Nov–6 Dec"
reset
milestone 4 open '"2026-11-16T00:00:00Z"' "M4 Playable slice live"
case_ 4
expect_arg --week "Wk 3 · 16–22 Nov"

# --- Week left unset: the issue carries triage, and the log says so -------------------------------
reset
milestone 4 open '"2027-01-03T00:00:00Z"' "M4 Playable slice live"
case_ 4
expect_code 0
expect_no_arg --week
expect_arg --priority P2
expect_err "no Week iteration contains"
expect_err "triage"

reset
milestone 4 open null "M4 Playable slice live"
case_ 4
expect_code 0
expect_no_arg --week
expect_err "has no due date"
assert "expected no Project call without a due date" test -z "$(grep "$P" <<<"$tokens")"

# In a workflow run the note is an annotation on stdout.
reset
milestone 4 open null "M4 Playable slice live"
ACTIONS=true case_ 4
expect_out "::warning::milestone-review:"

# The Project refused (the cloud proxy): still filed, without Week; new-issue.sh's code passes on.
reset
touch "$st/refuse_projects"
echo 4 >"$work/new-issue-code"
case_ 4
expect_code 4
expect_no_arg --week
expect_arg --title "Architecture review, M4 Playable slice live"
expect_err "refused the Project"

# Any other Project failure stops before filing.
reset
echo "gh: Server Error (HTTP 500)" >"$st/fail_GET_${P//\//_}_fields"
case_ 4
expect_code 3
expect_not_filed

# --- a milestone that already has its review gets no second --------------------------------------
reset
issues '[{"number": 407, "title": "Architecture review, M3 Actions persist end to end", "state": "open"}]'
case_ 4
expect_code 0
expect_not_filed
expect_out "already has its review: #407"

# A closed review counts too.
reset
issues '[{"number": 600, "title": "Architecture review, M4 Playable slice live", "state": "closed"}]'
case_ 4
expect_code 0
expect_not_filed

# The build issue that asked for these reviews (#517) is no review: the prefix needs the comma.
reset
issues '[{"number": 517, "title": "Architecture review per milestone, filed by a milestone-created workflow"}]'
case_ 4
expect_code 0
expect_arg --title "Architecture review, M4 Playable slice live"

# A pull request with that title is not a review issue.
reset
issues '[{"number": 601, "title": "Architecture review, M4 Playable slice live", "pull_request": {}}]'
case_ 4
expect_code 0
expect_arg --title "Architecture review, M4 Playable slice live"

# --- milestones that can't be filed into ------------------------------------------------------------
reset
milestone 4 closed '"2026-11-29T00:00:00Z"' "M4 Playable slice live"
case_ 4
expect_code 2
expect_err "is closed"
expect_not_filed

reset
case_ 9
expect_code 3
expect_err "could not read milestone 9"
expect_not_filed

# new-issue.sh's failure is the script's failure.
reset
echo 1 >"$work/new-issue-code"
case_ 4
expect_code 1

printf 'milestone-review.test.sh: %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

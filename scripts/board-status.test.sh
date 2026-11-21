#!/usr/bin/env bash
# Tests for board-status.sh through its command line. `decide` runs against the REST fake
# (scripts/lib/gh-rest-fake.sh) on PATH, with JSON shaped like GitHub's answers for a PR, its
# head's check runs and statuses, the PRs of a commit and an issue; a hook answers the one GraphQL
# read (closingIssuesReferences) from a file per PR. `move` runs a copy of the script next to a
# stub issue-fields.sh that records its arguments: issue-fields.test.sh covers what those do.
# Run: bash scripts/board-status.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/board-status.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/board-status-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/move"
cp "$here/lib/gh-rest-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
st=$work/gh
R=repos/sssoto17/sunny-pastures
SHA=1111111111111111111111111111111111111111
OTHER=2222222222222222222222222222222222222222

# The stub issue-fields.sh: one line of arguments a call, joined by "|".
cp "$script" "$work/move/board-status.sh"
cat >"$work/move/issue-fields.sh" <<'EOF'
#!/usr/bin/env bash
(IFS='|'; printf '%s\n' "$*") >>"$(dirname "$0")/calls"
exit "${STUB_EXIT:-0}"
EOF
chmod +x "$work/move/issue-fields.sh"

# --- fixtures ---------------------------------------------------------------------------------
cat >"$work/hook" <<'HOOK'
case "$method $path" in
  "POST graphql") # closingIssuesReferences of PR .pr, from closing-<pr> (none: no file)
    pr=$(jq -r .pr <<<"$input")
    nodes=$(cat "$st/closing-$pr" 2>/dev/null || echo '[]')
    out=$(jq -n --argjson n "$nodes" '{data: {repository: {pullRequest: {closingIssuesReferences: {nodes: $n}}}}}') ;;
  *) return 1 ;;
esac
HOOK

reset() {
  rm -rf "$st"
  mkdir -p "$st/get/$R/pulls" "$st/get/$R/issues" "$st/get/$R/commits/$SHA" "$st/get/$R/commits/$OTHER"
  cp "$work/hook" "$st/hook"
  echo '[]' >"$st/get/$R/commits/$OTHER/pulls" # main's commit: no PR has it as its head
  rm -f "$work/move/calls"
}
pr() { # number state draft merged [sha]
  jq -n --argjson n "$1" --arg s "$2" --argjson d "$3" --argjson m "$4" --arg h "${5:-$SHA}" \
    '{number: $n, state: $s, draft: $d, merged: $m, title: "::error::not a command",
      head: {sha: $h, ref: "x", repo: {full_name: "sssoto17/sunny-pastures"}}, base: {ref: "main"},
      body: "Closes #999 (only GitHub'"'"'s record counts on main)"}' \
    >"$st/get/$R/pulls/$1"
}
stacked() { # pr base body -> the PR sits on another part's branch, with this body
  jq --arg b "$2" --arg t "$3" '.base.ref = $b | .body = $t' "$st/get/$R/pulls/$1" >"$work/p" &&
    mv "$work/p" "$st/get/$R/pulls/$1"
}
closes() { # pr "number:STATE[:owner/repo]"...
  local p=$1 spec
  shift
  for spec in "$@"; do
    IFS=: read -r n s r <<<"$spec"
    jq -n --argjson n "$n" --arg s "$s" --arg r "${r:-sssoto17/sunny-pastures}" \
      '{number: $n, state: $s, repository: {nameWithOwner: $r}}'
  done | jq -s . >"$st/closing-$p"
}
checks() { # "id|status|conclusion|name"... -> the head's check runs
  local spec
  for spec in "$@"; do
    IFS='|' read -r id s c n <<<"$spec"
    jq -n --argjson id "$id" --arg s "$s" --arg c "$c" --arg n "$n" \
      '{id: $id, name: $n, status: $s, conclusion: (if $c == "" then null else $c end)}'
  done | jq -s '{total_count: length, check_runs: .}' >"$st/get/$R/commits/$SHA/check-runs"
}
statuses() { # "state|context"...
  local spec
  for spec in "$@"; do
    IFS='|' read -r s c <<<"$spec"
    jq -n --arg s "$s" --arg c "$c" '{state: $s, context: $c}'
  done | jq -s '{state: "pending", statuses: .}' >"$st/get/$R/commits/$SHA/status"
}
green() { checks "1|completed|success|ci / test" "2|completed|skipped|ci / bench" "3|completed|neutral|label"; statuses; }

run() { # args... -> code, out, err
  out=$(PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
}
run_move() { # args... -> code, out, err, mcalls
  out=$(bash "$work/move/board-status.sh" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  mcalls=$(cat "$work/move/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n' "$1" "${args[*]}" "$code" "$out" "$err"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_out() { assert "expected stdout to be: $1" test "$out" == "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
case_() { args=("$@"); run "$@"; }
move_() { args=("$@"); run_move "$@"; }

# --- arguments ----------------------------------------------------------------------------------
for bad_args in "" "decide" "decide pr" "decide pr 0" "decide pr 12x" "decide commit abc" \
  "decide issue 4" "move" "move 4" "move 4:ready" "move 4:start:x" "move x:start" "nope 4"; do
  reset
  read -ra words <<<"$bad_args"
  case_ "${words[@]}"
  expect_code 2
  assert "expected no gh calls" test ! -s "$st/calls"
done
reset
case_ --help
expect_code 0
expect_err "usage:"

# --- decide pr: the table in "Status rules" -------------------------------------------------------
# Open, ready, checks green: In review.
reset
pr 12 open false false
closes 12 417:OPEN
green
case_ decide pr 12
expect_code 0
expect_out "moves=417:review"

# Green apart from `guard / code-owned`, red until the admin approves (admin, 21 Nov): In review.
reset
pr 12 open false false
closes 12 417:OPEN
checks "1|completed|success|ci / test" "2|completed|failure|guard / code-owned"
statuses
case_ decide pr 12
expect_out "moves=417:review"

# This workflow's own job, still running on the head, doesn't hold it back.
reset
pr 12 open false false
closes 12 417:OPEN
checks "1|completed|success|ci / test" "2|in_progress||board / decide"
statuses
case_ decide pr 12
expect_out "moves=417:review"

# Any check red: back to In progress.
for red in failure timed_out action_required startup_failure; do
  reset
  pr 12 open false false
  closes 12 417:OPEN
  checks "1|completed|success|ci / test" "2|completed|$red|ci / lint"
  statuses
  case_ decide pr 12
  expect_out "moves=417:back"
done
# A failed commit status is red too.
for red in failure error; do
  reset
  pr 12 open false false
  closes 12 417:OPEN
  green
  statuses "success|vercel" "$red|other"
  case_ decide pr 12
  expect_out "moves=417:back"
done

# Still running, cancelled, stale, a pending status, or no check yet: work has started, no more.
for spec in "2|in_progress||ci / lint" "2|queued||ci / lint" "2|completed|cancelled|ci / lint" \
  "2|completed|stale|ci / lint"; do
  reset
  pr 12 open false false
  closes 12 417:OPEN
  checks "1|completed|success|ci / test" "$spec"
  statuses
  case_ decide pr 12
  expect_out "moves=417:start"
done
reset
pr 12 open false false
closes 12 417:OPEN
green
statuses "pending|vercel"
case_ decide pr 12
expect_out "moves=417:start"
reset
pr 12 open false false
closes 12 417:OPEN
checks
statuses
case_ decide pr 12
expect_out "moves=417:start"
# Only `guard / code-owned` has run: not green yet.
reset
pr 12 open false false
closes 12 417:OPEN
checks "1|completed|failure|guard / code-owned"
statuses
case_ decide pr 12
expect_out "moves=417:start"

# The latest run of a name counts: a re-run that passed clears an old failure, and back again.
reset
pr 12 open false false
closes 12 417:OPEN
checks "5|completed|success|ci / test" "3|completed|failure|ci / test"
statuses
case_ decide pr 12
expect_out "moves=417:review"
reset
pr 12 open false false
closes 12 417:OPEN
checks "3|completed|success|ci / test" "5|completed|failure|ci / test"
statuses
case_ decide pr 12
expect_out "moves=417:back"

# Marked ready: never In review on that event, even when the head reads green (the draft's
# skipped jobs): the CI run's completion decides. Red is still red; other actions read checks.
reset
pr 12 open false false
closes 12 417:OPEN
green
case_ decide pr 12 ready_for_review
expect_code 0
expect_out "moves=417:start"
reset
pr 12 open false false
closes 12 417:OPEN
checks "1|completed|failure|ci / lint"
statuses
case_ decide pr 12 ready_for_review
expect_out "moves=417:back"
reset
pr 12 open false false
closes 12 417:OPEN
green
case_ decide pr 12 edited
expect_out "moves=417:review"
for bad in checks "Ready" '$(id)' ""; do
  reset
  case_ decide pr 12 "$bad"
  expect_code 2
  assert "expected no gh calls" test ! -s "$st/calls"
done

# A draft is In progress, never In review, even when green.
reset
pr 12 open true false
closes 12 417:OPEN
green
case_ decide pr 12
expect_out "moves=417:back"
expect_err "PR #12 a draft: #417 back"

# Closed unmerged: back to In progress. Merged: nothing, the built-ins do Done.
reset
pr 12 closed false false
closes 12 417:OPEN
case_ decide pr 12
expect_out "moves=417:back"
reset
pr 12 closed false true
closes 12 417:OPEN
case_ decide pr 12
expect_code 0
expect_out "moves="
expect_err "built-in"

# Only the part that closes the issue moves it: a `Part of #N` part has no closing reference.
reset
pr 12 open false false
green
case_ decide pr 12
expect_code 0
expect_out "moves="
expect_err "closes no open issue"

# Several issues; a closed one and another repo's are left out.
reset
pr 12 open false false
closes 12 417:OPEN 418:OPEN 300:CLOSED 5:OPEN:someone/else
green
case_ decide pr 12
expect_out "moves=417:review 418:review"

# What it logs is numbers and fixed text: never the PR's title or a check's name.
reset
pr 12 open false false
closes 12 417:OPEN
checks "1|completed|failure|::error::ci"
statuses
case_ decide pr 12
assert "expected no workflow command in the log" test "${err/::error::/}" == "$err"
expect_out "moves=417:back"

# A failed read stops with exit 1 and prints no moves line.
reset
pr 12 open false false
closes 12 417:OPEN
green
echo "gh: Server Error (HTTP 502)" >"$st/fail_GET_${R//\//_}_commits_${SHA}_check-runs"
case_ decide pr 12
expect_code 1
expect_out ""
reset
case_ decide pr 99
expect_code 1
expect_err "could not read PR #99"

# --- a stack's closing part, before it sits on main ----------------------------------------------
issue() { # number state [pr]
  jq -n --argjson n "$1" --arg s "$2" --arg p "${3-}" \
    '{number: $n, state: $s} + (if $p == "" then {} else {pull_request: {}} end)' >"$st/get/$R/issues/$1"
}
# GitHub records no closing reference on another base, so the body's keyword names the issue.
reset
pr 12 open false false
stacked 12 417-part-2 $'## What\nCloses #417\n\nThe earlier parts: #401, #402.'
issue 417 open
green
case_ decide pr 12
expect_code 0
expect_out "moves=417:review"
# Each form GitHub reads: any case, a colon, this repo's owner/name; a draft is still back.
for body in "fixes: #417" "RESOLVED #417" "closes sssoto17/sunny-pastures#417" "- Close #417."; do
  reset
  pr 12 open true false
  stacked 12 417-part-2 "$body"
  issue 417 open
  case_ decide pr 12
  expect_out "moves=417:back"
done
# A `Part of` part names no closing keyword: nothing moves.
reset
pr 11 open false false
stacked 11 417-part-1 "Part of #417"
issue 417 open
green
case_ decide pr 11
expect_out "moves="
expect_err "closes no open issue"
# Another repo's issue, a closed issue, a PR, a missing issue, and a keyword glued to a word.
reset
pr 12 open false false
stacked 12 417-part-2 "Closes someone/else#417, closes #300, closes #301, closes #302, encloses #303"
issue 417 open
issue 300 closed
issue 301 open pr
issue 303 open
green
case_ decide pr 12
expect_code 0
expect_out "moves="
# A reference with letters glued on names no issue: not #417 from "#417abc", not #4 from "#4x17".
reset
pr 12 open false false
stacked 12 417-part-2 "closes #417abc, closes #4x17"
issue 417 open
issue 4 open
green
case_ decide pr 12
expect_code 0
expect_out "moves="
# A failed read of the body stops the step: never "closes nothing".
reset
pr 12 open false false
stacked 12 417-part-2 "Closes #417"
issue 417 open
green
echo "gh: Server Error (HTTP 502)" >"$st/fail_GET_${R//\//_}_pulls_12.2"
case_ decide pr 12
expect_code 1
expect_out ""
expect_err "could not read the issues PR #12 closes"
# A failed issue read stops it too; only a missing issue (404) is left out.
reset
pr 12 open false false
stacked 12 417-part-2 "Closes #417"
issue 417 open
green
echo "gh: Server Error (HTTP 502)" >"$st/fail_GET_${R//\//_}_issues_417"
case_ decide pr 12
expect_code 1
expect_out ""
expect_err "could not read the issues PR #12 closes"

# On main, the body doesn't count: only GitHub's record (the fixture's body names #999).
reset
pr 12 open false false
issue 999 open
green
case_ decide pr 12
expect_out "moves="

# --- decide commit: a finished run's head ---------------------------------------------------------
reset
pr 12 open false false
closes 12 417:OPEN
green
jq -n --arg h "$SHA" --arg o "$OTHER" '[{number: 12, state: "open", head: {sha: $h}},
  {number: 13, state: "closed", head: {sha: $h}}, {number: 14, state: "open", head: {sha: $o}}]' \
  >"$st/get/$R/commits/$SHA/pulls"
case_ decide commit "$SHA"
expect_code 0
expect_out "moves=417:review"
# A pull_request_target run's head is main's commit: its PRs come from the event, checked.
reset
pr 12 open false false
closes 12 417:OPEN
green
jq -n '[]' >"$st/get/$R/commits/$OTHER/pulls"
case_ decide commit "$OTHER" 12 12
expect_code 0
expect_out "moves=417:review"
reset
case_ decide commit "$OTHER" 12x
expect_code 2
assert "expected no gh calls" test ! -s "$st/calls"

# A fork's PR moves nothing, whichever way it's found.
reset
pr 12 open false false
jq '.head.repo.full_name = "someone/fork"' "$st/get/$R/pulls/12" >"$work/f" && mv "$work/f" "$st/get/$R/pulls/12"
closes 12 417:OPEN
green
case_ decide pr 12
expect_out "moves="
expect_err "another repository"

# A check run moves a ready PR only on green or red: pending, a draft or a closed PR moves nothing
# (their own events did), so the token's job doesn't start.
reset
pr 12 open false false
closes 12 417:OPEN
checks "1|completed|failure|ci / lint"
statuses
case_ decide commit "$OTHER" 12
expect_out "moves=417:back"
reset
pr 12 open false false
closes 12 417:OPEN
checks "1|in_progress||ci / lint"
statuses
case_ decide commit "$OTHER" 12
expect_out "moves="
expect_err "still pending"
for st_dr in "open true" "closed false"; do
  reset
  read -r s d <<<"$st_dr"
  pr 12 "$s" "$d" false
  closes 12 417:OPEN
  green
  case_ decide commit "$OTHER" 12
  expect_out "moves="
done

# A commit on main (the merged PR) moves nothing.
reset
jq -n '[{number: 12, state: "closed", head: {sha: "x"}}]' >"$st/get/$R/commits/$SHA/pulls"
case_ decide commit "$SHA"
expect_code 0
expect_out "moves="

# --- decide branch: a new branch for an issue -------------------------------------------------------
for b in 417-board-status claude/issue-417-project-status-5ecmfs chore/417-x issue-417-x; do
  reset
  issue 417 open
  case_ decide branch "$b"
  expect_code 0
  expect_out "moves=417:start"
done
for b in main prototype/persistence release/v0.3 docs/glossary 'a/b/417-x' '417-$(id)' "417-"; do
  reset
  issue 417 open
  case_ decide branch "$b"
  expect_code 0
  expect_out "moves="
done
reset
issue 417 closed
case_ decide branch 417-x
expect_out "moves="
reset
issue 417 open pr
case_ decide branch 417-x
expect_out "moves="
reset
case_ decide branch 417-x
expect_code 0
expect_out "moves="

# --- move: through issue-fields.sh's guarded form ---------------------------------------------------
reset
move_ move 417:start
expect_code 0
assert "expected the start move" test "$mcalls" == "417|--status|In progress|--from|Ready"
reset
move_ move 417:back
assert "expected the back move" test "$mcalls" == "417|--status|In progress|--from|Ready,In review"
reset
move_ move 417:review
assert "expected the review move" test "$mcalls" == "417|--status|In review|--from|Ready,In progress"

# No move sets Ready, starts from Backlog, or touches another field (Mode Factory above all).
for kind in start back review; do
  reset
  move_ move "417:$kind"
  IFS='|' read -ra a <<<"$mcalls"
  assert "expected --status and --from only ($kind)" test "${#a[@]}" -eq 5
  assert "expected no Ready target ($kind)" test "${a[2]}" != Ready
  assert "expected no Backlog in --from ($kind)" test "${a[4]/Backlog/}" == "${a[4]}"
  assert "expected no --mode ($kind)" test "${mcalls/--mode/}" == "$mcalls"
done

# A failed move fails the step.
reset
STUB_EXIT=1 run_move move 417:start
args=(move 417:start)
expect_code 1

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

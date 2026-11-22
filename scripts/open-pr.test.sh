#!/usr/bin/env bash
# Tests for open-pr.sh through its command line: real git against a throwaway bare remote, and the
# fake gh in scripts/lib/gh-fake.sh, whose POST dispatches runs the real workflow step
# (.github/scripts/open-pr.sh) as sunny-factory[bot]. It never reaches GitHub.
# Run: bash scripts/open-pr.test.sh (needs jq)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/open-pr.sh"
pass=0
fail=0
command -v jq >/dev/null || { echo "jq is not installed: install it to run these tests" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/open-pr-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cp "$(dirname "$script")/lib/gh-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
export GIT_CONFIG_GLOBAL=$work/gitconfig GIT_CONFIG_NOSYSTEM=1 OPEN_PR_POLL=0
export FAKE_WORKFLOW_SCRIPT
FAKE_WORKFLOW_SCRIPT="$(cd "$(dirname "$script")/.." && pwd)/.github/scripts/open-pr.sh"
git config --global user.name "open-pr test"
git config --global user.email "open-pr-test@example.invalid"
git config --global init.defaultBranch main

reset() {
  rm -rf "$work/gh" "$work/remote.git" "$work/repo"
  mkdir -p "$work/gh/pulls" "$work/gh/stacks" "$work/gh/runs"
  echo 400 >"$work/gh/next"
  printf 'review:admin\narea:ci-cd\n' >"$work/gh/labels"
  git init -q --bare "$work/remote.git"
  git init -q "$work/repo"
  repo=$work/repo
  git -C "$repo" remote add origin "$work/remote.git"
  echo base >"$repo/README" && git -C "$repo" add README && git -C "$repo" commit -qm base
  git -C "$repo" push -q origin main
  branch 336-a main
  printf 'feat(ci): open PRs as the App (#336)\n\nCloses #336.\n\nMore text.\n' >"$work/body.md"
}
branch() { # name from -> a pushed branch with one commit
  git -C "$repo" switch -q -c "$1" "$2"
  local f=${1//\//-}.txt
  echo "$1" >"$repo/$f" && git -C "$repo" add "$f" && git -C "$repo" commit -qm "$1"
  git -C "$repo" push -q origin "$1"
}
run() { # args... -> code, out, err, calls
  out=$(cd "$repo" && PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/gh/calls" 2>/dev/null || true)
}
pr_field() { jq -r "$2" "$work/gh/pulls/$1.json"; }
dispatched() { [[ -s $work/gh/dispatches ]]; }

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n' "$1" "$code" "$out" "$err"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_eq() { if [[ $2 == "$3" ]]; then ok; else bad "$1: expected '$3', got '$2'"; fi; }

# --- usage ------------------------------------------------------------------------------------
reset
run --help
expect_code 0
expect_err "usage:"
expect_err "Exit codes:"
run
expect_code 2
run 336-a
expect_code 2
run --nope 336-a "$work/body.md"
expect_code 2

# --- the happy path: the PR is the App's, and its number is all stdout holds ------------------
reset
run --label review:admin --label area:ci-cd 336-a "$work/body.md"
expect_code 0
expect_eq "stdout is the PR number" "$out" 400
expect_eq "opened by the App" "$(pr_field 400 .user.login)" "sunny-factory[bot]"
expect_eq "title from the first line" "$(pr_field 400 .title)" "feat(ci): open PRs as the App (#336)"
expect_eq "body without the title line" "$(pr_field 400 .body)" $'Closes #336.\n\nMore text.'
expect_eq "on main" "$(pr_field 400 .base.ref)" main
payload=$(head -n1 "$work/gh/dispatches")
expect_eq "event type" "$(jq -r .event_type <<<"$payload")" open-pr
expect_eq "payload properties (at most 10)" "$(jq -c '.client_payload | keys' <<<"$payload")" \
  '["base","body","branch","labels","ready","title"]'
expect_eq "asks for the ready mark" "$(jq -r .client_payload.ready <<<"$payload")" true
# #358: opened as a draft, then marked ready by the run, so ready_for_review starts the one CI run
expect_eq "opened as a draft, then marked ready" "$(cat "$work/gh/events")" $'opened 400 draft=true\nmarked 400 ready'
expect_eq "ready once open" "$(pr_field 400 .draft)" false
expect_eq "the run marked it ready" "$(cat "$work/gh/run_9001.output")" $'pr=400\nstack=none\nready=yes'
expect_eq "labels as one property" "$(jq -r .client_payload.labels <<<"$payload")" "review:admin,area:ci-cd"
assert "labels added by the App" contains "$calls" $'issues/400/labels\n--silent\n-f\nlabels[]=review:admin\n-f\nlabels[]=area:ci-cd'
expect_err "opened #400"

# --- a stack part: the App links it into a stack with the part below ----------------------------
branch 336-b 336-a
run --base 336-a 336-b "$work/body.md"
expect_code 0
expect_eq "part 2's PR" "$out" 401
expect_eq "on the part below" "$(pr_field 401 .base.ref)" 336-a
expect_eq "stacked by the App" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401]"

# --- an open PR already: its number, no dispatch -------------------------------------------------
rm -f "$work/gh/dispatches"
run 336-a "$work/body.md"
expect_code 0
expect_eq "the open PR's number" "$out" 400
expect_err "already open"
assert "no dispatch" bash -c "! test -s '$work/gh/dispatches'"
# still a draft (a ready mark that failed): the run again marks it ready, through pr-draft
jq '.draft = true' "$work/gh/pulls/400.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/400.json"
run 336-a "$work/body.md"
expect_code 0
expect_eq "the open PR's number, still" "$out" 400
expect_eq "marked ready" "$(pr_field 400 .draft)" false
expect_eq "through pr-draft, as the App" "$(jq -r .event_type "$work/gh/dispatches")" pr-draft

# --- --draft: the PR stays a draft for the caller (scripts/stack.sh) to mark ready ---------------
reset
run --draft 336-a "$work/body.md"
expect_code 0
expect_eq "asks for no ready mark" "$(jq -r .client_payload.ready "$work/gh/dispatches")" false
expect_eq "still a draft" "$(pr_field 400 .draft)" true
rm -f "$work/gh/dispatches"
run --draft 336-a "$work/body.md"
expect_eq "reused, still a draft, nothing sent" "$(pr_field 400 .draft) $(cat "$work/gh/dispatches" 2>/dev/null)" "true "

# --- the run's ready mark fails: exit 1, the PR open as a draft ----------------------------------
reset
echo "gh: Resource not accessible by integration" >"$work/gh/fail_app_POST_graphql"
run 336-a "$work/body.md"
expect_code 1
expect_err "the open-pr run failed"
expect_eq "open, still a draft" "$(pr_field 400 .draft)" true

# --- the title (#471): a conventional one, and never the body's Closes / Part of link ------------
reset
printf 'Closes #336.\n\nMore text.\n' >"$work/link.md"
run 336-a "$work/link.md"
expect_code 2
expect_err "which here is the link \"Closes #336.\""
expect_err "put a title line such as \`fix(tools): <summary>\` above it"
printf 'Part of #336.\n' >"$work/link.md"
run --draft 336-a "$work/link.md"
expect_code 2
expect_err "which here is the link \"Part of #336.\""
for t in "Open PRs as the App" "feature: x" "feat:x" "feat(): x" "feat(ci) : x" "Feat: x" "feat: "; do
  printf '%s\n\nCloses #336.\n' "$t" >"$work/bad.md"
  run 336-a "$work/bad.md"
  expect_code 2
  expect_err "doesn't start with a conventional type"
done
expect_err "with <type> one of feat, fix, chore, docs, test, ci, build, refactor, perf, style, revert"
OPEN_PR_AS_ADMIN=336 run --as-admin 336-a "$work/link.md"
expect_code 2
expect_err "which here is the link"
assert "nothing dispatched or opened" bash -c "! test -s '$work/gh/dispatches' && ! test -e '$work/gh/pulls/400.json'"
for t in "fix: x" "docs(review): x" "feat(ci)!: x" "refactor!: x" "revert: feat: x" "spike(sim): x"; do
  printf '%s\n\nCloses #336.\n' "$t" >"$work/good.md"
  run --dry-run 336-a "$work/good.md"
  expect_code 0
  expect_eq "the title $t passes" "$(jq -r .client_payload.title <<<"$out")" "$t"
done

# --- refused before the dispatch -----------------------------------------------------------------
reset
git -C "$repo" switch -q -c 336-local main
run 336-local "$work/body.md"
expect_code 2
expect_err "no branch 336-local on origin"
git -C "$repo" switch -q 336-a
git -C "$repo" commit -q --allow-empty -m "not pushed"
run 336-a "$work/body.md"
expect_code 2
expect_err "push it first"
printf '\n\nno title\n' >"$work/empty.md"
run 336-a "$work/empty.md"
expect_code 2
expect_err "no title"
run 336-a "$work/missing.md"
expect_code 2
expect_err "can't read"
{ echo "feat: big"; head -c 70000 /dev/zero | tr '\0' x; } >"$work/big.md"
git -C "$repo" push -q origin 336-a
run 336-a "$work/big.md"
expect_code 2
expect_err "64 KB"
assert "nothing dispatched" bash -c "! test -s '$work/gh/dispatches'"

# --- dry run: the request, checked and printed, nothing sent ------------------------------------
reset
run --dry-run --label review:admin 336-a "$work/body.md"
expect_code 0
expect_eq "prints the request" "$(jq -r '.event_type, .client_payload.branch, .client_payload.base' <<<"$out" | tr '\n' ' ')" "open-pr 336-a main "
expect_err "dry run"
assert "nothing dispatched" bash -c "! test -s '$work/gh/dispatches'"

# --- the workflow refuses: exit 1 with the run's link, at once ---------------------------------
reset
branch feature/x main
run feature/x "$work/body.md"
expect_code 1
expect_err "the open-pr run failed"
expect_err "https://github.com/runs/9001"
assert "no PR" test ! -e "$work/gh/pulls/400.json"

# --- no run, or a run that never ends: a timeout that says where to look -------------------------
reset
touch "$work/gh/no_workflow"
OPEN_PR_TIMEOUT=0 run 336-a "$work/body.md"
expect_code 1
expect_err "no PR for 336-a after 0 s"
expect_err "actions/workflows/open-pr.yml/runs"
reset
touch "$work/gh/run_pending"
OPEN_PR_TIMEOUT=0 run 336-a "$work/body.md"
expect_code 1
expect_err "https://github.com/runs/9001"

# --- the runs list is refused: the PR's arrival alone answers ----------------------------------
reset
echo "gh: Forbidden (HTTP 403)" >"$work/gh/fail_GET_repos_sssoto17_sunny-pastures_actions_workflows_open-pr.yml_runs"
run 336-a "$work/body.md"
expect_code 0
expect_eq "the PR's number" "$out" 400

# --- a run older than this dispatch is never read as its answer --------------------------------
reset
branch feature/y main
run feature/y "$work/body.md" # run 9001 fails
touch "$work/gh/no_workflow"
OPEN_PR_TIMEOUT=0 run feature/y "$work/body.md"
expect_code 1
expect_err "no PR for feature/y after 0 s"

# --- --as-admin (#385): off unless the admin's launch named the issue -------------------------
unset OPEN_PR_AS_ADMIN
printf 'test(acceptance): the first contract (#386)\n\nCloses #386.\n' >"$work/admin.md"
reset
run --as-admin 336-a "$work/admin.md"
expect_code 2
expect_err "OPEN_PR_AS_ADMIN"
assert "nothing opened" test ! -e "$work/gh/pulls/400.json"
OPEN_PR_AS_ADMIN=1 run --as-admin 336-a "$work/admin.md"
expect_code 2
expect_err "doesn't link #1"
OPEN_PR_AS_ADMIN=386x run --as-admin 336-a "$work/admin.md"
expect_code 2
expect_err "an issue number"
OPEN_PR_AS_ADMIN=38 run --as-admin 336-a "$work/admin.md"
expect_code 2
expect_err "doesn't link #38"
# the link needs a word of its own: "Discloses #386" or "xPart of #386" doesn't link #386
printf 'test(acceptance): x\n\nDiscloses #386 and xPart of #386.\n' >"$work/word.md"
OPEN_PR_AS_ADMIN=386 run --as-admin 336-a "$work/word.md"
expect_code 2
expect_err "doesn't link #386"
OPEN_PR_AS_ADMIN=386 run --as-admin --label nope 336-a "$work/admin.md"
expect_code 2
expect_err "no label nope"
assert "nothing opened or dispatched" bash -c "! test -e '$work/gh/pulls/400.json' && ! test -s '$work/gh/dispatches'"

# the variable alone changes nothing: without the switch the App opens the PR
reset
OPEN_PR_AS_ADMIN=386 run 336-a "$work/admin.md"
expect_code 0
expect_eq "the App without the switch" "$(pr_field 400 .user.login)" "sunny-factory[bot]"

# on: the PR is the admin's, opened over REST, and its body says a lane opened it
reset
GH_TOKEN=ghp_sentinel_never_printed OPEN_PR_AS_ADMIN=386 run --as-admin --label review:admin 336-a "$work/admin.md"
expect_code 0
expect_eq "stdout is the PR number" "$out" 400
expect_eq "opened by the admin" "$(pr_field 400 .user.login)" sssoto17
expect_eq "the title" "$(pr_field 400 .title)" "test(acceptance): the first contract (#386)"
assert "the body keeps the link" contains "$(pr_field 400 .body)" "Closes #386."
assert "the body says a lane opened it as the admin" contains "$(pr_field 400 .body)" \
  "Opened as the admin by a lane, with \`scripts/open-pr.sh --as-admin\` on a run the admin started for #386 (#385)."
assert "no open-pr dispatch" bash -c "! grep -q '\"open-pr\"' '$work/gh/dispatches'"
# #358: opened as a draft over REST, and marked ready by the App through pr-draft
expect_eq "opened as a draft, marked ready by the App through pr-draft" "$(cat "$work/gh/events")" \
  $'opened 400 draft=true\nready 400\nmarked 400 ready'
expect_eq "ready" "$(pr_field 400 .draft)" false
assert "the label added" contains "$calls" $'issues/400/labels\n--silent\n-f\nlabels[]=review:admin'
expect_err "opened #400 as the admin"
assert "no token in the output" bash -c "! grep -q ghp_sentinel <<<'$out$err'"

# a stack part, and Part of #N, open on the part below
branch 336-b 336-a
printf 'test(acceptance): part 2\n\nPart of #386.\n' >"$work/part.md"
OPEN_PR_AS_ADMIN=386 run --as-admin --base 336-a 336-b "$work/part.md"
expect_code 0
expect_eq "on the part below" "$(pr_field 401 .base.ref)" 336-a
expect_eq "part 2 by the admin" "$(pr_field 401 .user.login)" sssoto17
branch 336-d 336-b
OPEN_PR_AS_ADMIN=386 run --as-admin --draft --base 336-b 336-d "$work/part.md"
expect_code 0
expect_eq "--draft leaves the admin's PR a draft" "$(pr_field 402 .draft)" true

# the workflow's own refusals hold with the switch too, before anything is sent
reset
branch feature/z main
OPEN_PR_AS_ADMIN=386 run --as-admin feature/z "$work/admin.md"
expect_code 2
expect_err "isn't a lane branch"
OPEN_PR_AS_ADMIN=386 run --as-admin main "$work/admin.md"
expect_code 2
expect_err "never from main"
OPEN_PR_AS_ADMIN=386 run --as-admin --base feature/z 336-a "$work/admin.md"
expect_code 2
expect_err "isn't main or a lane branch"
OPEN_PR_AS_ADMIN=386 run --as-admin --label 'a b' 336-a "$work/admin.md"
expect_code 2
expect_err "not a label name"
branch 336-c main
OPEN_PR_AS_ADMIN=386 run --as-admin --base 336-c 336-a "$work/admin.md"
expect_code 2
expect_err "has no open PR"
assert "nothing opened" test ! -e "$work/gh/pulls/400.json"

# an open PR the App opened can't stand in for the admin's
run 336-a "$work/body.md"
OPEN_PR_AS_ADMIN=386 run --as-admin 336-a "$work/admin.md"
expect_code 2
expect_err "#400 was opened by sunny-factory[bot]"

# a label GitHub refuses after the PR opened: exit 1, the number still on stdout
reset
echo "gh: Forbidden (HTTP 403)" >"$work/gh/fail_POST_repos_sssoto17_sunny-pastures_issues_400_labels"
OPEN_PR_AS_ADMIN=386 run --as-admin --label review:admin 336-a "$work/admin.md"
expect_code 1
expect_eq "the PR's number" "$out" 400
expect_err "adding the label review:admin failed"

# a dry run prints the request and opens nothing
reset
OPEN_PR_AS_ADMIN=386 run --as-admin --dry-run 336-a "$work/admin.md"
expect_code 0
expect_eq "the pulls request" "$(jq -r '.head, .base' <<<"$out" | tr '\n' ' ')" "336-a main "
assert "nothing opened" test ! -e "$work/gh/pulls/400.json"

echo "open-pr.test.sh: $pass passed, $fail failed"
((fail == 0))

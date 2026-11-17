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
  '["base","body","branch","labels","title"]'
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

echo "open-pr.test.sh: $pass passed, $fail failed"
((fail == 0))

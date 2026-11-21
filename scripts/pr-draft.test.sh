#!/usr/bin/env bash
# Tests for pr-draft.sh through its command line, with the fake gh in scripts/lib/gh-fake.sh, whose
# POST dispatches runs the real workflow step (.github/scripts/pr-draft.sh) as sunny-factory[bot].
# It never reaches GitHub. Run: bash scripts/pr-draft.test.sh (needs jq)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/pr-draft.sh"
pass=0
fail=0
command -v jq >/dev/null || { echo "jq is not installed: install it to run these tests" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/pr-draft-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cp "$(dirname "$script")/lib/gh-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
export PR_DRAFT_POLL=0 FAKE_WORKFLOW_SCRIPT
FAKE_WORKFLOW_SCRIPT="$(cd "$(dirname "$script")/.." && pwd)/.github/scripts/open-pr.sh"

reset() { # a PR per argument "<n>:<head>:<draft>", in a fake GitHub with no remote
  rm -rf "$work/gh"
  mkdir -p "$work/gh/pulls" "$work/gh/runs"
  local spec n head d
  for spec in "$@"; do
    IFS=: read -r n head d <<<"$spec"
    jq -n --argjson n "$n" --arg h "$head" --argjson d "$d" '{number: $n, state: "open", draft: $d,
      node_id: "PR_\($n)", head: {ref: $h, sha: "x", repo: {full_name: "sssoto17/sunny-pastures"}},
      base: {ref: "main"}}' >"$work/gh/pulls/$n.json"
  done
}
run() { # args... -> code, out, err
  out=$(PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
}
draft() { jq -r .draft "$work/gh/pulls/$1.json"; }
dispatches() { cat "$work/gh/dispatches" 2>/dev/null || true; }

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
run
expect_code 2
run open 41
expect_code 2
run ready
expect_code 2
run ready 41x
expect_code 2
expect_err "not a PR number: 41x"
expect_eq "nothing sent" "$(dispatches)" ""

# --- draft, then ready: one dispatch each, as the App, waited for -------------------------------
reset 41:358-a:false 42:claude/b-1:false
run draft 41 42 41
expect_code 0
expect_eq "both drafts" "$(draft 41) $(draft 42)" "true true"
payload=$(dispatches)
expect_eq "event type" "$(jq -r .event_type <<<"$payload")" pr-draft
expect_eq "the payload: state and the PRs, each once" "$(jq -c .client_payload <<<"$payload")" \
  '{"state":"draft","prs":"41,42"}'
run ready 41 42
expect_code 0
expect_eq "both ready" "$(draft 41) $(draft 42)" "false false"
expect_eq "the workflow switched each, draft then ready" "$(cat "$work/gh/events")" \
  $'draft 41,42\nmarked 41 draft\nmarked 42 draft\nready 41,42\nmarked 41 ready\nmarked 42 ready'

# --- only the PRs not in the state are sent; none, and nothing is sent ----------------------------
reset 41:358-a:false 42:358-b:true
run ready 41 42
expect_code 0
expect_eq "only #42 asked" "$(jq -r .client_payload.prs <<<"$(dispatches)")" 42
rm -f "$work/gh/dispatches"
run ready 41 42
expect_code 0
expect_eq "nothing sent when every PR is ready" "$(dispatches)" ""

# --- the workflow refuses: exit 1 with the run's link, and the PR unchanged ----------------------
reset 41:main:false
run draft 41
expect_code 1
expect_err "the pr-draft run failed (failure)"
expect_err "https://github.com/runs/"
expect_eq "#41 unchanged" "$(draft 41)" false
reset 41:358-a:true
echo "gh: Resource not accessible by integration" >"$work/gh/fail_app_POST_graphql"
run ready 41
expect_code 1
expect_err "the pr-draft run failed"

# --- no run, or one that never ends: a timeout that names the PRs ------------------------------
reset 41:358-a:true
touch "$work/gh/no_workflow"
PR_DRAFT_TIMEOUT=0 run ready 41
expect_code 1
expect_err "after 0 s GitHub doesn't show #41 as ready"
reset 41:358-a:true
touch "$work/gh/run_pending"
PR_DRAFT_TIMEOUT=0 run ready 41
expect_code 1
expect_err "the run: https://github.com/runs/"

# --- a PR GitHub can't find: refused before anything is sent ------------------------------------
reset
run ready 41
expect_code 1
expect_err "can't read PR #41"
expect_eq "nothing sent" "$(dispatches)" ""

echo "pr-draft.test.sh: $pass passed, $fail failed"
((fail == 0))

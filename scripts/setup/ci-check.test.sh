#!/usr/bin/env bash
# Tests for ci-check.sh through its command line, against throwaway git repos under $TMPDIR: a
# bare "origin" and the admin's clone of it. `gh` is a fake on PATH: it logs its calls, and
# answers reads from fixture files in $work/fx; when the script passes --jq, the fake runs that
# program over the fixture with the real jq, so the script's own jq programs are under test.
# Needs jq. Run: bash scripts/setup/ci-check.test.sh
# shellcheck disable=SC2016 # Markdown backticks in expected output, by design
set -uo pipefail
command -v jq >/dev/null || { echo "ci-check.test: needs jq" >&2; exit 2; }

script="$(cd "$(dirname "$0")" && pwd)/ci-check.sh"
draft="$(cd "$(dirname "$0")" && pwd)/workflows/check-101-identities.yml"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-check-test.XXXXXX")
work=$(cd "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat >"$work/gitconfig" <<'EOF'
[user]
  name = Test
  email = test@example.com
[init]
  defaultBranch = main
EOF
export GIT_CONFIG_GLOBAL="$work/gitconfig" GIT_CONFIG_NOSYSTEM=1

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
jqp="" key=""
args=("$@")
for ((i = 0; i < $#; i++)); do [[ ${args[i]} == --jq ]] && jqp=${args[i + 1]}; done
case "$*" in
  "auth status") exit 0 ;;
  "api -i user") cat "$dir/fx/scopes"; exit 0 ;;
  "run list --repo "*" --branch "*) key=runs ;;
  "run view "*" --json jobs"*) key=jobs ;;
  "run view "*" --log") cat "$dir/fx/log"; exit 0 ;;
  "pr list "*"--state all"*) key=prs ;;
  "pr list "*"--state open"*) key=prs ;;
  "run list --repo "*" --commit "*) key=commit-runs ;;
  "api repos/"*"/git/ref/"*)
    ref=${2#repos/*/git/ref/}; grep -qxF "$ref" "$dir/fx/refs" 2>/dev/null; exit ;;
  "pr close "* | "api -X DELETE "*) exit 0 ;;
  *) echo "fake: unexpected gh call: $*" >&2; exit 99 ;;
esac
if [[ -n $jqp ]]; then jq -r "$jqp" "$dir/fx/$key.json"; else cat "$dir/fx/$key.json"; fi
FAKE
chmod +x "$work/bin/gh"

reset() {
  rm -rf "$work/origin.git" "$work/seed" "$work/clone" "$work/calls" "$work/fx"
  mkdir -p "$work/fx"
  printf 'X-Oauth-Scopes: gist, read:org, repo, workflow\r\n' >"$work/fx/scopes"
  git init -q --bare "$work/origin.git"
  git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
  echo hello >"$work/seed/README.md"
  git -C "$work/seed" add README.md
  git -C "$work/seed" commit -qm init
  git -C "$work/seed" push -q origin main
  git clone -q "$work/origin.git" "$work/clone"
}
run() { # args... -> runs the script in the clone; sets code, out, err, calls
  out=$(cd "$work/clone" && printf 'y\n' | PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' \
    "$1" "$code" "$out" "$err" "$calls"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }

# --- usage ------------------------------------------------------------------------------------
reset
run --help
expect_code 0
assert "expected exit codes in --help" contains "$err" "Exit codes:"
run start
expect_code 2
run start 102
expect_code 2

# --- start 101: a branch of origin/main plus the draft workflow, the clone untouched -----------
reset
head_before=$(git -C "$work/clone" rev-parse HEAD)
run start 101
expect_code 0
b=throwaway/101-identities
assert "expected the branch pushed" git -C "$work/origin.git" show-ref -q --verify "refs/heads/$b"
files=$(git -C "$work/origin.git" diff --name-only main "$b")
assert "expected only the workflow added" test "$files" == ".github/workflows/check-101-identities.yml"
assert "expected the draft, byte for byte" \
  test "$(git -C "$work/origin.git" show "$b:.github/workflows/check-101-identities.yml")" == "$(cat "$draft")"
assert "expected the clone's HEAD untouched" test "$(git -C "$work/clone" rev-parse HEAD)" == "$head_before"
assert "expected the clone on main" test "$(git -C "$work/clone" branch --show-current)" == main
assert "expected no leftover worktree" test "$(git -C "$work/clone" worktree list | grep -c .)" -eq 1
assert "expected no closing keyword in the commit" \
  lacks "$(git -C "$work/origin.git" log -1 --format=%B "$b")" "Closes"

# The branch is there now: refused, nothing pushed.
run start 101
expect_code 2
assert "expected the cleanup hint" contains "$err" "cleanup 101"

# --- start 103 without the workflow scope: warns, still pushes (an SSH remote needs none) ----
reset
printf 'X-Oauth-Scopes: gist, read:org, repo\r\n' >"$work/fx/scopes"
run start 103
expect_code 0
assert "expected the scope warning" contains "$err" "gh auth refresh -h github.com -s workflow"
assert "expected the 103 workflow pushed" \
  git -C "$work/origin.git" cat-file -e throwaway/103-claude:.github/workflows/check-103-claude.yml

# --- results: no run, a running one, a finished one -------------------------------------------
reset
echo '[]' >"$work/fx/runs.json"
run results 103
expect_code 3
echo '[{"databaseId":7,"status":"in_progress","conclusion":"","url":"https://example.test/run/7"}]' \
  >"$work/fx/runs.json"
run results 103
expect_code 3
assert "expected the run's state" contains "$err" "run 7 is in_progress"

echo '[{"databaseId":7,"status":"completed","conclusion":"failure","url":"https://example.test/run/7"}]' \
  >"$work/fx/runs.json"
cat >"$work/fx/jobs.json" <<'EOF'
{"jobs":[{"name":"claude (timeout)","conclusion":"cancelled",
  "startedAt":"2026-11-16T10:00:00Z","completedAt":"2026-11-16T10:04:01Z"}]}
EOF
printf '%s\n' \
  $'claude (timeout)\tReport\t2026-11-16T10:00:01.1Z \e[36;1mecho "RESULT check=${{ matrix.check }}"\e[0m' \
  $'claude (timeout)\tReport\t2026-11-16T10:00:02.2Z RESULT subtype=success total_cost_usd=0.012' \
  $'claude (timeout)\tSet up job\t2026-11-16T10:00:00.0Z Runner version 2.330' >"$work/fx/log"
run results 103
expect_code 0
assert "expected the job row with billed minutes" contains "$out" "| claude (timeout) | cancelled | 241 | 5 |"
assert "expected the RESULT line" contains "$out" "claude (timeout): RESULT subtype=success total_cost_usd=0.012"
assert "expected no echoed script line" lacks "$out" "matrix.check"
assert "expected no other log line" lacks "$out" "Runner version"

# --- results 101 also reads the PR, its CI runs and the tag ------------------------------------
echo '[{"databaseId":8,"status":"completed","conclusion":"success","url":"https://example.test/run/8"}]' \
  >"$work/fx/runs.json"
echo '[{"number":42,"headRefOid":"abc123","author":{"login":"app/sunny-factory"},"reviewDecision":"APPROVED","state":"OPEN"}]' \
  >"$work/fx/prs.json"
echo '[{"workflowName":"ci","event":"pull_request","status":"completed","conclusion":"success"}]' \
  >"$work/fx/commit-runs.json"
run results 101
expect_code 0
assert "expected the PR's author and decision" \
  contains "$out" 'PR #42: author `app/sunny-factory`, reviewDecision `APPROVED`'
assert "expected the CI run on its head" contains "$out" "ci (pull_request): completed success"
assert "expected the head commit asked for" contains "$calls" "--commit abc123"
assert "expected the tag absent" contains "$out" 'Tag `v0.0.0-throwaway-101` does not exist.'
echo '[{"number":42,"headRefOid":"abc123","author":{"login":"app/sunny-factory"},"reviewDecision":"","state":"OPEN"}]' \
  >"$work/fx/prs.json"
run results 101
assert "expected an empty decision shown, state kept in place" \
  contains "$out" 'reviewDecision `(empty)`, state `OPEN`'
assert "expected the note on an empty decision" contains "$out" "0 approvals"
echo tags/v0.0.0-throwaway-101 >"$work/fx/refs"
run results 101
assert "expected an existing tag flagged" contains "$out" "EXISTS"

# --- cleanup 101: closes the PR unmerged, deletes the three branches ---------------------------
reset
echo '[{"number":42}]' >"$work/fx/prs.json"
printf '%s\n' heads/throwaway/101-identities heads/throwaway/101-factory-pr >"$work/fx/refs"
run cleanup 101
expect_code 0
assert "expected the PR closed" contains "$calls" "pr close 42 --repo sssoto17/sunny-pastures"
assert "expected no merge" lacks "$calls" "pr merge"
assert "expected the check branch deleted" contains "$calls" "api -X DELETE repos/sssoto17/sunny-pastures/git/refs/heads/throwaway/101-identities"
assert "expected the PR branch deleted" contains "$calls" "git/refs/heads/throwaway/101-factory-pr"
assert "expected a missing branch skipped" lacks "$calls" "DELETE repos/sssoto17/sunny-pastures/git/refs/heads/throwaway/101-readonly-probe"

# Declined: nothing changes.
out=$(cd "$work/clone" && printf 'n\n' | PATH="$work/bin:$PATH" bash "$script" cleanup 103 2>"$work/err")
code=$?
expect_code 2
assert "expected nothing deleted" test "$(grep -c DELETE "$work/calls")" -eq 2

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

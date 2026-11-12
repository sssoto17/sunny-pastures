#!/usr/bin/env bash
# Tests for ci-check.sh through its command line, against throwaway git repos under $TMPDIR: a
# bare "origin" and the admin's clone of it. `gh` is a fake on PATH: it logs its calls, and
# answers reads from fixture files in $work/fx; when the script passes --jq, the fake runs that
# program over the fixture with the real jq, so the script's own jq programs are under test.
# Needs jq. Run: bash scripts/setup/ci-check.test.sh
# shellcheck disable=SC2016 # Markdown backticks in expected output, by design
set -uo pipefail
command -v jq >/dev/null || { echo "ci-check.test: needs jq" >&2; exit 2; }

src="$(cd "$(dirname "$0")" && pwd)"
draft="$src/workflows/check-101-identities.yml"
wf103="$src/../../.github/workflows/check-103-claude.yml" # on main, not a draft
GH_URL=https://github.com/sssoto17/sunny-pastures.git
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
# The test clone's origin is the real URL, as on the admin's machine; git rewrites it to the bare
# repo here, and the git shim below maps it back in `remote get-url`, which the script checks.
printf '[url "%s"]\n  insteadOf = %s\n' "$work/origin.git" "$GH_URL" >>"$work/gitconfig"
export GIT_CONFIG_GLOBAL="$work/gitconfig" GIT_CONFIG_NOSYSTEM=1
export CI_CHECK_RETRY_SECONDS=0 # the pause before gh auth status is retried

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
jqp="" key="" head=""
args=("$@")
for ((i = 0; i < $#; i++)); do
  [[ ${args[i]} == --jq ]] && jqp=${args[i + 1]}
  [[ ${args[i]} == --head ]] && head=${args[i + 1]}
done
case "$*" in
  # Exit codes to answer with, one a call, from fx/auth (then 0): a passing failure, or a real one.
  "auth status -h github.com --active")
    rc=$(head -n1 "$dir/fx/auth" 2>/dev/null)
    tail -n +2 "$dir/fx/auth" >"$dir/fx/auth.rest" 2>/dev/null && mv "$dir/fx/auth.rest" "$dir/fx/auth"
    exit "${rc:-0}" ;;
  "api -i user") cat "$dir/fx/scopes"; exit 0 ;;
  "run list --repo "*" --branch "* | "run list --repo "*" --workflow "*) key=runs ;;
  "run view "*" --json jobs"*) key=jobs ;;
  "run view "*" --log") cat "$dir/fx/log"; exit 0 ;;
  "api repos/"*"/pulls/"*"/reviews"*) key=reviews ;;
  "pr list "*"--state all"*) key=prs ;;
  "pr list "*"--state open"*) key=prs ;;
  "run list --repo "*" --commit "*) key=commit-runs ;;
  "api repos/"*"/git/ref/"*)
    ref=${2#repos/*/git/ref/}; grep -qxF "$ref" "$dir/fx/refs" 2>/dev/null; exit ;;
  "pr create "*) echo "https://github.com/sssoto17/sunny-pastures/pull/77"; exit 0 ;;
  "pr close "* | "api -X DELETE "*) exit 0 ;;
  *) echo "fake: unexpected gh call: $*" >&2; exit 99 ;;
esac
fx=$(cat "$dir/fx/$key.json")
# --head filters PRs on GitHub's side; here against a fixture PR's headRefName.
[[ -n $head ]] && fx=$(jq --arg h "$head" 'map(select(.headRefName == $h))' <<<"$fx")
if [[ -n $jqp ]]; then jq -r "$jqp" <<<"$fx"; else printf '%s\n' "$fx"; fi
FAKE
chmod +x "$work/bin/gh"
# git: the real one, except that `remote get-url` shows the local bare repo as GitHub's URL, as
# the admin's clone would. Any other URL (a pushurl elsewhere, one with a token) shows as itself.
real_git=$(command -v git)
cat >"$work/bin/git" <<FAKE
#!/usr/bin/env bash
if [[ " \$* " == *" remote get-url "* ]]; then
  "$real_git" "\$@" | sed "s|^$work/origin.git\$|$GH_URL|"
  exit "\${PIPESTATUS[0]}"
fi
exec "$real_git" "\$@"
FAKE
chmod +x "$work/bin/git"

reset() {
  rm -rf "$work/origin.git" "$work/seed" "$work/clone" "$work/calls" "$work/fx" \
    "$work/other.git" "$work/other"
  mkdir -p "$work/fx"
  printf 'X-Oauth-Scopes: gist, read:org, repo, workflow\r\n' >"$work/fx/scopes"
  echo '[]' >"$work/fx/reviews.json"
  git init -q --bare "$work/origin.git"
  git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
  echo hello >"$work/seed/README.md"
  # main carries 103's workflow, as on GitHub once its PR is merged; start 103 needs it there.
  mkdir -p "$work/seed/.github/workflows"
  cp "$wf103" "$work/seed/.github/workflows/"
  git -C "$work/seed" add README.md .github
  git -C "$work/seed" commit -qm init
  git -C "$work/seed" push -q origin main
  git clone -q "$GH_URL" "$work/clone"
  install "$work/clone"
  script=$work/clone/scripts/setup/ci-check.sh
}
install() { # repo: copy the script and its drafts into scripts/setup/ there, untracked
  mkdir -p "$1/scripts/setup"
  cp "$src/ci-check.sh" "$1/scripts/setup/"
  cp -r "$src/workflows" "$1/scripts/setup/"
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
run start 104
expect_code 2

# --- gh auth status: only the active github.com account, retried once (#198) ------------------
reset
echo '[]' >"$work/fx/runs.json"
run results 103
assert "expected only the active github.com account checked" \
  contains "$calls" "auth status -h github.com --active"
printf '1\n' >"$work/fx/auth"
: >"$work/calls"
run results 103
expect_code 3
assert "expected a passing failure retried, then on" test "$(grep -c '^auth status' <<<"$calls")" -eq 2
assert "expected no signed-out message after a passing failure" lacks "$err" "signed out"
: >"$work/calls"
printf '1\n1\n' >"$work/fx/auth"
run results 103
expect_code 2
assert "expected the signed-out message after two failures" contains "$err" "gh is signed out"
assert "expected exactly two tries" test "$(grep -c '^auth status' <<<"$calls")" -eq 2
assert "expected nothing else asked of gh" test "$(grep -vc '^auth status' <<<"$calls")" -eq 0

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

# Run from inside another clone, it still works on its own clone: the other repo gets nothing.
reset
git init -q --bare "$work/other.git"
git clone -q "$work/other.git" "$work/other" 2>/dev/null
out=$(cd "$work/other" && PATH="$work/bin:$PATH" bash "$script" start 101 2>"$work/err")
code=$?
expect_code 0
assert "expected the push to the script's own origin" \
  git -C "$work/origin.git" show-ref -q --verify refs/heads/throwaway/101-identities
assert "expected nothing pushed to the other repo" test -z "$(git -C "$work/other.git" for-each-ref)"

# A copy of the script inside a clone whose origin isn't sunny-pastures: refused, nothing pushed.
reset
git init -q --bare "$work/other.git"
git clone -q "$work/other.git" "$work/other" 2>/dev/null
install "$work/other"
out=$(cd "$work/other" && PATH="$work/bin:$PATH" bash "$work/other/scripts/setup/ci-check.sh" start 101 2>"$work/err")
code=$?
err=$(cat "$work/err")
expect_code 2
assert "expected the wrong origin refused" contains "$err" "isn't sssoto17/sunny-pastures on GitHub: nothing pushed"
assert "expected nothing pushed to the other repo" test -z "$(git -C "$work/other.git" for-each-ref)"
assert "expected nothing pushed to sunny-pastures" \
  test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"

# An origin URL carrying a token: refused, and the token is never shown.
reset
git -C "$work/clone" remote set-url origin "https://x-access-token:FAKE_SECRET_$RANDOM@github.com/sssoto17/sunny-pastures.git"
secret=$(git -C "$work/clone" config --get remote.origin.url | sed 's/.*:\(FAKE_SECRET_[0-9]*\)@.*/\1/')
run start 101
expect_code 2
assert "expected the fetch URL refused" contains "$err" "fetch URL of origin"
assert "token in stdout" lacks "$out" "$secret"
assert "token in stderr" lacks "$err" "$secret"
assert "expected no URL printed at all" lacks "$err" "github.com"

# A pushurl that sends the push elsewhere: refused, nothing pushed anywhere.
reset
git init -q --bare "$work/other.git"
git -C "$work/clone" config remote.origin.pushurl "$work/other.git"
run start 101
expect_code 2
assert "expected the push URL refused" contains "$err" "push URL of origin"
assert "expected nothing pushed to the pushurl" test -z "$(git -C "$work/other.git" for-each-ref)"
assert "expected nothing pushed to sunny-pastures" \
  test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"

# Two push URLs, the official one first and a foreign one second: git would push to both. Refused.
reset
git init -q --bare "$work/other.git"
git -C "$work/clone" config --add remote.origin.pushurl "$GH_URL"
git -C "$work/clone" config --add remote.origin.pushurl "$work/other.git"
run start 101
expect_code 2
assert "expected the second push URL refused" contains "$err" "a push URL of origin"
assert "expected nothing pushed to the second pushurl" test -z "$(git -C "$work/other.git" for-each-ref)"
assert "expected nothing pushed to sunny-pastures" \
  test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"
assert "expected no URL printed" lacks "$err" "$work/other.git"

# Two URLs (no pushurl, so both are push URLs too), the official one first: refused.
reset
git init -q --bare "$work/other.git"
git -C "$work/clone" config --add remote.origin.url "$work/other.git"
run start 101
expect_code 2
assert "expected the second URL refused" contains "$err" "a fetch URL of origin"
assert "expected nothing pushed to the second url" test -z "$(git -C "$work/other.git" for-each-ref)"
assert "expected nothing pushed to sunny-pastures" \
  test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"
assert "expected no URL printed" lacks "$err" "$work/other.git"

# A pushInsteadOf rewrite does the same through config: refused.
reset
git init -q --bare "$work/other.git"
git -C "$work/clone" config "url.$work/other.git.pushInsteadOf" "$GH_URL"
run start 101
expect_code 2
assert "expected the rewritten push URL refused" contains "$err" "push URL of origin"
assert "expected nothing pushed to the rewrite" test -z "$(git -C "$work/other.git" for-each-ref)"

# Config that applies only in linked worktrees (#198): a pushurl that the clone itself doesn't
# show. The push runs in a worktree, so the check runs there too: refused, nothing pushed, and
# no URL printed. A linked worktree's gitdir is <clone>/.git/worktrees/<name>; the clone's isn't.
for issue in 101 103; do
  reset
  git init -q --bare "$work/other.git"
  printf '[remote "origin"]\n  pushurl = %s\n' "$work/other.git" >"$work/wt-only.gitconfig"
  cp "$work/gitconfig" "$work/gitconfig.saved"
  printf '[includeIf "gitdir:**/worktrees/**"]\n  path = %s\n' "$work/wt-only.gitconfig" >>"$work/gitconfig"
  assert "expected the clone itself to show only the official push URL" \
    test "$(PATH="$work/bin:$PATH" git -C "$work/clone" remote get-url --push --all origin)" == "$GH_URL"
  run start "$issue"
  mv "$work/gitconfig.saved" "$work/gitconfig"
  expect_code 2
  assert "expected the worktree's push URL refused ($issue)" contains "$err" "push URL of origin in the worktree"
  assert "expected nothing pushed to the foreign pushurl ($issue)" test -z "$(git -C "$work/other.git" for-each-ref)"
  assert "expected no throwaway branch on origin ($issue)" \
    test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"
  assert "expected no foreign URL printed ($issue)" lacks "$out$err" "$work/other.git"
  assert "expected no GitHub URL printed ($issue)" lacks "$out$err" "github.com/sssoto17"
  assert "expected no PR opened ($issue)" lacks "$calls" "pr create"
  assert "expected no leftover worktree ($issue)" test "$(git -C "$work/clone" worktree list | grep -c .)" -eq 1
done

# The branch is there now: refused, nothing pushed.
reset
run start 101
run start 101
expect_code 2
assert "expected the cleanup hint" contains "$err" "cleanup 101"

# --- without the workflow scope: start 101 warns and still pushes (an SSH remote needs none) ---
# start 103 pushes no workflow file, so it doesn't ask about scopes at all.
reset
printf 'X-Oauth-Scopes: gist, read:org, repo\r\n' >"$work/fx/scopes"
run start 101
expect_code 0
assert "expected the scope warning" contains "$err" "gh auth refresh -h github.com -s workflow"
assert "expected the 101 workflow pushed" \
  git -C "$work/origin.git" cat-file -e throwaway/101-identities:.github/workflows/check-101-identities.yml
reset
printf 'X-Oauth-Scopes: gist, read:org, repo\r\n' >"$work/fx/scopes"
run start 103
expect_code 0
assert "expected no scope warning for 103" lacks "$err" "workflow scope"
assert "expected no scope lookup for 103" lacks "$calls" "api -i user"

# --- start 103: a base branch with the marker hooks, a head on it, and the PR -----------------
# The workflow runs from main on pull_request_target; the action restores .claude/ from the PR's
# base branch, so the markers live on the base. The head only adds a text file, for a diff.
reset
run start 103
expect_code 0
base=throwaway/103-base head=throwaway/103-claude
assert "expected the base branch pushed" git -C "$work/origin.git" show-ref -q --verify "refs/heads/$base"
assert "expected only .claude/settings.json on the base" \
  test "$(git -C "$work/origin.git" diff --name-only main "$base")" == ".claude/settings.json"
hooks=$(git -C "$work/origin.git" show "$base:.claude/settings.json" |
  jq -r '[.hooks.SessionStart[].hooks[].command, .hooks.UserPromptSubmit[].hooks[].command] | join("|")')
assert "expected both marker hooks on the base" \
  test "$hooks" == 'echo SessionStart >> "$RUNNER_TEMP/hook-marker"|echo UserPromptSubmit >> "$RUNNER_TEMP/hook-marker"'
assert "expected the head to add only its text file" \
  test "$(git -C "$work/origin.git" diff --name-only "$base" "$head")" == "throwaway-103.md"
assert "expected main's workflow on both branches, unchanged" \
  test -z "$(git -C "$work/origin.git" diff --name-only main "$head" -- .github)"
assert "expected the PR opened from the check branch onto the base" \
  contains "$calls" "pr create --repo sssoto17/sunny-pastures --base $base --head $head"
assert "expected the PR number printed" contains "$out" "PR #77"
assert "expected the run list hint by workflow and event" \
  contains "$out" "gh run list --repo sssoto17/sunny-pastures --workflow check-103-claude.yml --event pull_request_target"
assert "expected no URL printed" lacks "$out" "https://"
assert "expected no leftover worktree" test "$(git -C "$work/clone" worktree list | grep -c .)" -eq 1

# The repo's own settings stay: the markers are added beside its hooks.
reset
mkdir -p "$work/seed/.claude"
echo '{"permissions":{"allow":["Bash(ls)"]},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"true"}]}]}}' \
  >"$work/seed/.claude/settings.json"
git -C "$work/seed" add .claude && git -C "$work/seed" commit -qm settings && git -C "$work/seed" push -q origin main
run start 103
expect_code 0
settings=$(git -C "$work/origin.git" show throwaway/103-base:.claude/settings.json)
assert "expected the repo's permissions kept" test "$(jq -r '.permissions.allow[0]' <<<"$settings")" == "Bash(ls)"
assert "expected the repo's hook kept, the marker after it" \
  test "$(jq -r '[.hooks.SessionStart[].hooks[].command] | join("|")' <<<"$settings")" == \
  'true|echo SessionStart >> "$RUNNER_TEMP/hook-marker"'

# A leftover base branch: refused before anything is pushed.
reset
git -C "$work/seed" push -q origin main:refs/heads/throwaway/103-base
run start 103
expect_code 2
assert "expected the cleanup hint" contains "$err" "cleanup 103"
assert "expected no check branch pushed" test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway/103-claude)"
assert "expected no PR opened" lacks "$calls" "pr create"

# Before 103's workflow is merged, start 103 would open a PR that runs nothing: refused first.
reset
git -C "$work/seed" rm -q .github/workflows/check-103-claude.yml
git -C "$work/seed" commit -qm "no 103 workflow" && git -C "$work/seed" push -q origin main
run start 103
expect_code 2
assert "expected the merge hint" contains "$err" "check-103-claude.yml isn't on main yet"
assert "expected nothing pushed" test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"
assert "expected no PR opened" lacks "$calls" "pr create"

# 103's workflow (no harness runs the YAML). It lives on main, so it runs on pull_request_target
# (the action has no push event; a pull_request run's refs/pull/N/merge is refused by the factory
# environment), only for our own head onto the base; it checks out no PR code, never asks for an
# OIDC token, and reads the action's output.
assert "expected no 103 draft left beside the others" test ! -e "$src/workflows/check-103-claude.yml"
wf=$(cat "$wf103")
assert "expected a pull_request_target trigger onto the base branch only" contains "$wf" \
  $'on:\n  pull_request_target:\n    types: [opened, synchronize, reopened]\n    branches: [throwaway/103-base]'
assert "expected no pull_request trigger" lacks "$wf" $'\n  pull_request:'
assert "expected no push trigger" lacks "$wf" $'\n  push:'
assert "expected the job guarded to the base" contains "$wf" "github.event.pull_request.base.ref == 'throwaway/103-base' &&"
assert "expected the job guarded to the head" contains "$wf" "github.event.pull_request.head.ref == 'throwaway/103-claude' &&"
assert "expected the job guarded to this repo's head" \
  contains "$wf" "github.event.pull_request.head.repo.full_name == github.repository"
assert "expected nothing checked out by ref (the default branch only)" lacks "$wf" "ref:"
assert "expected no PR head sha anywhere" lacks "$wf" "head.sha"
assert "expected the head ref never expanded into a step" lacks "$wf" "github.head_ref"
assert "expected the checkout without credentials" contains "$wf" "persist-credentials: false"
assert "expected no API key" contains "$wf" "ANTHROPIC_API_KEY: ''"
assert "expected the token handed over, so no OIDC exchange" contains "$wf" 'github_token: ${{ github.token }}'
assert "expected no id-token permission" lacks "$wf" "id-token"
assert "expected only contents: read" contains "$wf" $'permissions:\n  contents: read'
assert "expected nothing granted beyond it" \
  test "$(sed -n '/^permissions:/,/^$/p' <<<"$wf" | grep -c ':')" -eq 2
assert "expected one permissions block" test "$(grep -c 'permissions:' <<<"$wf")" -eq 1
assert "expected the execution file from the action's output" \
  contains "$wf" '${{ steps.claude.outputs.execution_file }}'
assert "expected no marker edit in the checkout (the action undoes it)" lacks "$wf" "hooks.SessionStart"
assert "expected the removal note" contains "$wf" "# REMOVAL:"

# --- start 101 and 102 push only: no PR from the admin's gh ----------------------------------
reset
run start 101
assert "expected no PR opened by start 101" lacks "$calls" "pr create"

# --- start 102: its own branch and workflow ----------------------------------------------------
reset
run start 102
expect_code 0
assert "expected no PR opened by start 102" lacks "$calls" "pr create"
assert "expected the 102 workflow pushed" \
  git -C "$work/origin.git" cat-file -e throwaway/102-project:.github/workflows/check-102-project.yml

# --- results: no run, a running one, a finished one -------------------------------------------
reset
echo '[]' >"$work/fx/runs.json"
run results 103
expect_code 3
echo '[{"databaseId":7,"workflowName":"check-103-claude","status":"in_progress","conclusion":"","url":"https://example.test/run/7"}]' \
  >"$work/fx/runs.json"
run results 103
expect_code 3
assert "expected the run's state" contains "$err" "run 7 is in_progress"

echo '[{"databaseId":7,"workflowName":"check-103-claude","status":"completed","conclusion":"failure","url":"https://example.test/run/7"}]' \
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

# On the throwaway PR, ci and Labeler run too, and may be newer: results reads the check's own
# run. 103's runs are pull_request_target runs of a workflow on main: listed by workflow and event.
cat >"$work/fx/runs.json" <<'EOF'
[{"databaseId":11,"workflowName":"ci","status":"in_progress","conclusion":"","url":"https://example.test/run/11"},
 {"databaseId":10,"workflowName":"Labeler","status":"completed","conclusion":"success","url":"https://example.test/run/10"},
 {"databaseId":7,"workflowName":"check-103-claude","status":"completed","conclusion":"failure","url":"https://example.test/run/7"}]
EOF
: >"$work/calls"
run results 103
expect_code 0
assert "expected the check-103 run, not a newer ci run" contains "$out" "Run: https://example.test/run/7"
assert "expected the runs' workflow names asked for" contains "$calls" "workflowName"
assert "expected 103's runs listed by workflow and event" \
  contains "$calls" "run list --repo sssoto17/sunny-pastures --workflow check-103-claude.yml --event pull_request_target"
assert "expected 103's runs not listed by branch" lacks "$calls" "--branch throwaway/103-claude"

# --- results 101 also reads the PR, its CI runs and the tag ------------------------------------
echo '[{"databaseId":8,"workflowName":"check-101-identities","status":"completed","conclusion":"success","url":"https://example.test/run/8"}]' \
  >"$work/fx/runs.json"
echo '[{"number":42,"headRefName":"throwaway/101-factory-pr","headRefOid":"abc123","author":{"login":"app/sunny-factory"},"reviewDecision":"APPROVED","state":"OPEN"}]' \
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
echo '[{"number":42,"headRefName":"throwaway/101-factory-pr","headRefOid":"abc123","author":{"login":"app/sunny-factory"},"reviewDecision":"","state":"OPEN"}]' \
  >"$work/fx/prs.json"
run results 101
assert "expected an empty decision shown, state kept in place" \
  contains "$out" 'reviewDecision `(empty)`, state `OPEN`'
assert "expected the note on an empty decision" contains "$out" "0 approvals"
# PR #199 (11 Nov): the App's APPROVE, then its file comment, which GitHub records as a second
# review, COMMENTED. latestReviews showed only the COMMENTED one; results reports the approval.
cat >"$work/fx/reviews.json" <<'EOF'
[{"user":{"login":"sunny-reviewer[bot]"},"state":"APPROVED","submitted_at":"2026-11-11T23:10:39Z"},
 {"user":{"login":"sunny-reviewer[bot]"},"state":"COMMENTED","submitted_at":"2026-11-11T23:10:40Z"}]
EOF
: >"$work/calls"
run results 101
assert "expected the PR's reviews read back" contains "$calls" "api repos/sssoto17/sunny-pastures/pulls/42/reviews"
assert "expected the App's approval reported" contains "$out" 'Approved by `sunny-reviewer[bot]`.'
assert "expected every review of the App, in order" \
  contains "$out" '`sunny-reviewer[bot]`: APPROVED, COMMENTED'
echo '[{"user":{"login":"sunny-reviewer[bot]"},"state":"COMMENTED","submitted_at":"2026-11-11T23:10:40Z"}]' \
  >"$work/fx/reviews.json"
run results 101
assert "expected a missing approval said plainly" contains "$out" "Approved by nobody."
echo tags/v0.0.0-throwaway-101 >"$work/fx/refs"
run results 101
assert "expected an existing tag flagged" contains "$out" "EXISTS"

# The draft's reviewer job (no harness runs the YAML): it reads its approval back by the id the
# POST returned, never as the App's latest review, which its own file comment replaces.
reviewer_job=$(sed -n '/^  reviewer:/,/^  [a-z-]*:$/p' "$draft")
assert "expected the approval's id kept" contains "$reviewer_job" 'approval=$(gh api -X POST "$r/pulls/$PR/reviews" -f event=APPROVE --jq .id'
assert "expected the approval read back by its id" contains "$reviewer_job" '"$r/pulls/$PR/reviews/$approval"'
assert "expected no latestReviews in the reviewer job" lacks "$reviewer_job" "latestReviews"
assert "expected review_decision still reported" contains "$reviewer_job" "RESULT review_decision="

# --- results 102 adds what to do next, and never suggests the repo scope as a way out ----------
echo '[{"databaseId":9,"workflowName":"check-102-project","status":"completed","conclusion":"success","url":"https://example.test/run/9"}]' \
  >"$work/fx/runs.json"
run results 102
expect_code 0
assert "expected the fallback named" contains "$out" "ci-project.sh --fine-grained"
assert "expected the stop rule" contains "$out" "Bring the alternatives back to the admin"
assert "expected repo only as a never" contains "$out" "Never widen a classic token to the repo scope"

pr101='{"number":42,"headRefName":"throwaway/101-factory-pr","isCrossRepository":false}' # #101's PR, open in the cleanup tests

# --- cleanup 101: closes the PR unmerged, deletes the three branches ---------------------------
reset
echo "[$pr101]" >"$work/fx/prs.json"
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

# --- cleanup 103: closes its own PR unmerged, deletes its two branches, never touches #101's ------
all_branches() {
  printf 'heads/%s\n' throwaway/101-identities throwaway/101-factory-pr throwaway/101-readonly-probe \
    throwaway/102-project throwaway/103-base throwaway/103-claude >"$work/fx/refs"
}
reset
# A fork's PR with the same head name, newer: never ours to close.
echo "[$pr101, {\"number\":78,\"headRefName\":\"throwaway/103-claude\",\"isCrossRepository\":true},
  {\"number\":77,\"headRefName\":\"throwaway/103-claude\",\"isCrossRepository\":false}]" >"$work/fx/prs.json"
all_branches
run cleanup 103
expect_code 0
assert "expected 103's PR looked up by its head" contains "$calls" "pr list --repo sssoto17/sunny-pastures --head throwaway/103-claude --state open"
assert "expected 103's PR closed with a comment" contains "$calls" "pr close 77 --repo sssoto17/sunny-pastures --comment"
assert "expected #101's PR left open" lacks "$calls" "pr close 42"
assert "expected a fork's PR with the same head name left alone" lacks "$calls" "pr close 78"
assert "expected #101's PR not even looked up" lacks "$calls" "--head throwaway/101-factory-pr"
assert "expected no merge" lacks "$calls" "pr merge"
assert "expected the check branch deleted" contains "$calls" "api -X DELETE repos/sssoto17/sunny-pastures/git/refs/heads/throwaway/103-claude"
assert "expected the base branch deleted" contains "$calls" "api -X DELETE repos/sssoto17/sunny-pastures/git/refs/heads/throwaway/103-base"
assert "expected only those two deleted" test "$(grep -c 'api -X DELETE' <<<"$calls")" -eq 2
assert "expected the PR closed before its base is deleted" \
  test "$(grep -n 'pr close' <<<"$calls" | cut -d: -f1)" -lt "$(grep -n 'DELETE.*103-base' <<<"$calls" | cut -d: -f1)"
assert "expected the closed PR reported" contains "$out" "closed PR #77 unmerged"

# No PR (start failed before opening it, or it's closed already): still deletes both branches.
reset
echo "[$pr101]" >"$work/fx/prs.json"
all_branches
run cleanup 103
expect_code 0
assert "expected no PR closed" lacks "$calls" "pr close"
assert "expected the check branch deleted" contains "$calls" "git/refs/heads/throwaway/103-claude"
assert "expected the base branch deleted" contains "$calls" "git/refs/heads/throwaway/103-base"

# cleanup 102 likewise deletes only throwaway/102-project.
reset
echo "[$pr101]" >"$work/fx/prs.json"
all_branches
run cleanup 102
expect_code 0
assert "expected 102's branch deleted" contains "$calls" "git/refs/heads/throwaway/102-project"
assert "expected one deletion only" test "$(grep -c 'api -X DELETE' <<<"$calls")" -eq 1
assert "expected #101's PR left open" lacks "$calls" "pr close"
assert "expected no PR looked up" lacks "$calls" "pr list"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

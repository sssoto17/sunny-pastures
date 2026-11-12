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
jqp="" key="" head="" pr=""
args=("$@")
for ((i = 0; i < $#; i++)); do
  [[ ${args[i]} == --jq ]] && jqp=${args[i + 1]}
  [[ ${args[i]} == --head ]] && head=${args[i + 1]}
  [[ ${args[i]} == pr=* ]] && pr=${args[i]#pr=}
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
  "api repos/"*"/pulls/"*"/reviews"*)
    n=${2#repos/*/pulls/}; n=${n%%/*}; key=reviews; [[ -f $dir/fx/reviews-$n.json ]] && key=reviews-$n ;;
  "api repos/sssoto17/sunny-pastures --jq .allow_auto_merge")
    [[ -f $dir/fx/auto-fail ]] && exit 1; cat "$dir/fx/auto" 2>/dev/null || echo false; exit 0 ;;
  "api repos/sssoto17/sunny-pastures/labels/throwaway --silent") [[ -f $dir/fx/label ]]; exit ;;
  "api -X POST repos/"*"/comments "* | "pr ready "*) exit 0 ;;
  "pr view "*" --json "*) key=view-$3 ;;
  "api repos/sssoto17/sunny-pastures/rules/branches/main --jq "*) key=rules ;;
  "api graphql "*) key=threads-$pr ;;
  "pr list "*"--state all"*) key=prs ;;
  "pr list "*"--state open"*) key=prs ;;
  "run list --repo "*" --commit "*) key=commit-runs ;;
  "api repos/"*"/git/ref/"*)
    ref=${2#repos/*/git/ref/}; grep -qxF "$ref" "$dir/fx/refs" 2>/dev/null; exit ;;
  "pr create "*) n=$(($(grep -c '^pr create' "$dir/calls") + 70)); echo "https://github.com/sssoto17/sunny-pastures/pull/$n"; exit 0 ;;
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
  echo '[{"type":"pull_request","parameters":{"required_review_thread_resolution":true,
    "required_approving_review_count":1,"dismiss_stale_reviews_on_push":true}}]' >"$work/fx/rules.json"
  git init -q --bare "$work/origin.git"
  git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
  echo hello >"$work/seed/README.md"
  mkdir -p "$work/seed/packages/sim/src/content"
  printf '# Sunny Pastures\n\nRules.\n' >"$work/seed/AGENTS.md"
  printf 'export const content = {};\n' >"$work/seed/packages/sim/src/content/index.ts"
  git -C "$work/seed" add README.md AGENTS.md packages
  git -C "$work/seed" commit -qm init
  git -C "$work/seed" push -q origin main
  git clone -q "$GH_URL" "$work/clone"
  install "$work/clone"
  script=$work/clone/scripts/setup/ci-check.sh
}
install() { # repo: copy the script and its drafts into scripts/setup/ there, untracked
  mkdir -p "$1/scripts/setup"
  cp "$src/ci-check.sh" "$src/ci-check-68.sh" "$1/scripts/setup/"
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
# 103's check ran on 12 Nov and its workflow is gone from main (#227): no longer a target.
for c in start results cleanup; do
  run "$c" 103
  expect_code 2
  assert "expected usage for $c 103" contains "$err" "usage:"
done
assert "expected 103 gone from the usage" lacks "$err" "103"

# --- gh auth status: only the active github.com account, retried once (#198) ------------------
reset
echo '[]' >"$work/fx/runs.json"
run results 102
assert "expected only the active github.com account checked" \
  contains "$calls" "auth status -h github.com --active"
printf '1\n' >"$work/fx/auth"
: >"$work/calls"
run results 102
expect_code 3
assert "expected a passing failure retried, then on" test "$(grep -c '^auth status' <<<"$calls")" -eq 2
assert "expected no signed-out message after a passing failure" lacks "$err" "signed out"
: >"$work/calls"
printf '1\n1\n' >"$work/fx/auth"
run results 102
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
for issue in 101 102; do
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
reset
printf 'X-Oauth-Scopes: gist, read:org, repo\r\n' >"$work/fx/scopes"
run start 101
expect_code 0
assert "expected the scope warning" contains "$err" "gh auth refresh -h github.com -s workflow"
assert "expected the 101 workflow pushed" \
  git -C "$work/origin.git" cat-file -e throwaway/101-identities:.github/workflows/check-101-identities.yml
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
run results 102
expect_code 3
echo '[{"databaseId":7,"workflowName":"check-102-project","status":"in_progress","conclusion":"","url":"https://example.test/run/7"}]' \
  >"$work/fx/runs.json"
run results 102
expect_code 3
assert "expected the run's state" contains "$err" "run 7 is in_progress"

echo '[{"databaseId":7,"workflowName":"check-102-project","status":"completed","conclusion":"failure","url":"https://example.test/run/7"}]' \
  >"$work/fx/runs.json"
cat >"$work/fx/jobs.json" <<'EOF'
{"jobs":[{"name":"pat","conclusion":"cancelled",
  "startedAt":"2026-11-16T10:00:00Z","completedAt":"2026-11-16T10:04:01Z"}]}
EOF
printf '%s\n' \
  $'pat\tReport\t2026-11-16T10:00:01.1Z \e[36;1mecho "RESULT check=${{ matrix.check }}"\e[0m' \
  $'pat\tReport\t2026-11-16T10:00:02.2Z RESULT readable=yes total=3' \
  $'pat\tSet up job\t2026-11-16T10:00:00.0Z Runner version 2.330' >"$work/fx/log"
run results 102
expect_code 0
assert "expected the job row with billed minutes" contains "$out" "| pat | cancelled | 241 | 5 |"
assert "expected the RESULT line" contains "$out" "pat: RESULT readable=yes total=3"
assert "expected no echoed script line" lacks "$out" "matrix.check"
assert "expected no other log line" lacks "$out" "Runner version"

# On the throwaway branch, ci and Labeler run too, and may be newer: results reads the check's own
# run, listed by its branch and picked by its workflow's name.
cat >"$work/fx/runs.json" <<'EOF'
[{"databaseId":11,"workflowName":"ci","status":"in_progress","conclusion":"","url":"https://example.test/run/11"},
 {"databaseId":10,"workflowName":"Labeler","status":"completed","conclusion":"success","url":"https://example.test/run/10"},
 {"databaseId":7,"workflowName":"check-102-project","status":"completed","conclusion":"failure","url":"https://example.test/run/7"}]
EOF
: >"$work/calls"
run results 102
expect_code 0
assert "expected the check-102 run, not a newer ci run" contains "$out" "Run: https://example.test/run/7"
assert "expected the runs' workflow names asked for" contains "$calls" "workflowName"
assert "expected 102's runs listed by branch" \
  contains "$calls" "run list --repo sssoto17/sunny-pastures --branch throwaway/102-project"
assert "expected no --workflow lookup" lacks "$calls" "--workflow"

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
out=$(cd "$work/clone" && printf 'n\n' | PATH="$work/bin:$PATH" bash "$script" cleanup 102 2>"$work/err")
code=$?
expect_code 2
assert "expected nothing deleted" test "$(grep -c DELETE "$work/calls")" -eq 2

all_branches() {
  printf 'heads/%s\n' throwaway/101-identities throwaway/101-factory-pr throwaway/101-readonly-probe \
    throwaway/102-project >"$work/fx/refs"
}
# A fork's PR with the same head name, newer: never ours to close.
reset
echo "[{\"number\":43,\"headRefName\":\"throwaway/101-factory-pr\",\"isCrossRepository\":true}, $pr101]" \
  >"$work/fx/prs.json"
all_branches
run cleanup 101
expect_code 0
assert "expected the PR looked up by its head" contains "$calls" "pr list --repo sssoto17/sunny-pastures --head throwaway/101-factory-pr --state open"
assert "expected our PR closed with a comment" contains "$calls" "pr close 42 --repo sssoto17/sunny-pastures --comment"
assert "expected a fork's PR with the same head name left alone" lacks "$calls" "pr close 43"
assert "expected the PR closed before any branch is deleted" \
  test "$(grep -n 'pr close' <<<"$calls" | cut -d: -f1)" -lt "$(grep -n 'DELETE' <<<"$calls" | head -n1 | cut -d: -f1)"
assert "expected the closed PR reported" contains "$out" "closed PR #42 unmerged"
assert "expected 102's branch left alone" lacks "$calls" "throwaway/102-project"

# No PR (closed already): still deletes the branches.
reset
echo '[]' >"$work/fx/prs.json"
all_branches
run cleanup 101
expect_code 0
assert "expected no PR closed" lacks "$calls" "pr close"
assert "expected the three branches deleted" test "$(grep -c 'api -X DELETE' <<<"$calls")" -eq 3

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

# === #68: the reviewer App's tests (a)-(f) ======================================================
for args in "push 68" "push 68 b" "push 101 a" "resolve 101" "start 68 a" "results 68 a"; do
  reset
  # shellcheck disable=SC2086 # split on purpose
  run $args
  expect_code 2
  assert "expected usage for $args" contains "$err" "usage:"
done

# --- start 68 runs with allow_auto_merge off: (a) is approved first, (b) waits for push 68 a ---
reset
run start 68
expect_code 0
assert "expected the PRs opened with the setting off" test "$(grep -c '^pr create' <<<"$calls")" -eq 4
assert "expected the next step named" contains "$out" "once (a) reads APPROVED"
assert "expected the setting never changed" lacks "$calls" "PATCH"

# Without thread resolution on main, a hold thread wouldn't hold: refused, nothing opened.
reset
echo '[{"type":"pull_request","parameters":{"required_review_thread_resolution":false,
  "required_approving_review_count":1,"dismiss_stale_reviews_on_push":true}}]' >"$work/fx/rules.json"
run start 68
expect_code 2
assert "expected main's rules named" contains "$err" "main's rules lack thread resolution"
assert "expected nothing pushed" test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"
assert "expected no PR opened" lacks "$calls" "pr create"

# --- start 68: one branch and one draft PR per test, held, then marked ready -------------------
reset
head_before=$(git -C "$work/clone" rev-parse HEAD)
run start 68
expect_code 0
want_a=docs/spikes/reviewer-app/throwaway-a.md want_c=docs/spikes/reviewer-app/throwaway-c.md
want_e=packages/sim/src/content/index.ts want_f=AGENTS.md
for l in a c e f; do
  b=throwaway/68-$l
  want=want_$l
  assert "expected $b pushed" git -C "$work/origin.git" show-ref -q --verify "refs/heads/$b"
  assert "expected only ${!want} changed on $b" \
    test "$(git -C "$work/origin.git" diff --name-only main "$b")" == "${!want}"
  assert "expected a PR from $b onto main, as a draft" contains "$calls" "--base main --head $b --draft"
  assert "expected the title of ($l)" contains "$calls" "--title THROWAWAY #68 ($l):"
done
assert "expected never merge in the body" contains "$calls" "**Never merge**"
assert "expected the PR linked to #68" contains "$calls" "Part of #68"
assert "expected the body to say it's a throwaway test PR" contains "$calls" "a throwaway test PR for #68 step 4"
assert "expected no label when throwaway doesn't exist" lacks "$calls" "--label"
assert "expected a one-line change in AGENTS.md" \
  test "$(git -C "$work/origin.git" diff --numstat main throwaway/68-f | cut -f1,2)" == $'1\t1'
assert "expected one added comment line in the content" \
  test "$(git -C "$work/origin.git" diff --numstat main throwaway/68-e | cut -f1,2)" == $'1\t0'
assert "expected (c)'s defect: a bare supabase status" \
  contains "$(git -C "$work/origin.git" show "throwaway/68-c:$want_c")" '`supabase status`'
for l in a c e f; do
  added=$(git -C "$work/origin.git" diff main "throwaway/68-$l" | grep '^+[^+]')
  assert "expected no words aimed at the reviewer in ($l)" lacks "${added,,}" "review"
  assert "expected no approval asked for in ($l)" lacks "${added,,}" "approv"
done
# Hold threads on (a) and (c), each before its PR is marked ready; none on (e) or (f).
assert "expected two hold threads" test "$(grep -c '/comments ' <<<"$calls")" -eq 2
assert "expected (a)'s hold thread on its file" contains "$calls" "pulls/71/comments --silent"
assert "expected (a) held before it is ready" \
  test "$(grep -n 'pulls/71/comments' <<<"$calls" | cut -d: -f1)" -lt "$(grep -n 'pr ready 71' <<<"$calls" | cut -d: -f1)"
assert "expected (c) held before it is ready" \
  test "$(grep -n 'pulls/72/comments' <<<"$calls" | cut -d: -f1)" -lt "$(grep -n 'pr ready 72' <<<"$calls" | cut -d: -f1)"
assert "expected no hold on (e) or (f)" lacks "$calls" "pulls/73/comments"
assert "expected all four marked ready" test "$(grep -c '^pr ready' <<<"$calls")" -eq 4
assert "expected the PRs reported" contains "$out" "test (f): opened PR #74"
assert "expected the clone's HEAD untouched" test "$(git -C "$work/clone" rev-parse HEAD)" == "$head_before"
assert "expected no leftover worktree" test "$(git -C "$work/clone" worktree list | grep -c .)" -eq 1
assert "expected no merge" lacks "$calls" "pr merge"

# Again, with the branches there: refused before anything is pushed or opened.
: >"$work/calls"
run start 68
expect_code 2
assert "expected the cleanup hint" contains "$err" "cleanup 68 first"
assert "expected no PR opened" lacks "$calls" "pr create"

# An existing throwaway label is added; a wrong origin is refused.
reset
: >"$work/fx/label"
run start 68
assert "expected the existing label added" contains "$calls" "--draft --label throwaway --title"
reset
git -C "$work/clone" remote set-url origin "https://x-access-token:FAKE_SECRET_68@github.com/sssoto17/sunny-pastures.git"
run start 68
expect_code 2
assert "expected the token URL refused" contains "$err" "fetch URL of origin"
assert "token printed" lacks "$out$err" "FAKE_SECRET_68"
assert "expected nothing pushed" test -z "$(git -C "$work/origin.git" for-each-ref refs/heads/throwaway)"

# --- push 68 a (test d) and push 68 e: one more commit each ------------------------------------
reset
run start 68
echo '[{"number":71,"headRefName":"throwaway/68-a","isCrossRepository":false}]' >"$work/fx/prs.json"
echo '{"reviewDecision":"REVIEW_REQUIRED"}' >"$work/fx/view-71.json"
export CI_CHECK_WAIT_SECONDS=0
# (b) runs on the fresh approval after this push: refused while allow_auto_merge is off.
echo false >"$work/fx/auto"
run push 68 a
expect_code 2
assert "expected the setting named" contains "$err" "allow_auto_merge is off"
assert "expected the command to turn it on" contains "$err" "-F allow_auto_merge=true"
assert "expected nothing pushed" test "$(git -C "$work/origin.git" rev-list --count main..throwaway/68-a)" -eq 1
# (d) needs an approval to dismiss: refused until the App's latest review of (a) is APPROVED.
echo true >"$work/fx/auto"
echo '[{"user":{"login":"sunny-reviewer[bot]"},"state":"COMMENTED"}]' >"$work/fx/reviews-71.json"
run push 68 a
expect_code 2
assert "expected (a)'s approval asked for" contains "$err" "(a) isn't approved by sunny-reviewer yet"
assert "expected nothing pushed" test "$(git -C "$work/origin.git" rev-list --count main..throwaway/68-a)" -eq 1
echo '[{"user":{"login":"sunny-reviewer[bot]"},"state":"APPROVED"}]' >"$work/fx/reviews-71.json"
run push 68 a
expect_code 0
assert "expected one more commit on (a)" test "$(git -C "$work/origin.git" rev-list --count main..throwaway/68-a)" -eq 2
assert "expected the note appended" \
  contains "$(git -C "$work/origin.git" show "throwaway/68-a:$want_a")" "pushed by ci-check.sh push 68 a"
assert "expected the decision after the push" contains "$out" 'reviewDecision right after the push: `REVIEW_REQUIRED`'
run push 68 e
expect_code 0
assert "expected (e) to gain a note file" \
  test "$(git -C "$work/origin.git" diff --name-only main throwaway/68-e | sort | tr '\n' ' ')" == \
  "docs/spikes/reviewer-app/throwaway-e.md packages/sim/src/content/index.ts "
assert "expected no decision read for (e)" lacks "$out" "reviewDecision"

# --- resolve 68: pushes the factory's workflow on its own branch, no PR -------------------------
src_wf="$src/workflows/check-68-factory-resolve.yml"
reset
run resolve 68
expect_code 0
b=throwaway/68-factory-resolve
assert "expected only the workflow added" \
  test "$(git -C "$work/origin.git" diff --name-only main "$b")" == ".github/workflows/check-68-factory-resolve.yml"
assert "expected the draft, byte for byte" \
  test "$(git -C "$work/origin.git" show "$b:.github/workflows/check-68-factory-resolve.yml")" == "$(cat "$src_wf")"
assert "expected no PR opened" lacks "$calls" "pr create"
assert "expected the workflow to run in factory, on its throwaway branch only" \
  contains "$(cat "$src_wf")" $'    branches: [throwaway/68-factory-resolve]'
assert "expected the factory environment" contains "$(cat "$src_wf")" "environment: factory"
assert "expected it to fail unless the reviewer reopened the thread" \
  contains "$(cat "$src_wf")" '[ "$resolved" = false ]'

# --- results 68 ---------------------------------------------------------------------------------
fx_view() { # pr decision state auto commits [labels] [head author]
  cat >"$work/fx/view-$1.json" <<J
{"number":$1,"url":"https://example.test/pull/$1","state":"OPEN","headRefOid":"h$1","reviewDecision":"$2",
 "mergeStateStatus":"$3","autoMergeRequest":$4,"labels":[${6-}],"reviewRequests":[],
 "commits":[$(for ((i = 1; i < $5; i++)); do printf '{"authors":[{"login":"sssoto17","email":"x@example.com"}]},'; done){"authors":[{"login":"${7:-sssoto17}","email":"x@example.com"}]}]}
J
}
fx_reviews() { # pr state[:commit]... -> the App's reviews, oldest first
  local pr=$1 s out=""
  shift
  for s in "$@"; do out+="{\"user\":{\"login\":\"sunny-reviewer[bot]\"},\"state\":\"${s%%:*}\",\"commit_id\":\"${s#*:}\"},"; done
  echo "[${out%,}]" >"$work/fx/reviews-$pr.json"
}
fx_threads() { # pr [resolved resolvedBy]: the admin's hold thread, and the App's escalation if given
  jq -n --arg r "${2-}" --arg by "${3-}" '[{isResolved: false, resolvedBy: null,
      comments: {nodes: [{author: {login: "sssoto17"}, body: "Hold (ci-check.sh start 68)"}]}}]
    + (if $r == "" then [] else [{isResolved: ($r == "true"), resolvedBy: {login: $by},
      comments: {nodes: [{author: {login: "sunny-reviewer"}, body: "escalated: Content change\n\n@sssoto17: this PR"}]}}] end)
    | {data: {repository: {pullRequest: {reviewThreads: {nodes: .}}}}}' >"$work/fx/threads-$1.json"
}
row() { contains "$out" "| ($1) $2 | $3 |"; }
reset
echo '[]' >"$work/fx/prs.json"
echo '[]' >"$work/fx/runs.json"
run results 68
expect_code 0
for id in a b c d e1 e2 e3 e4 f; do assert "expected ($id) not yet run" grep -q "^| ($id) .* | not yet run |" <<<"$out"; done
assert "expected nine test rows" test "$(grep -c '^| (' <<<"$out")" -eq 9

# Everything passed: (a) approved after (d)'s push, auto-merge by the App, (c) blocked, (e)'s
# thread resolved by the admin after the factory's run, (f) blocked.
cat >"$work/fx/prs.json" <<'J'
[{"number":71,"headRefName":"throwaway/68-a","isCrossRepository":false},
 {"number":72,"headRefName":"throwaway/68-c","isCrossRepository":false},
 {"number":73,"headRefName":"throwaway/68-e","isCrossRepository":false},
 {"number":74,"headRefName":"throwaway/68-f","isCrossRepository":false}]
J
fx_view 71 APPROVED BLOCKED '{"enabledBy":{"login":"sunny-reviewer"},"mergeMethod":"SQUASH","authorEmail":"x@example.com"}' 2
fx_reviews 71 DISMISSED:h0 APPROVED:h71
fx_threads 71
fx_view 72 CHANGES_REQUESTED BLOCKED null 1
fx_reviews 72 CHANGES_REQUESTED:h72
fx_threads 72
fx_view 73 REVIEW_REQUIRED BLOCKED null 4 '{"name":"review:admin"}'
fx_reviews 73 COMMENTED:h0 COMMENTED:h1 COMMENTED:h73
fx_threads 73 true sssoto17
fx_view 74 REVIEW_REQUIRED BLOCKED null 1 '{"name":"review:admin"}'
fx_reviews 74 COMMENTED:h74
fx_threads 74
echo '[{"databaseId":9,"workflowName":"check-68-factory-resolve","status":"completed","conclusion":"success","url":"https://example.test/run/9"}]' \
  >"$work/fx/runs.json"
printf '%s\n' $'factory-resolve\tRun\t2026-11-13T10:00:02.2Z RESULT thread_after_review resolved=false resolved_by=null' >"$work/fx/log"
: >"$work/calls"
run results 68
expect_code 0
assert "expected the seven tested rows to pass" test "$(grep -c '^| ([a-f][0-9]*) .* | pass |' <<<"$out")" -eq 7
assert "expected (f) not exercised" row f "AGENTS.md waits for the code owner" "not exercised"
assert "expected what (f) observed" contains "$out" "App withheld approval (Code-owned path row): \`REVIEW_REQUIRED\`, \`BLOCKED\`"
assert "expected (e4) not exercised" row e4 "merges only on admin approval" "not exercised"
assert "expected (b)'s reading" contains "$out" 'autoMergeRequest by `sunny-reviewer`'
assert "expected every review listed" contains "$out" '- reviews, oldest first: `sunny-reviewer[bot]` DISMISSED, `sunny-reviewer[bot]` APPROVED'
assert "expected the auto-merge detail" contains "$out" 'autoMergeRequest: enabled by `sunny-reviewer`, SQUASH'
assert "expected (e)'s thread state" contains "$out" 'escalation thread: resolved `true`, resolvedBy `sssoto17`'
assert "expected (e)'s label" contains "$out" '- labels: `review:admin`'
assert "expected the hold thread not taken for an escalation" contains "$out" "- escalation thread: none"
assert "expected the factory run's RESULT line" contains "$out" "factory-resolve: RESULT thread_after_review resolved=false"
assert "expected no email printed" lacks "$out" "example.com"
assert "expected (e)'s threads asked by number" contains "$calls" "-F pr=73"

# Failures read as failures: (c) approved, (f) mergeable, (b) no auto-merge, (d) never dismissed.
fx_view 72 APPROVED CLEAN null 1
fx_reviews 72 APPROVED:h72
fx_view 74 REVIEW_REQUIRED CLEAN null 1
fx_view 71 APPROVED BLOCKED null 2
fx_reviews 71 APPROVED:h0 APPROVED:h71
run results 68
assert "expected (b) to fail" row b "App turns on auto-merge" fail
assert "expected (c) to fail" row c "Request changes blocks" fail
assert "expected (d) to fail" row d "a push dismisses the approval" fail
assert "expected (f) to fail" row f "AGENTS.md waits for the code owner" fail
fx_view 74 REVIEW_REQUIRED BLOCKED null 1
fx_reviews 74 APPROVED:h74
run results 68
assert "expected (f) to pass once the App approved it" row f "AGENTS.md waits for the code owner" pass
fx_view 74 APPROVED CLEAN null 1
run results 68
assert "expected (f) to fail when the App's approval is enough" row f "AGENTS.md waits for the code owner" fail
# Request changes that doesn't block is a failure too: the merge state is half of (c).
fx_view 72 CHANGES_REQUESTED CLEAN null 1
fx_reviews 72 CHANGES_REQUESTED:h72
run results 68
assert "expected (c) to fail when not BLOCKED" row c "Request changes blocks" fail
# (e) waiting: resolved by the factory, or by the admin before the App has reviewed the head.
fx_threads 73 true sunny-factory
run results 68
assert "expected (e3) not yet run after the factory's resolve" row e3 "admin resolves, it stays resolved" "not yet run"
fx_threads 73 true sssoto17
fx_view 73 REVIEW_REQUIRED BLOCKED null 4 '{"name":"review:admin"}' 'sunny-factory[bot]'
run results 68
assert "expected (e3) waiting for push 68 e" contains "$out" "waiting for push 68 e"
# Open again after the admin's push and its review: a fail, not "not yet run".
fx_threads 73 false null
fx_view 73 REVIEW_REQUIRED BLOCKED null 5 '{"name":"review:admin"}'
fx_reviews 73 COMMENTED:h73
run results 68
assert "expected (e3) to fail when reopened" row e3 "admin resolves, it stays resolved" fail
fx_view 73 REVIEW_REQUIRED CLEAN null 5 '{"name":"review:admin"}'
run results 68
assert "expected (e4) to fail when (e) could merge without you" row e4 "merges only on admin approval" fail
fx_reviews 73 APPROVED:h73
run results 68
assert "expected (e1) to fail on an approval" row e1 "escalation thread, no approval" fail

# --- cleanup 68 ---------------------------------------------------------------------------------
printf 'heads/throwaway/68-%s\n' a c e f factory-resolve >"$work/fx/refs"
: >"$work/calls"
echo true >"$work/fx/auto"
run cleanup 68
expect_code 0
for pr in 71 72 73 74; do assert "expected PR #$pr closed" contains "$calls" "pr close $pr --repo sssoto17/sunny-pastures --comment"; done
for l in a c e f factory-resolve; do
  assert "expected throwaway/68-$l deleted" contains "$calls" "DELETE repos/sssoto17/sunny-pastures/git/refs/heads/throwaway/68-$l"
done
assert "expected no merge" lacks "$calls" "pr merge"
assert "expected the reminder to turn auto-merge off" contains "$out" "Not all of (a)-(f) passed"
assert "expected the command" contains "$out" "-F allow_auto_merge=false"
echo false >"$work/fx/auto"
run cleanup 68
assert "expected no reminder once it's off" lacks "$out" "allow_auto_merge"
rm "$work/fx/auto"
: >"$work/fx/auto-fail"
run cleanup 68
assert "expected the reminder when the setting can't be read" contains "$out" "Could not read allow_auto_merge"
rm "$work/fx/auto-fail"

out=$(cd "$work/clone" && printf 'n\n' | PATH="$work/bin:$PATH" bash "$script" cleanup 68 2>"$work/err")
code=$?
expect_code 2

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

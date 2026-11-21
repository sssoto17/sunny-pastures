#!/usr/bin/env bash
# Tests for stack.sh through its command line: real git against a throwaway bare remote, and a fake
# `gh` on PATH that keeps PRs and stacks as JSON files, shaped as GitHub's REST API returns them.
# It never reaches GitHub. Run: bash scripts/stack.test.sh (needs jq, git 2.38+)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/stack.sh"
pass=0
fail=0

if ! command -v jq >/dev/null; then
  echo "jq is not installed: install it to run these tests" >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/stack-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
export GIT_CONFIG_GLOBAL=$work/gitconfig GIT_CONFIG_NOSYSTEM=1
git config --global user.name "stack test"
git config --global user.email "stack-test@example.invalid"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

# --- fake gh ----------------------------------------------------------------------------------
# scripts/lib/gh-fake.sh (its header says what it keeps), with the real workflow step behind
# POST dispatches, so a part opens as sunny-factory[bot] and the App links the stack (#336).
cp "$(dirname "$script")/lib/gh-fake.sh" "$work/bin/gh"
chmod +x "$work/bin/gh"
export FAKE_WORKFLOW_SCRIPT OPEN_PR_POLL=0 PR_DRAFT_POLL=0 STACK_WAIT_POLL=0
FAKE_WORKFLOW_SCRIPT="$(cd "$(dirname "$script")/.." && pwd)/.github/scripts/open-pr.sh"
# A git on PATH that records each push's arguments, and in the fake's events (#358) which PRs were
# drafts as it pushed, then runs the real git.
cat >"$work/bin/git" <<EOF
#!/usr/bin/env bash
if [[ \$1 == push ]]; then
  printf '%s\n' "\$*" >>"$work/pushes"
  echo "push drafts=\$(cat "$work"/gh/pulls/*.json 2>/dev/null | jq -rs '[.[] | select(.draft) | .number] | join(",")')" \
    >>"$work/gh/events"
fi
exec "$(command -v git)" "\$@"
EOF
chmod +x "$work/bin/git"

# --- fixtures ---------------------------------------------------------------------------------
# A bare remote with main, and a clone in $repo where the parts are built. Branch names follow the
# lanes' naming, which the workflow step checks: <N>-<slug>.
reset() {
  rm -rf "$work/pushes" "$work/gh" "$work/remote.git" "$work/repo" "$work/bodies"
  mkdir -p "$work/gh/pulls" "$work/gh/stacks" "$work/gh/runs" "$work/bodies"
  echo 400 >"$work/gh/next"
  printf 'review:admin\narea:ci-cd\n' >"$work/gh/labels"
  git init -q --bare "$work/remote.git"
  git init -q "$work/repo"
  repo=$work/repo
  git -C "$repo" remote add origin "$work/remote.git"
  echo base >"$repo/README"
  git -C "$repo" add README
  git -C "$repo" commit -qm "base"
  git -C "$repo" push -q origin main
}
part() { # branch from file [content] -> commits file on a new branch made from <from>
  git -C "$repo" branch -q "$1" "$2"
  git -C "$repo" switch -q "$1"
  echo "${4:-$1}" >"$repo/$3"
  git -C "$repo" add "$3"
  git -C "$repo" commit -qm "$1: $3"
}
body() { # name title -> a body file whose first line is the title
  printf '%s\n\nPart of #264.\n' "$2" >"$work/bodies/$1.md"
  printf '%s' "$work/bodies/$1.md"
}
three_parts() {
  part 7-p1 main a.txt
  part 7-p2 7-p1 b.txt
  part 7-p3 7-p2 c.txt
}
pr_field() { jq -r "$2" "$work/gh/pulls/$1.json"; }
events() { grep -v '^opened ' "$work/gh/events" 2>/dev/null; } # the drafts, pushes and ready marks
drafts() { cat "$work"/gh/pulls/*.json | jq -rs '[.[] | select(.draft) | .number] | join(",")'; }

run() { # args... -> sets code, out, err, calls
  out=$(cd "$repo" && PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/gh/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n' \
    "$1" "${args[*]-}" "$code" "$out" "$err"
}
assert() { # message command...
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
expect_eq() { # message actual expected
  if [[ $2 == "$3" ]]; then ok; else bad "$1: expected '$3', got '$2'"; fi
}
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
has_call() { local lines; lines=$(call_lines); grep -qF -- "$1" <<<"$lines"; }
expect_no_call() { if has_call "$1"; then bad "expected no gh call containing: $1"; else ok; fi; }
expect_call() { if has_call "$1"; then ok; else bad "expected a gh call containing: $1"; fi; }
remote_sha() { git -C "$work/remote.git" rev-parse -q --verify "refs/heads/$1" || echo none; }
case_() { args=("$@"); run "$@"; }

# --- usage ------------------------------------------------------------------------------------
reset
case_ --help
expect_code 0
expect_err "usage:"
case_
expect_code 2
expect_err "usage:"
case_ frobnicate
expect_code 2
expect_err "unknown command"

# --- open: creates each PR on the part below, then the native stack ----------------------------
reset
three_parts
case_ open --label review:admin 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')" 7-p3="$(body 7-p3 'feat: three')"
expect_code 0
expect_eq "7-p1 pushed" "$(remote_sha 7-p1)" "$(git -C "$repo" rev-parse 7-p1)"
expect_eq "7-p3 pushed" "$(remote_sha 7-p3)" "$(git -C "$repo" rev-parse 7-p3)"
expect_eq "part 1 on main" "$(pr_field 400 .base.ref)" main
expect_eq "part 2 on part 1" "$(pr_field 401 .base.ref)" 7-p1
expect_eq "part 3 on part 2" "$(pr_field 403 .base.ref)" 7-p2
expect_eq "title from the body file's first line" "$(pr_field 401 .title)" "feat: two"
expect_eq "body without the title line" "$(pr_field 401 .body)" "Part of #264."
expect_eq "stack holds the parts in order" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401,403]"
expect_eq "part 3 knows its position" "$(pr_field 403 .stack.position)" 3
expect_call "api -X POST repos/sssoto17/sunny-pastures/issues/403/labels --silent -f labels[]=review:admin"
expect_eq "opened by the App" "$(pr_field 400 .user.login) $(pr_field 403 .user.login)" "sunny-factory[bot] sunny-factory[bot]"
expect_no_call "api -X POST repos/sssoto17/sunny-pastures/stacks/402/add -F pull_requests[]=403 --jq"
expect_out "stack #402"
# #358: each part opens as a draft. The run marks parts 2 and 3 ready after linking them; part 1
# waits as a draft until the stack exists, then pr-draft marks it ready. A push to open is no update.
expect_eq "every part opened as a draft" "$(grep -c 'draft=true' "$work/gh/events")" 3
expect_eq "part 1 kept a draft, then marked ready after the links" "$(events)" \
  $'push drafts=\nmarked 401 ready\nmarked 403 ready\nready 400\nmarked 400 ready'
expect_eq "no draft left" "$(drafts)" ""
# the push never forces and never sets an upstream
assert "pushed" test -s "$work/pushes"
assert "no forced push" bash -c "! grep -qE -- ' (-f|--force[^ ]*|\+[^ ]+)( |$)' '$work/pushes'"
assert "no upstream recorded" test -z "$(git -C "$repo" config --get branch.7-p1.remote)"

# open again: reuses the PRs and the stack, creates nothing
case_ open 7-p1="$work/bodies/7-p1.md" 7-p2="$work/bodies/7-p2.md" 7-p3="$work/bodies/7-p3.md"
expect_code 0
expect_eq "no new PR or stack" "$(cat "$work/gh/next")" 404
expect_out "stack #402"

# part 1 built on an older main still opens: GitHub diffs it from the merge base
reset
part 7-p1 main a.txt
part 7-p2 7-p1 b.txt
git -C "$repo" switch -q --detach main
git -C "$repo" commit -q --allow-empty -m "main moves on" && git -C "$repo" push -q origin HEAD:main
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
expect_code 0
expect_eq "part 1 on main" "$(pr_field 400 .base.ref)" main

# --- open: refusals change nothing ---------------------------------------------------------------
reset
three_parts
case_ open 7-p1="$(body 7-p1 'feat: one')"
expect_code 2
expect_err "at least 2 parts"
reset
part 7-p1 main a.txt
part 7-p2 main b.txt # not on top of 7-p1: a hand-made chain the stack can't hold
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
expect_code 2
expect_err "7-p2 is not built on 7-p1"
expect_eq "nothing pushed" "$(remote_sha 7-p1)" none
expect_eq "no PR" "$(cat "$work/gh/next")" 400
reset
part 7-p1 main a.txt
git -C "$repo" branch -q 7-p2 7-p1 # no commit of its own
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
expect_code 2
expect_err "7-p2 has no commits of its own"
reset
three_parts
printf '\n' >"$work/bodies/empty.md"
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$work/bodies/empty.md"
expect_code 2
expect_err "no title"
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$work/bodies/missing.md"
expect_code 2
expect_err "can't read"
case_ open 7-p1="$(body 7-p1 'feat: one')" nosuch="$(body 7-p2 'feat: two')"
expect_code 2
expect_err "no local branch nosuch"
case_ open --base nosuch 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
expect_code 2
expect_err "no branch nosuch on origin"
# an open PR for a part on another base is a hand-chained PR: refuse rather than stack it
git -C "$repo" push -q origin 7-p1 7-p2
printf '{"number":390,"state":"open","head":{"ref":"7-p2","sha":"x"},"base":{"ref":"main"},"stack":null}' \
  >"$work/gh/pulls/390.json"
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
expect_code 2
expect_err "#390 already has 7-p2 on main"
expect_eq "no PR created" "$(cat "$work/gh/next")" 400

# a failed stack call leaves the PRs and says how to retry
reset
three_parts
echo "gh: Forbidden (HTTP 403)" >"$work/gh/fail_POST_repos_sssoto17_sunny-pastures_stacks"
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
expect_code 1
expect_err "PRs #400 #401 are open but not stacked"
expect_err "run the same command again"
rm "$work/gh/fail_POST_repos_sssoto17_sunny-pastures_stacks"
case_ open 7-p1="$work/bodies/7-p1.md" 7-p2="$work/bodies/7-p2.md"
expect_code 0
expect_eq "retry stacks the same PRs" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401]"

# open-pr.sh fails for part 1 (no run answers): stop there, before part 2 is dispatched
reset
three_parts
touch "$work/gh/no_workflow"
OPEN_PR_TIMEOUT=0 case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
expect_code 1
expect_err "no PR for 7-p1"
expect_eq "one dispatch only" "$(wc -l <"$work/gh/dispatches")" 1
rm "$work/gh/no_workflow"

# the App's token can't link the stack (#336 records whether /stacks takes it): the PRs stay the
# App's, and the lane's own token links the parts the run left out
reset
three_parts
echo "gh: Resource not accessible by integration (HTTP 403)" \
  >"$work/gh/fail_app_POST_repos_sssoto17_sunny-pastures_stacks"
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')" 7-p3="$(body 7-p3 'feat: three')"
expect_code 0
expect_eq "still the App's PRs" "$(pr_field 402 .user.login)" "sunny-factory[bot]"
expect_eq "linked here, in order" "$(jq -c .prs "$work/gh/stacks/403.json")" "[400,401,402]"
expect_err "as stack #403 with your token"
# the App starts the stack but can't add to it: only the missing part is added here
reset
three_parts
echo "gh: Resource not accessible by integration (HTTP 403)" \
  >"$work/gh/fail_app_POST_repos_sssoto17_sunny-pastures_stacks_402_add"
case_ open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')" 7-p3="$(body 7-p3 'feat: three')"
expect_code 0
expect_eq "completed here" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401,403]"

# --- --as-admin (#385): each part opened as the admin, and linked with the lane's token ----------
reset
three_parts
OPEN_PR_AS_ADMIN=264 case_ open --as-admin 7-p1="$(body 7-p1 'test: one')" 7-p2="$(body 7-p2 'test: two')"
expect_code 0
expect_eq "opened by the admin" "$(pr_field 400 .user.login) $(pr_field 401 .user.login)" "sssoto17 sssoto17"
expect_eq "linked by stack.sh" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401]"
expect_eq "drafts until linked, then ready by the App" "$(events)" $'push drafts=\nready 400,401\nmarked 400 ready\nmarked 401 ready'
rm -f "$work/gh/events"
OPEN_PR_AS_ADMIN=264 case_ add 401 --as-admin 7-p3="$(body 7-p3 'test: three')"
expect_code 0
expect_eq "the added part by the admin" "$(pr_field 403 .user.login)" sssoto17
expect_eq "added to the stack" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401,403]"
expect_eq "the added part a draft until linked" "$(events)" $'push drafts=\nready 403\nmarked 403 ready'
reset
three_parts
case_ open --as-admin 7-p1="$(body 7-p1 'test: one')" 7-p2="$(body 7-p2 'test: two')"
expect_code 2
expect_err "OPEN_PR_AS_ADMIN"
# a part whose open PR the App opened can't be reused as the admin's
reset
three_parts
run open 7-p1="$(body 7-p1 'test: one')" 7-p2="$(body 7-p2 'test: two')"
OPEN_PR_AS_ADMIN=264 case_ open --as-admin 7-p1="$work/bodies/7-p1.md" 7-p2="$work/bodies/7-p2.md"
expect_code 2
expect_err "#400 was opened by sunny-factory[bot]"

# --- add: appends a part on the top open part ----------------------------------------------------
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
rm -f "$work/gh/events"
case_ add 401 7-p3="$(body 7-p3 'feat: three')"
expect_code 0
expect_eq "new part on the top part" "$(pr_field 403 .base.ref)" 7-p2
expect_eq "the run links it, then marks it ready" "$(events)" $'push drafts=\nmarked 403 ready'
expect_eq "appended to the stack" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401,403]"
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
part 7-p4 7-p1 d.txt
case_ add 400 7-p4="$(body 7-p4 'feat: four')"
expect_code 2
expect_err "7-p4 is not built on 7-p2"
case_ add 999 7-p3="$(body 7-p3 'feat: three')"
expect_code 1
expect_err "#999"
# a hand-chained PR for the new part is refused before anything is pushed
printf '{"number":390,"state":"open","head":{"ref":"7-p3","sha":"x"},"base":{"ref":"main"},"stack":null}' \
  >"$work/gh/pulls/390.json"
case_ add 400 7-p3="$(body 7-p3 'feat: three')"
expect_code 2
expect_err "#390 already has 7-p3 on main"
expect_eq "7-p3 not pushed" "$(remote_sha 7-p3)" none
reset
part 7-p1 main a.txt
git -C "$repo" push -q origin 7-p1
printf '{"number":390,"state":"open","head":{"ref":"7-p1","sha":"x"},"base":{"ref":"main"},"stack":null}' \
  >"$work/gh/pulls/390.json"
part 7-p2 7-p1 b.txt
case_ add 390 7-p2="$(body 7-p2 'feat: two')"
expect_code 2
expect_err "#390 is not in a stack"

# --- update: an edit to a lower part restacks the parts above it --------------------------------
# GitHub's "Rebase stack" fails on a merge commit that replays empty after a squash (throwaway
# stack #315, 16 Nov), so the stack stays linear: rebase, then push with a lease on each branch.
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')" 7-p3="$(body 7-p3 'feat: three')"
git -C "$repo" switch -q 7-p1
echo fix >"$repo/a.txt"
git -C "$repo" commit -qam "7-p1: fix"
git -C "$repo" switch -q 7-p3
rm -f "$work/pushes"
fetched_p2=$(remote_sha 7-p2)
rm -f "$work/gh/events"
case_ update 403
expect_code 0
# #358: the moved parts are drafts while pushed, then ready once GitHub shows the new heads
expect_eq "drafts around the push" "$(events)" \
  $'draft 400,401,403\nmarked 400 draft\nmarked 401 draft\nmarked 403 draft\npush drafts=400,401,403\nready 400,401,403\nmarked 400 ready\nmarked 401 ready\nmarked 403 ready'
expect_eq "no draft left" "$(drafts)" ""
assert "7-p2 is on the new 7-p1" git -C "$repo" merge-base --is-ancestor 7-p1 7-p2
assert "7-p3 is on the new 7-p2" git -C "$repo" merge-base --is-ancestor 7-p2 7-p3
expect_eq "no merge commits" "$(git -C "$repo" rev-list --merges main..7-p3 | wc -l)" 0
expect_eq "7-p2 adds only its own commit" "$(git -C "$repo" rev-list --count 7-p1..7-p2)" 1
expect_eq "7-p3 still checked out, with the fix" "$(git -C "$repo" branch --show-current) $(cat "$repo/a.txt")" "7-p3 fix"
expect_eq "7-p1 pushed" "$(remote_sha 7-p1)" "$(git -C "$repo" rev-parse 7-p1)"
expect_eq "7-p3 pushed" "$(remote_sha 7-p3)" "$(git -C "$repo" rev-parse 7-p3)"
assert "the lease is the fetched head" grep -q -- "--force-with-lease=refs/heads/7-p2:$fetched_p2" "$work/pushes"
assert "never a bare force" bash -c "! grep -qE -- ' (-f|--force)( |$)| \+' '$work/pushes'"
rm -f "$work/gh/events"
case_ update 403
expect_code 0
expect_out "up to date"
expect_eq "nothing pushed, nothing switched" "$(events)" ""
# an edit to part 2 moves parts 2 and 3 only: part 1's head is unchanged, so it stays ready and
# gets no second run
git -C "$repo" switch -q 7-p2
git -C "$repo" commit -q --allow-empty -m "7-p2: more"
rm -f "$work/gh/events"
case_ update 403
expect_code 0
expect_eq "only the moved parts as drafts" "$(events | head -n4)" \
  $'draft 401,403\nmarked 401 draft\nmarked 403 draft\npush drafts=401,403'
# GitHub hasn't shown the new heads before the timeout: fail loudly, the pushed parts stay drafts;
# once it shows them, update again marks them ready without pushing
git -C "$repo" switch -q 7-p1
git -C "$repo" commit -q --allow-empty -m "7-p1: again"
touch "$work/gh/stale_heads"
STACK_WAIT_TIMEOUT=0 case_ update 403
expect_code 1
expect_err "after 0 s GitHub doesn't show the pushed heads of #400 #401 #403"
expect_err "they stay drafts"
expect_err "scripts/pr-draft.sh ready 400 401 403"
expect_eq "pushed" "$(remote_sha 7-p3)" "$(git -C "$repo" rev-parse 7-p3)"
expect_eq "still drafts" "$(drafts)" "400,401,403"
rm "$work/gh/stale_heads" "$work/gh/events"
case_ update 403
expect_code 0
expect_eq "marked ready, nothing pushed" "$(events)" $'ready 400,401,403\nmarked 400 ready\nmarked 401 ready\nmarked 403 ready'
if contains "$out" "(draft)"; then bad "status shows no draft after ready"; else ok; fi
# the wait reads the base too: a part whose base GitHub doesn't show at the new head of the part
# below isn't ready yet (here the base points at a branch the fake can't resolve)
git -C "$repo" switch -q 7-p1
git -C "$repo" commit -q --allow-empty -m "7-p1: base"
jq '.base.ref = "7-p1-old"' "$work/gh/pulls/401.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/401.json"
STACK_WAIT_TIMEOUT=0 case_ update 403
expect_code 1
expect_err "pushed heads of #401"
# a part that already sits on the part below but holds a merge commit (the old merge-upward
# update made them) is rebuilt as one commit with the same tree, so the stack turns linear
reset
part 7-p1 main a.txt
git -C "$repo" switch -q -c 7-p2 7-p1
echo b >"$repo/b.txt" && git -C "$repo" add b.txt
git -C "$repo" commit -q -m "7-p2: b.txt" -m "Why it's here." -m "Co-Authored-By: T <t@example.invalid>"
echo b2 >"$repo/b2.txt" && git -C "$repo" add b2.txt && git -C "$repo" commit -qm "7-p2: b2.txt"
part 7-p3 7-p2 c.txt
git -C "$repo" switch -q 7-p1
echo more >"$repo/a2.txt" && git -C "$repo" add a2.txt && git -C "$repo" commit -qm "7-p1: more"
git -C "$repo" switch -q 7-p2 && git -C "$repo" merge -q --no-edit 7-p1
git -C "$repo" switch -q 7-p3 && git -C "$repo" merge -q --no-edit 7-p2
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')" 7-p3="$(body 7-p3 'feat: three')"
tree_p3=$(git -C "$repo" rev-parse '7-p3^{tree}')
case_ update 403
expect_code 0
expect_eq "now linear" "$(git -C "$repo" rev-list --merges main..7-p3 | wc -l)" 0
expect_eq "7-p3's content unchanged" "$(git -C "$repo" rev-parse '7-p3^{tree}')" "$tree_p3"
expect_eq "7-p2 is one commit on 7-p1" "$(git -C "$repo" rev-list --count 7-p1..7-p2)" 1
expect_eq "its first commit's subject kept" "$(git -C "$repo" log -1 --format=%s 7-p2)" "7-p2: b.txt"
expect_eq "its trailers stay trailers" "$(git -C "$repo" log -1 --format='%(trailers:only,unfold)' 7-p2 | sed '/^$/d')" \
  "Co-Authored-By: T <t@example.invalid>"
assert "the other commits listed" bash -c "git -C '$repo' log -1 --format=%B 7-p2 | grep -q '^- 7-p2: b2.txt$'"
expect_eq "7-p3 pushed" "$(remote_sha 7-p3)" "$(git -C "$repo" rev-parse 7-p3)"
# a conflict changes nothing: no branch moves, nothing is pushed, no rebase is left open
reset
part 7-p1 main a.txt
part 7-p2 7-p1 a.txt "two"
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
git -C "$repo" switch -q 7-p1
echo "one changed" >"$repo/a.txt"
git -C "$repo" commit -qam "7-p1: change"
before_p1=$(remote_sha 7-p1) before_p2=$(git -C "$repo" rev-parse 7-p2)
case_ update 400
expect_code 2
expect_err "rebasing 7-p2 onto 7-p1 conflicts"
expect_eq "7-p2 unmoved" "$(git -C "$repo" rev-parse 7-p2)" "$before_p2"
expect_eq "nothing pushed" "$(remote_sha 7-p1)" "$before_p1"
expect_eq "back on 7-p1, no rebase open" "$(git -C "$repo" branch --show-current)" 7-p1
# uncommitted work stops it: restacking checks branches out
echo dirty >>"$repo/README"
case_ update 400
expect_code 2
expect_err "uncommitted"
git -C "$repo" checkout -q -- README
# it never force-pushes main, whatever the stack says
jq '.head.ref = "main"' "$work/gh/pulls/400.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/400.json"
case_ update 400
expect_code 2
expect_err "never force-pushes main"

# GitHub's branch moved since this clone last saw it: refuse rather than force-push over it,
# even though the lease (the fetched head) would let the push through
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
git -C "$repo" switch -q --detach "$(remote_sha 7-p2)"
echo theirs >"$repo/t.txt" && git -C "$repo" add t.txt && git -C "$repo" commit -qm "7-p2: pushed elsewhere"
git -C "$repo" push -q origin HEAD:7-p2
theirs=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" switch -q 7-p1
git -C "$repo" commit -q --allow-empty -m "7-p1: one more"
case_ update 400
expect_code 2
expect_err "rebase or fast-forward"
expect_eq "their commit kept" "$(remote_sha 7-p2)" "$theirs"
# GitHub's branch holds an evil merge or dropped a commit, which `git cherry` can't see: only a
# head this clone once held may be pushed over.
for change in merge rewrite; do
  reset
  part 7-p1 main a.txt
  part 7-p2 7-p1 b.txt
  echo c >"$repo/c.txt" && git -C "$repo" add c.txt && git -C "$repo" commit -qm "7-p2: c.txt"
  run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
  if [[ $change == merge ]]; then
    git -C "$repo" switch -q -c side main
    echo s >"$repo/s.txt" && git -C "$repo" add s.txt && git -C "$repo" commit -qm "7-p2: s.txt"
    git -C "$repo" switch -q --detach "$(remote_sha 7-p2)"
    git -C "$repo" merge -q --no-ff --no-commit side
    echo resolved >"$repo/m.txt" && git -C "$repo" add m.txt && git -C "$repo" commit -qm "Merge side"
    git -C "$repo" push -q origin HEAD:7-p2
    git -C "$repo" switch -q 7-p2
    echo s >"$repo/s.txt" && git -C "$repo" add s.txt && git -C "$repo" commit -qm "7-p2: s.txt"
  else
    git -C "$repo" switch -q --detach 7-p1
    git -C "$repo" cherry-pick "$(git -C "$repo" rev-parse 7-p2)" >/dev/null # keeps c.txt, drops b.txt
    git -C "$repo" push -q -f origin HEAD:7-p2
  fi
  theirs=$(remote_sha 7-p2)
  git -C "$repo" switch -q 7-p1
  git -C "$repo" commit -q --allow-empty -m "7-p1: one more"
  case_ update 400
  expect_code 2
  expect_err "rebase or fast-forward"
  expect_eq "GitHub's $change kept" "$(remote_sha 7-p2)" "$theirs"
done

# a lane that rebased its parts itself (same commits, new SHAs) can still push them
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
git -C "$repo" switch -q 7-p1
git -C "$repo" commit -q --allow-empty -m "7-p1: one more"
git -C "$repo" switch -q 7-p2
git -C "$repo" rebase -q 7-p1
case_ update 400
expect_code 0
expect_eq "rebased 7-p2 pushed" "$(remote_sha 7-p2)" "$(git -C "$repo" rev-parse 7-p2)"

# a push GitHub refuses: exit 1, every branch back where it was, nothing reported as done
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
git -C "$repo" switch -q 7-p1
git -C "$repo" commit -q --allow-empty -m "7-p1: one more"
was_p1=$(git -C "$repo" rev-parse 7-p1) was_p2=$(git -C "$repo" rev-parse 7-p2)
printf '#!/bin/sh\necho "refused by test" >&2\nexit 1\n' >"$work/remote.git/hooks/pre-receive"
chmod +x "$work/remote.git/hooks/pre-receive"
case_ update 400
expect_code 1
expect_err "push refused"
expect_eq "7-p2 restored" "$(git -C "$repo" rev-parse 7-p2)" "$was_p2"
expect_eq "7-p1 kept" "$(git -C "$repo" rev-parse 7-p1)" "$was_p1"
expect_eq "still on 7-p1" "$(git -C "$repo" branch --show-current)" 7-p1
expect_eq "the moved parts stay drafts: no second run on an unchanged head" "$(drafts)" "400,401"
rm "$work/remote.git/hooks/pre-receive"
case_ update 400
expect_code 0
expect_eq "run again: pushed, and ready" "$(drafts) $(remote_sha 7-p2)" " $(git -C "$repo" rev-parse 7-p2)"
printf '#!/bin/sh\nexit 1\n' >"$work/remote.git/hooks/pre-receive"
rm "$work/remote.git/hooks/pre-receive"

# --- refresh: restack the open parts after a lower part merged -----------------------------------
# GitHub squash-merges #400, retargets #401 to main and keeps it in the stack, but doesn't rebase
# it (throwaway stack #315): 7-p2 still holds 7-p1's own commit, which the squash already has.
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')" 7-p3="$(body 7-p3 'feat: three')"
old_p1=$(git -C "$repo" rev-parse 7-p1)
git -C "$repo" switch -q --detach main
git -C "$repo" merge -q --squash 7-p1 && git -C "$repo" commit -qm "feat: one (#400)"
git -C "$repo" push -q origin HEAD:main
jq '.state = "closed" | .merged_at = "2026-11-16T12:00:00Z"' "$work/gh/pulls/400.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/400.json"
jq '.base.ref = "main"' "$work/gh/pulls/401.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/401.json"
git -C "$repo" switch -q 7-p2
echo local >"$repo/l.txt" && git -C "$repo" add l.txt && git -C "$repo" commit -qm "7-p2: local only"
git -C "$repo" switch -q 7-p3
case_ refresh 403
expect_code 0
expect_out "#400 merged"
assert "7-p2 is on the new main" git -C "$repo" merge-base --is-ancestor origin/main 7-p2
assert "7-p1's own commit is gone from 7-p2" bash -c "! git -C '$repo' merge-base --is-ancestor $old_p1 7-p2"
expect_eq "7-p2 carries its two commits" "$(git -C "$repo" log --format=%s origin/main..7-p2 | sort | tr '\n' ,)" "7-p2: b.txt,7-p2: local only,"
expect_eq "7-p3 adds one commit on 7-p2" "$(git -C "$repo" rev-list --count 7-p2..7-p3)" 1
expect_eq "7-p2 pushed" "$(remote_sha 7-p2)" "$(git -C "$repo" rev-parse 7-p2)"
expect_eq "7-p3 pushed" "$(remote_sha 7-p3)" "$(git -C "$repo" rev-parse 7-p3)"
expect_eq "7-p3 still checked out" "$(git -C "$repo" branch --show-current)" 7-p3
expect_eq "refresh pushes the open parts as drafts" "$(grep '^push' "$work/gh/events" | tail -n1)" "push drafts=401,403"
expect_eq "then marks them ready" "$(drafts)" ""

# --- status: each part with its base, approvals and checks ---------------------------------------
reset
three_parts
run open 7-p1="$(body 7-p1 'feat: one')" 7-p2="$(body 7-p2 'feat: two')"
printf '[{"user":{"login":"sunny-reviewer[bot]"},"state":"CHANGES_REQUESTED"},{"user":{"login":"sunny-reviewer[bot]"},"state":"APPROVED"}]' \
  >"$work/gh/reviews_400.json"
printf '{"total_count":4,"check_runs":[{"id":4,"name":"ci / test","status":"completed","conclusion":"success"},{"id":3,"name":"ci / test","status":"completed","conclusion":"cancelled"},{"id":2,"name":"ci / test","status":"completed","conclusion":"failure"},{"id":1,"name":"guard / floor","status":"completed","conclusion":"failure"}]}' \
  >"$work/gh/checks_$(git -C "$repo" rev-parse 7-p1).json"
rm -f "$work/gh/calls"
case_ status 401
expect_code 0
expect_out "stack #402 on main"
expect_out "1/2 #400"
expect_out "approved"
expect_out "failing: guard / floor"
expect_out "1 passing, failing: guard / floor;"
expect_out "2/2 #401"
expect_out "base 7-p1"
jq '.draft = true' "$work/gh/pulls/401.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/401.json"
case_ status 401
expect_out "2/2 #401 7-p2 (draft) base 7-p1"
# status never writes
expect_no_call "-X POST"
expect_no_call "-X PATCH"
# no merge, ever: the script has no command that merges, and no call to a merge endpoint
assert "no merge endpoint in the script" bash -c "! grep -qE '/merge|unstack' '$script'"

echo "stack.test.sh: $pass passed, $fail failed"
((fail == 0))

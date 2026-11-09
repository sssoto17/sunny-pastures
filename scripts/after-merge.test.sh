#!/usr/bin/env bash
# Tests for after-merge.sh through its command line, against throwaway git repos under $TMPDIR:
# a bare "origin", the main folder cloned from it, and a lane worktree under
# .claude/worktrees/. A PR's squash merge is a commit pushed to origin from a third clone.
# `gh` is a fake on PATH: it logs its calls and answers `pr list` from $work/prs.
# `stat` is a fake on PATH too: it reports the paths listed in $work/placeholders as the
# sandbox's /dev/null placeholders (a character device, 1:3), which a test can't create without
# root, and runs the real stat for everything else.
# Run: bash scripts/after-merge.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/after-merge.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/after-merge-test.XXXXXX")
work=$(cd "$work" && pwd -P)
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# Git for the test repos only: no user or system config, a fixed identity.
cat >"$work/gitconfig" <<'EOF'
[user]
  name = Test
  email = test@example.com
[init]
  defaultBranch = main
[advice]
  detachedHead = false
EOF
export GIT_CONFIG_GLOBAL="$work/gitconfig" GIT_CONFIG_NOSYSTEM=1

# --- fakes ------------------------------------------------------------------------------------
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
if [[ $1 == pr && $2 == list ]]; then
  [[ -f $dir/fail-gh ]] && { echo "fake: gh failed" >&2; exit 1; }
  cat "$dir/prs" 2>/dev/null
  exit 0
fi
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
real_stat=$(command -v stat)
cat >"$work/bin/stat" <<FAKE
#!/usr/bin/env bash
for last; do :; done
if [[ -f $work/placeholders ]] && grep -qxF -- "\$last" "$work/placeholders"; then
  echo 'character special file|1:3'
  exit 0
fi
exec $real_stat "\$@"
FAKE
chmod +x "$work/bin/gh" "$work/bin/stat"

# --- fixtures ---------------------------------------------------------------------------------
# reset: origin with one commit, the main folder at it, and lane 9-lane on chore/9-lane with one
# pushed commit. Sets main, lane, branch, tip.
branch=chore/9-lane
reset() {
  chmod -R u+w "$work" 2>/dev/null
  rm -rf "$work/origin.git" "$work/seed" "$work/main" "$work"/calls "$work"/prs \
    "$work"/fail-gh "$work"/placeholders "$work"/err
  : >"$work/mountinfo"
  git init -q --bare "$work/origin.git"
  git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
  printf 'node_modules/\ncoverage/\n*.tsbuildinfo\n.env*\n.scratch/\n' >"$work/seed/.gitignore"
  echo hello >"$work/seed/README.md"
  mkdir -p "$work/seed/.claude/hooks"
  echo '{}' >"$work/seed/.claude/settings.json"
  echo 'exit 0' >"$work/seed/.claude/hooks/old.sh"
  git -C "$work/seed" add .gitignore README.md .claude
  git -C "$work/seed" commit -qm init
  git -C "$work/seed" push -q origin main
  git clone -q "$work/origin.git" "$work/main"
  main=$work/main
  lane=$main/.claude/worktrees/9-lane
  git -C "$main" worktree add -q --no-track -b "$branch" "$lane" origin/main
  echo lane >"$lane/lane.txt"
  git -C "$lane" add lane.txt
  git -C "$lane" commit -qm "lane work"
  tip=$(git -C "$lane" rev-parse HEAD)
}

# merge_pr [path=content...]: the admin squash-merges the lane's PR (#12, at the lane's tip) on
# GitHub: origin/main gets one new commit with lane.txt plus any extra files given.
merge_pr() {
  local pair
  git -C "$work/seed" pull -q --ff-only origin main
  echo lane >"$work/seed/lane.txt"
  git -C "$work/seed" add lane.txt
  for pair in "$@"; do
    mkdir -p "$(dirname "$work/seed/${pair%%=*}")"
    printf '%s\n' "${pair#*=}" >"$work/seed/${pair%%=*}"
    git -C "$work/seed" add "${pair%%=*}"
  done
  git -C "$work/seed" commit -qm "lane work (#12)"
  git -C "$work/seed" push -q origin main
  printf '12\t%s\thttps://github.com/sssoto17/sunny-pastures/pull/12\n' "$tip" >"$work/prs"
}

run() { # args... -> runs the script from the main folder; sets code, out, err, calls
  out=$(cd "$main" && PATH="$work/bin:$PATH" AFTER_MERGE_MOUNTINFO="$work/mountinfo" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' \
    "$1" "${args[*]}" "$code" "$out" "$err" "$calls"
}
assert() { # message command... -> ok if the command succeeds
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
case_() { args=("$@"); run "$@"; }

main_at() { git -C "$main" rev-parse HEAD; }
origin_main() { git -C "$work/origin.git" rev-parse main; }
registered() { git -C "$main" worktree list --porcelain | grep -qxF "worktree $lane"; }
has_branch() { git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; }
expect_untouched() { # main where it was ($1), the worktree and the branch still there
  assert "expected main to stay at ${1:0:7}" test "$(main_at)" == "$1"
  assert "expected the worktree to stay registered" registered
  assert "expected the worktree folder to stay" test -d "$lane"
  assert "expected the branch to stay" has_branch
}
expect_tidied() { # main at origin/main, worktree and branch gone
  assert "expected main at origin/main" test "$(main_at)" == "$(origin_main)"
  if registered; then bad "expected the worktree to be deregistered"; else ok; fi
  assert "expected the worktree folder to be gone" test ! -e "$lane"
  if has_branch; then bad "expected the branch to be deleted"; else ok; fi
}

# --- usage ------------------------------------------------------------------------------------
reset
case_
expect_code 2
expect_err "usage:"

case_ --help
expect_code 0
expect_err "usage:"

# --- the happy path ---------------------------------------------------------------------------
# The PR merged: fast-forward main, remove the worktree, prune, delete the branch, say so.
reset
merge_pr
before=$(main_at)
case_ .claude/worktrees/9-lane
expect_code 0
expect_tidied
expect_out "main: fast-forwarded ${before:0:7}..$(origin_main | cut -c1-7) (1 commit)"
expect_out "worktree: removed $lane"
expect_out "worktrees: pruned"
expect_out "branch: deleted $branch"
assert "expected gh to be asked for the branch's merged PRs into main" \
  contains "$calls" "pr list --repo sssoto17/sunny-pastures --base main --head $branch --state merged"

# A bare name means .claude/worktrees/<name>; an absolute path works too. Ignored files
# (node_modules) aren't work to keep, but the output names them.
for form in 9-lane abs; do
  reset
  merge_pr
  mkdir -p "$lane/node_modules/pkg" && echo x >"$lane/node_modules/pkg/index.js"
  if [[ $form == abs ]]; then case_ "$lane/"; else case_ "$form"; fi
  expect_code 0
  expect_tidied
  expect_out "with its build output:"
  expect_out "node_modules/"
done

# All the build output on the admin's list goes, at any depth.
reset
merge_pr
mkdir -p "$lane/coverage" "$lane/pkg/node_modules/x" && echo x >"$lane/coverage/index.html"
echo x >"$lane/pkg/node_modules/x/f" && echo '{}' >"$lane/tsconfig.tsbuildinfo"
case_ 9-lane
expect_code 0
expect_tidied
expect_out "coverage/"
expect_out "pkg/node_modules/"
expect_out "tsconfig.tsbuildinfo"

# Other ignored files may be someone's work: refuse, name them, change nothing.
reset
merge_pr
echo "DATABASE_URL=placeholder" >"$lane/.env.local"
mkdir -p "$lane/.scratch" "$lane/node_modules" && echo notes >"$lane/.scratch/notes.md"
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "ignored files that aren't build output"
expect_err ".env.local"
expect_err ".scratch/"
assert "expected build output left out of the list" test "${err/node_modules/}" == "$err"
expect_untouched "$before"
assert "expected .env.local kept" test -f "$lane/.env.local"

# Already up to date (someone pulled main by hand): still removes the worktree and branch.
reset
merge_pr
git -C "$main" pull -q --ff-only origin main
case_ 9-lane
expect_code 0
expect_tidied
expect_out "main: already at origin/main"

# --- refusals: nothing changes ----------------------------------------------------------------
# The PR isn't merged (open, closed or never opened): gh lists no merged PR for the branch.
reset
merge_pr
: >"$work/prs"
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "no merged PR into main has $branch as its head"
expect_err "nothing changed"
expect_untouched "$before"

# The branch has a commit the merged PR doesn't carry (pushed late, or never pushed).
reset
merge_pr
echo more >"$lane/more.txt" && git -C "$lane" add more.txt && git -C "$lane" commit -qm more
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "PR #12 merged ${tip:0:7}"
expect_err "nothing changed"
expect_untouched "$before"

# "Update branch" on GitHub (ADR-0002) put a merge commit on the PR after the lane's last push:
# the merged head is past the local tip, with nothing lost. GitHub keeps it at refs/pull/N/head.
reset
git -C "$work/seed" pull -q --ff-only origin main
echo other >"$work/seed/other.txt" && git -C "$work/seed" add other.txt
git -C "$work/seed" commit -qm "another PR" && git -C "$work/seed" push -q origin main
git -C "$work/seed" fetch -q origin "$branch" 2>/dev/null ||
  git -C "$work/seed" fetch -q "$main/.git" "$branch"
git -C "$work/seed" switch -q -c updated FETCH_HEAD
git -C "$work/seed" merge -q --no-edit main
updated=$(git -C "$work/seed" rev-parse HEAD)
git -C "$work/seed" push -q origin "$updated:refs/pull/12/head"
git -C "$work/seed" switch -q main
merge_pr
printf '12\t%s\thttps://github.com/sssoto17/sunny-pastures/pull/12\n' "$updated" >"$work/prs"
case_ 9-lane
expect_code 0
expect_tidied

# Two merged PRs from the branch, and only the second carries its tip: the first merged an
# earlier, unrelated head.
reset
first=$(git -C "$work/origin.git" rev-parse main)
merge_pr
{
  printf '11\t%s\thttps://github.com/sssoto17/sunny-pastures/pull/11\n' "$first"
  cat "$work/prs"
} >"$work/prs.new" && mv "$work/prs.new" "$work/prs"
case_ 9-lane
expect_code 0
expect_tidied
expect_out "PR: #12 "

# gh fails.
reset
merge_pr
touch "$work/fail-gh"
before=$(main_at)
case_ 9-lane
expect_code 1
expect_err "could not read $branch's PRs"
expect_untouched "$before"

# Uncommitted work in the worktree: a modified file, a staged file, an untracked file.
for kind in modified staged untracked; do
  reset
  merge_pr
  case $kind in
    modified) echo changed >>"$lane/README.md" ;;
    staged) echo new >"$lane/new.txt" && git -C "$lane" add new.txt ;;
    untracked) echo notes >"$lane/notes.md" ;;
  esac
  before=$(main_at)
  case_ 9-lane
  expect_code 2
  expect_err "uncommitted work"
  case $kind in
    modified) expect_err "README.md" ;;
    staged) expect_err "new.txt" ;;
    untracked) expect_err "notes.md" ;;
  esac
  expect_untouched "$before"
done

# Not a registered worktree: a leftover folder (like 4-local-supabase), or nothing at all.
reset
merge_pr
mkdir -p "$main/.claude/worktrees/4-leftover"
before=$(main_at)
case_ 4-leftover
expect_code 2
expect_err "not a registered worktree"
assert "expected the leftover folder to stay" test -d "$main/.claude/worktrees/4-leftover"
expect_untouched "$before"
case_ 404-nothing
expect_code 2
expect_err "not a registered worktree"

# The main folder itself is not a lane worktree.
case_ "$main"
expect_code 2
expect_err "is the main folder"
expect_untouched "$before"

# Run from somewhere other than the main folder.
args=("from the lane")
out=$(cd "$lane" && PATH="$work/bin:$PATH" AFTER_MERGE_MOUNTINFO="$work/mountinfo" bash "$script" 9-lane 2>"$work/err")
code=$?
err=$(cat "$work/err")
expect_code 2
expect_err "run it from the main folder ($main)"
expect_untouched "$before"

# The main folder isn't on main: never switch it, refuse.
reset
merge_pr
git -C "$main" switch -q -c other
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "the main folder is on other, not main"
expect_untouched "$before"
git -C "$main" switch -q --detach
case_ 9-lane
expect_code 2
expect_err "the main folder is on a detached HEAD"

# main has diverged from origin/main: only a fast-forward is allowed.
reset
merge_pr
echo local >"$main/local.txt" && git -C "$main" add local.txt && git -C "$main" commit -qm local
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "main has diverged from origin/main"
expect_untouched "$before"

# Uncommitted changes to tracked files in the main folder (a half-applied update, say).
reset
merge_pr
echo edited >>"$main/README.md"
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "the main folder has uncommitted changes"
expect_err "README.md"
expect_untouched "$before"

# --- needs the host ---------------------------------------------------------------------------
# The command to run outside the sandbox: absolute paths, no variables like $TMPDIR.
expect_rerun() {
  expect_err "outside the sandbox"
  expect_err "cd $main && scripts/after-merge.sh $lane"
  assert 'expected no $ anywhere in stderr' test "${err//\$/}" == "$err"
}

# The update touches .claude/settings.json and the sandbox can't write it (a read-only file).
reset
merge_pr .claude/settings.json='{"changed": true}'
chmod a-w "$main/.claude/settings.json"
before=$(main_at)
case_ 9-lane
expect_code 3
expect_err ".claude/settings.json"
expect_err "nothing changed"
expect_rerun
expect_untouched "$before"
assert "expected settings.json not half-applied" test "$(cat "$main/.claude/settings.json")" == "{}"

# A new hook in a folder the sandbox can't write.
reset
merge_pr .claude/hooks/new.sh='echo hi'
chmod a-w "$main/.claude/hooks"
before=$(main_at)
case_ 9-lane
expect_code 3
expect_err ".claude/hooks/new.sh"
expect_rerun
expect_untouched "$before"
assert "expected no half-applied hook" test ! -e "$main/.claude/hooks/new.sh"

# The same update where the paths are writable (outside the sandbox): it just runs.
reset
merge_pr .claude/settings.json='{"changed": true}' .claude/skills/x/SKILL.md=skill
case_ 9-lane
expect_code 0
expect_tidied
assert "expected settings.json updated" test "$(cat "$main/.claude/settings.json")" == '{"changed": true}'

# Only the paths the update touches are checked.
reset
merge_pr .claude/README.md=notes
chmod a-w "$main/.claude/settings.json" "$main/.claude/hooks"
case_ 9-lane
expect_code 0
expect_tidied

# Any touched path counts, not only settings, hooks and skills: here a file the update adds
# where the sandbox has a placeholder in the main folder.
reset
merge_pr .mcp.json='{}'
: >"$main/.mcp.json"
printf '%s\n' "$main/.mcp.json" >"$work/placeholders"
before=$(main_at)
case_ 9-lane
expect_code 3
expect_err ".mcp.json"
expect_rerun
expect_untouched "$before"

# The worktree shows only sandbox placeholders: they can't be deleted from inside the sandbox,
# and they can hide real files, so nothing changes and the rerun outside decides.
reset
merge_pr
mkdir -p "$lane/.claude"
for p in .bashrc .mcp.json .claude/agents; do
  : >"$lane/$p"
  printf '%s\n' "$lane/$p" >>"$work/placeholders"
done
before=$(main_at)
case_ 9-lane
expect_code 3
expect_err "placeholders"
expect_err ".claude/agents"
expect_err "nothing changed"
expect_rerun
expect_untouched "$before"

# Placeholders plus real work: refuse over the real work, and list only it.
echo notes >"$lane/notes.md"
case_ 9-lane
expect_code 2
expect_err "notes.md"
assert "expected placeholders left out of the list" test "${err/.mcp.json/}" == "$err"
expect_untouched "$before"

# A placeholder on an ignored path (.env.local, ignored by .env*) is still a placeholder.
reset
merge_pr
: >"$lane/.env.local"
printf '%s\n' "$lane/.env.local" >"$work/placeholders"
before=$(main_at)
case_ 9-lane
expect_code 3
expect_err "placeholders"
expect_err ".env.local"
expect_rerun
expect_untouched "$before"

# The sandbox mounts files in the worktree's admin folder (commondir, seen 9 Nov), so the admin
# folder won't delete: stop before any change, not half-way.
reset
merge_pr
admin=$(git -C "$lane" rev-parse --absolute-git-dir)
printf '41 30 8:48 /null %s rw,nosuid - tmpfs none rw\n' "$admin/commondir" >"$work/mountinfo"
before=$(main_at)
case_ 9-lane
expect_code 3
expect_err "mounts in the worktree or its admin folder"
expect_err ".git/worktrees/9-lane/commondir"
expect_err "nothing changed"
expect_rerun
expect_untouched "$before"

# The worktree folder itself is a mount (a lane session's own folder), listed among others.
reset
merge_pr
{
  printf '20 1 8:48 / /proc rw - proc proc rw\n'
  printf '41 30 8:48 %s %s rw - ext4 /dev/sdd rw\n' "$lane" "$lane"
} >"$work/mountinfo"
before=$(main_at)
case_ 9-lane
expect_code 3
expect_err "the worktree folder itself"
expect_untouched "$before"

# A symlink to /dev/null is a file someone made, not a placeholder.
reset
merge_pr
ln -s /dev/null "$lane/link"
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "link"
expect_untouched "$before"

# --- the folder won't delete ------------------------------------------------------------------
# Checks passed, main moved, but the folder couldn't be deleted (in the sandbox: "Device or
# resource busy"; here: a folder without write permission). git deregisters the worktree
# anyway, so the branch goes; print the rest to run outside.
reset
merge_pr
mkdir -p "$lane/node_modules/stuck" && echo x >"$lane/node_modules/stuck/f"
chmod a-w "$lane/node_modules/stuck"
case_ 9-lane
expect_code 3
assert "expected main fast-forwarded" test "$(main_at)" == "$(origin_main)"
expect_err "rm -rf $lane"
expect_err "git -C $main worktree prune"
expect_err "outside the sandbox"
expect_out "branch: deleted $branch"
assert "expected no branch -D to run outside" test "${err/branch -D/}" == "$err"
chmod -R u+w "$lane"
# The printed commands finish the job.
rm -rf "$lane"
git -C "$main" worktree prune
expect_tidied

# --- refusals for the worktree's state --------------------------------------------------------
reset
merge_pr
git -C "$main" worktree lock "$lane"
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "is locked"
expect_untouched "$before"

reset
merge_pr
git -C "$lane" switch -q --detach
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "detached HEAD"
assert "expected main to stay at ${before:0:7}" test "$(main_at)" == "$before"
assert "expected the worktree to stay registered" registered

# --- the lane's folder can't make it run commands ---------------------------------------------
# The lane controls its folder and, from the sandbox, .git/worktrees/. The script may run outside
# the sandbox, so it must not let them point git at a config that runs a command (core.fsmonitor
# runs on git status). Each case plants such a repo and checks the command never ran.
plant() { # -> $work/evil: a repo whose config runs a command that touches $work/pwned
  rm -rf "$work/evil" "$work/pwned"
  git init -q "$work/evil"
  git -C "$work/evil" config core.fsmonitor "touch $work/pwned; false"
}
expect_not_run() {
  assert "expected the planted command not to run" test ! -e "$work/pwned"
}

# The worktree's .git file points somewhere else.
reset
merge_pr
plant
printf 'gitdir: %s\n' "$work/evil/.git" >"$lane/.git"
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "doesn't point back at"
expect_not_run
assert "expected main to stay at ${before:0:7}" test "$(main_at)" == "$before"

# A gitlink (submodule entry) staged in the lane's index, its folder linked to the planted repo:
# git status and git worktree remove would run git inside it.
reset
merge_pr
plant
git -C "$work/evil" commit -q --allow-empty -m evil
git -C "$lane" update-index --add --cacheinfo "160000,$(git -C "$work/evil" rev-parse HEAD),sub"
mkdir -p "$lane/sub"
printf 'gitdir: %s\n' "$work/evil/.git" >"$lane/sub/.git"
rm -f "$work/pwned" # the commit in the planted repo ran its own fsmonitor
before=$(main_at)
case_ 9-lane
expect_code 2
expect_err "submodule"
expect_not_run
expect_untouched "$before"

# The worktree's admin folder in .git/worktrees/ points its commondir somewhere else.
reset
merge_pr
plant
admin=$(git -C "$lane" rev-parse --absolute-git-dir)
printf '%s\n' "$work/evil/.git" >"$admin/commondir"
before=$(main_at)
case_ 9-lane
expect_code 2
expect_not_run
assert "expected main to stay at ${before:0:7}" test "$(main_at)" == "$before"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

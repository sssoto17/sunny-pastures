#!/usr/bin/env bash
# After the admin merges a lane's PR: fast-forward main in the main folder, remove the lane's
# worktree, prune, and delete its branch (#77). Every check runs before the first change, so a
# refusal changes nothing. Tests: scripts/after-merge.test.sh.
# Needs bash 4.4+, git 2.36+ (worktree list -z) and an authenticated gh.
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "after-merge: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

REPO=sssoto17/sunny-pastures

usage() {
  cat >&2 <<'EOF'
usage: scripts/after-merge.sh <worktree>

Run from the main folder, on main, after the worktree's PR has merged. <worktree> is a path
(.claude/worktrees/77-after-merge) or a name under .claude/worktrees/ (77-after-merge).

It fast-forwards main to origin/main (never switches branch, never merges), removes the worktree,
runs git worktree prune and deletes the worktree's branch, then prints what it did.

Exit codes: 0 done; 1 a git or gh command failed; 2 refused, nothing changed; 3 needs the
host: run the printed command outside the sandbox.
EOF
}

die() { # code message
  printf 'after-merge: %s\n' "$2" >&2
  exit "$1"
}

# --- arguments ----------------------------------------------------------------------------------
case ${1-} in
  "") usage; exit 2 ;;
  -h | --help) usage; exit 0 ;;
esac
arg=$1

# --- the main folder ----------------------------------------------------------------------------
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
  die 2 "not in a git repository; run it from the main folder"
main=$(cd "$common/.." && pwd -P)
top=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
[[ $top == "$main" ]] || die 2 "run it from the main folder ($main), not from $top"
on=$(git -C "$main" symbolic-ref --quiet --short HEAD) ||
  die 2 "the main folder is on a detached HEAD, not main. This script never switches branches."
[[ $on == main ]] ||
  die 2 "the main folder is on $on, not main. This script never switches branches."

# Lists for refusals: at most 10 entries, then a count of the rest.
list() { # items...
  local shown=("${@:1:10}")
  printf '  %s\n' "${shown[@]}"
  (($# <= 10)) || printf '  ... and %d more\n' $(($# - 10))
}

# --- the worktree -------------------------------------------------------------------------------
if [[ $arg == */* ]]; then
  path=$arg
  [[ $path == /* ]] || path=$PWD/$path
else
  path=$main/.claude/worktrees/$arg
fi
path=${path%/}
[[ -d $path ]] && path=$(cd "$path" && pwd -P)
[[ $path == "$main" ]] && die 2 "$path is the main folder, not a lane's worktree"

# git worktree list -z: one NUL-terminated field per line of the porcelain format.
registered="" branch="" cur=""
while IFS= read -r -d '' field; do
  case $field in
    "worktree "*) cur=${field#worktree } ;;
    *) [[ $cur == "$path" ]] || continue ;;&
    "") ;;
    "branch refs/heads/"*) branch=${field#branch refs/heads/} ;;
    detached) branch="" ;;
    locked*) die 2 "$path is locked (git worktree unlock it first); nothing changed" ;;
  esac
  [[ $cur == "$path" ]] && registered=1
done < <(git -C "$main" worktree list --porcelain -z)

if [[ -z $registered ]]; then
  if [[ -e $path ]]; then
    die 2 "$path is not a registered worktree (git worktree list doesn't show it), so there is no branch or PR to check; nothing changed. If it's a leftover folder, check what it holds before deleting it by hand."
  fi
  die 2 "$path is not a registered worktree, and there's nothing there; nothing changed."
fi
[[ -n $branch ]] || die 2 "$path has a detached HEAD, so there is no branch to check; nothing changed"
tip=$(git -C "$main" rev-parse "refs/heads/$branch")

# --- the PR -------------------------------------------------------------------------------------
# PRs are squash-merged, so the branch is never an ancestor of main: "merged" is the PR's state.
# The branch's tip must be the head the PR merged, or the branch holds commits main never got.
prs=$(gh pr list --repo "$REPO" --head "$branch" --state merged --json number,headRefOid,url \
  --jq '.[] | [.number, .headRefOid, .url] | @tsv') ||
  die 1 "could not read $branch's PRs from GitHub; nothing changed"
pr="" merged=()
while IFS=$'\t' read -r number oid url; do
  [[ -n $number ]] || continue
  merged+=("PR #$number merged ${oid:0:7}")
  [[ $oid == "$tip" ]] && pr="#$number $url"
done <<<"$prs"
((${#merged[@]})) ||
  die 2 "no merged PR has $branch as its head; nothing changed. Run this after the PR merges."
if [[ -z $pr ]]; then
  die 2 "$branch is at ${tip:0:7}, but $(printf '%s, ' "${merged[@]}" | sed 's/, $//'): the branch has commits no merged PR carries; nothing changed. Push them in a new PR, or delete the branch by hand if they're not wanted."
fi

# --- the worktree's own changes -----------------------------------------------------------------
# Inside the sandbox, protected paths that don't exist are covered by a bind mount of /dev/null
# (docs/agents/sandbox.md, "Phantom files"), and git status lists each as an untracked file. They
# are recognised by what they are: a character device with /dev/null's numbers (1:3). Git never
# checks out a device, and making one needs root, so no lane's work looks like that. A symlink to
# /dev/null is a symlink, not a device (stat doesn't follow it).
is_placeholder() { # path
  [[ $(stat -c '%F|%t:%T' -- "$1" 2>/dev/null) == 'character special file|1:3' ]]
}
work=() placeholders=()
while IFS= read -r -d '' entry; do
  if [[ $entry == '?? '* ]] && is_placeholder "$path/${entry:3}"; then
    placeholders+=("${entry:3}")
  else
    work+=("$entry")
  fi
done < <(git -C "$path" status --porcelain=v1 -z --untracked-files=all --no-renames)
if ((${#work[@]})); then
  die 2 "$path has uncommitted work; nothing changed. Commit and push it, or remove it yourself:
$(list "${work[@]}")"
fi

# --- main ---------------------------------------------------------------------------------------
git -C "$main" fetch --quiet origin main || die 1 "could not fetch origin main; nothing changed"
old=$(git -C "$main" rev-parse HEAD)
new=$(git -C "$main" rev-parse refs/remotes/origin/main)
if ! git -C "$main" merge-base --is-ancestor "$old" "$new"; then
  die 2 "main has diverged from origin/main (main has commits origin/main doesn't), so it can't be fast-forwarded; nothing changed."
fi
dirty=()
while IFS= read -r -d '' entry; do
  dirty+=("$entry")
done < <(git -C "$main" status --porcelain=v1 -z --untracked-files=no --no-renames)
if ((${#dirty[@]})); then
  die 2 "the main folder has uncommitted changes to tracked files; nothing changed. A half-applied update shows here: restore the files (git restore <paths>), then rerun.
$(list "${dirty[@]}")"
fi

# --- does it need the host? --------------------------------------------------------------------
# Each reason stops the run before any change; the same command outside the sandbox does it all.
host=()

# Paths the sandbox can't write in the main folder (sandbox.md, "When git does need the host"):
# a fast-forward there stops half-way with "unable to unlink". Ask the filesystem rather than
# guess whether this is the sandbox: outside it, the same paths are writable and the run goes on.
writable() { # repo path -> can git replace, delete or create it in the main folder?
  local p=$main/$1 d
  if [[ -e $p || -L $p ]]; then
    [[ -w $p ]] || return 1
  fi
  d=$(dirname "$p")
  while [[ ! -e $d ]]; do d=$(dirname "$d"); done
  [[ -w $d ]]
}
blocked=()
while IFS= read -r -d '' changed; do
  writable "$changed" || blocked+=("$changed")
done < <(git -C "$main" diff --name-only -z "$old" "$new" -- \
  .claude/settings.json .claude/hooks .claude/skills)
if ((${#blocked[@]})); then
  host+=("the update to main changes paths the sandbox can't write:
$(list "${blocked[@]}")")
fi

# Placeholders are mount points, so the worktree folder can't be deleted while they're mounted
# ("Device or resource busy", 8 Nov). A mount can also hide a real file at the same path. Outside
# the sandbox they're gone, and git status shows what's really there.
if ((${#placeholders[@]})); then
  host+=("the worktree holds sandbox placeholders, which can't be deleted from inside the sandbox and may hide real files:
$(list "${placeholders[@]}")")
fi

if ((${#host[@]})); then
  {
    echo "after-merge: needs the host; nothing changed."
    printf -- '- %s\n' "${host[@]}"
    echo "Run this outside the sandbox (your own terminal, or the session retries it with the sandbox off):"
    printf '  cd %q && scripts/after-merge.sh %q\n' "$main" "$path"
  } >&2
  exit 3
fi

# --- act ----------------------------------------------------------------------------------------
echo "PR: $pr"
if [[ $old == "$new" ]]; then
  echo "main: already at origin/main (${old:0:7})"
else
  git -C "$main" merge --ff-only --quiet "$new" ||
    die 1 "fast-forwarding main failed; check git -C $main status"
  n=$(git -C "$main" rev-list --count "$old..$new")
  ((n == 1)) && commits=commit || commits=commits
  echo "main: fast-forwarded ${old:0:7}..${new:0:7} ($n $commits)"
fi

# From here a failure doesn't stop the run: each step that doesn't finish goes on a list of
# commands to run outside the sandbox. The worktree was checked clean above, so deleting what's
# left of its folder loses nothing.
rest=()
if removed=$(git -C "$main" worktree remove "$path" 2>&1); then
  echo "worktree: removed $path"
else
  printf '%s\n' "$removed" | sed 's/^/  git: /' >&2
fi
[[ -e $path ]] && rest+=("rm -rf $(printf %q "$path")")
git -C "$main" worktree prune 2>/dev/null || true
if ((${#rest[@]})) || git -C "$main" worktree list --porcelain | grep -qxF "worktree $path"; then
  rest+=("git -C $(printf %q "$main") worktree prune")
fi

# git branch -D also drops the branch's section from .git/config, which the sandbox protects: it
# warns, but the ref is gone (sandbox.md). So check the ref, not the exit code.
git -C "$main" branch -D "$branch" >/dev/null 2>&1 || true
if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  rest+=("git -C $(printf %q "$main") branch -D $(printf %q "$branch")")
else
  echo "branch: deleted $branch (was ${tip:0:7})"
fi

if ((${#rest[@]})); then
  {
    echo "after-merge: main is updated, but the rest didn't finish. Run these outside the sandbox:"
    printf '  %s\n' "${rest[@]}"
  } >&2
  exit 3
fi

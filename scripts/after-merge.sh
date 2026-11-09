#!/usr/bin/env bash
# After the admin merges a lane's PR: fast-forward main in the main folder, remove the lane's
# worktree, prune, and delete its branch (#77). Every check runs before the first change, so a
# refusal changes nothing. Tests: scripts/after-merge.test.sh.
# Needs bash 4.4+ (wait $! on a process substitution), git 2.36+ (worktree list -z) and an
# authenticated gh.
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

It fast-forwards main to origin/main (never switches branch, never merges), removes the worktree
(its ignored files too, such as node_modules), runs git worktree prune and deletes the worktree's
branch, then prints what it did.

It refuses, changing nothing, unless the branch's PR into main has merged with the branch's
commits, the worktree has no uncommitted work, and main can fast-forward.

Exit codes: 0 done; 1 a git or gh command failed; 2 refused, nothing changed; 3 needs the
host: run the printed command outside the sandbox.
EOF
}

die() { # code message
  printf 'after-merge: %s\n' "$2" >&2
  exit "$1"
}

# Lists in messages: at most 10 entries, then a count of the rest.
list() { # items...
  local shown=("${@:1:10}")
  printf '  %s\n' "${shown[@]}"
  (($# <= 10)) || printf '  ... and %d more\n' $(($# - 10))
}

# Inside the sandbox, protected paths that don't exist are covered by a bind mount of /dev/null
# (docs/agents/sandbox.md, "Phantom files"), and git status lists each as an untracked file. They
# are recognised by what they are: a character device with /dev/null's numbers (1:3). Git never
# checks out a device, and making one needs root, so no lane's work looks like that. A symlink to
# /dev/null is a symlink, not a device (stat doesn't follow it).
is_placeholder() { # path
  [[ $(stat -c '%F|%t:%T' -- "$1" 2>/dev/null) == 'character special file|1:3' ]]
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
main_git=$(cd "$common" && pwd -P)
main=$(dirname "$main_git")
here=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
[[ $here == "$main" ]] || die 2 "run it from the main folder ($main), not from $here"
main_branch=$(git -C "$main" symbolic-ref --quiet --short HEAD) ||
  die 2 "the main folder is on a detached HEAD, not main. This script never switches branches."
[[ $main_branch == main ]] ||
  die 2 "the main folder is on $main_branch, not main. This script never switches branches."

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

# Is $path registered? Sets wt_registered, wt_branch and wt_locked from git worktree list -z:
# one NUL-terminated field per line of the porcelain format.
find_worktree() {
  local field cur=""
  wt_registered="" wt_branch="" wt_locked=""
  while IFS= read -r -d '' field; do
    if [[ $field == "worktree "* ]]; then
      cur=${field#worktree }
      [[ $cur == "$path" ]] && wt_registered=1
      continue
    fi
    [[ $cur == "$path" ]] || continue
    case $field in
      "branch refs/heads/"*) wt_branch=${field#branch refs/heads/} ;;
      locked*) wt_locked=1 ;;
    esac
  done < <(git -C "$main" worktree list --porcelain -z)
  # A loop over < <(...) never sees the command fail; wait $! does. Without it a failed git
  # would read as an empty list: not registered, a clean worktree, no paths to check.
  wait $! || die 1 "git worktree list failed"
}
find_worktree
branch=$wt_branch

if [[ -z $wt_registered ]]; then
  if [[ -e $path ]]; then
    die 2 "$path is not a registered worktree (git worktree list doesn't show it), so there is no branch or PR to check; nothing changed. If it's a leftover folder, check what it holds before deleting it by hand."
  fi
  die 2 "$path is not a registered worktree, and there's nothing there; nothing changed."
fi
[[ -z $wt_locked ]] || die 2 "$path is locked (git worktree unlock it first); nothing changed"
[[ -n $branch ]] || die 2 "$path has a detached HEAD, so there is no branch to check; nothing changed"
tip=$(git -C "$main" rev-parse "refs/heads/$branch")

# --- the PR -------------------------------------------------------------------------------------
# PRs are squash-merged, so the branch is never an ancestor of main: "merged" is the PR's state.
# Every commit on the branch must be in what the PR merged: its head is the branch's tip, or
# comes after it when "Update branch" on GitHub (ADR-0002) added a merge commit. That commit
# isn't local, so fetch it from refs/pull/N/head, which GitHub keeps after the merge.
prs=$(gh pr list --repo "$REPO" --base main --head "$branch" --state merged \
  --json number,headRefOid,url --jq '.[] | [.number, .headRefOid, .url] | @tsv') ||
  die 1 "could not read $branch's PRs from GitHub; nothing changed"
pr="" merged=()
while IFS=$'\t' read -r number oid url; do
  [[ -n $number ]] || continue
  merged+=("PR #$number merged ${oid:0:7}")
  if [[ $oid != "$tip" ]]; then
    git -C "$main" cat-file -e "$oid^{commit}" 2>/dev/null ||
      git -C "$main" fetch --quiet origin "refs/pull/$number/head" </dev/null 2>/dev/null || true
    git -C "$main" merge-base --is-ancestor "$tip" "$oid" 2>/dev/null || continue
  fi
  pr="#$number $url"
done <<<"$prs"
((${#merged[@]})) ||
  die 2 "no merged PR into main has $branch as its head; nothing changed. Run this after the PR merges."
if [[ -z $pr ]]; then
  die 2 "$branch is at ${tip:0:7}, but $(printf '%s, ' "${merged[@]}" | sed 's/, $//'): the branch has commits no merged PR carries; nothing changed. Push them in a new PR, or delete the branch by hand if they're not wanted."
fi

# --- the worktree's own changes -----------------------------------------------------------------
# The lane controls its folder (the .git file) and, from the sandbox, its admin folder in
# .git/worktrees/ (gitdir, commondir). This script may run outside the sandbox, so before running
# git in the worktree, check the link leads back to this repository: a link to another repo
# would bring that repo's config, and core.fsmonitor runs a command on git status.
resolve() { # dir [base] -> its physical path (relative to base), or nothing
  local d=$1
  [[ $d == /* ]] || d=${2:-.}/$d
  (cd "$d" 2>/dev/null && pwd -P) || true
}
link="" admin="" back="" shared=""
if [[ -f $path/.git && ! -L $path/.git ]]; then
  link=$(<"$path/.git")
fi
if [[ $link == "gitdir: "* ]]; then
  admin=$(resolve "${link#gitdir: }" "$path")
fi
if [[ -n $admin && $(dirname "$admin") == "$main_git/worktrees" &&
  -f $admin/gitdir && -f $admin/commondir ]]; then
  back=$(resolve "$(dirname "$(<"$admin/gitdir")")" "$admin")
  shared=$(resolve "$(<"$admin/commondir")" "$admin")
fi
if [[ -z $admin || $back != "$path" || $shared != "$main_git" ]]; then
  die 2 "$path's git link (its .git file, or gitdir and commondir in .git/worktrees/) doesn't point back at $main_git, so git there could read another repository's config; nothing changed. Check those files by hand."
fi

# git status through the checked admin folder, with fsmonitor off as a second guard.
lane_status() { # status options...
  (cd "$path" && git -c core.fsmonitor=false --git-dir="$admin" --work-tree="$path" \
    status --porcelain=v1 -z --no-renames "$@")
}
work=() placeholders=() ignored=()
while IFS= read -r -d '' entry; do
  if [[ $entry == '?? '* ]] && is_placeholder "$path/${entry:3}"; then
    placeholders+=("${entry:3}")
  else
    work+=("$entry")
  fi
done < <(lane_status --untracked-files=all)
wait $! || die 1 "git status failed in $path; nothing changed"
if ((${#work[@]})); then
  die 2 "$path has uncommitted work; nothing changed. Commit and push it, or remove it yourself:
$(list "${work[@]}")"
fi
# Ignored files (node_modules, a .env.local) go with the folder; name them in the output.
while IFS= read -r -d '' entry; do
  if [[ $entry == '!! '* ]] && ! is_placeholder "$path/${entry:3}"; then
    ignored+=("${entry:3}")
  fi
done < <(lane_status --untracked-files=normal --ignored)
wait $! || die 1 "git status failed in $path; nothing changed"

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
wait $! || die 1 "git status failed in the main folder; nothing changed"
if ((${#dirty[@]})); then
  die 2 "the main folder has uncommitted changes to tracked files; nothing changed. A half-applied update shows here: restore the files (git restore <paths>), then rerun.
$(list "${dirty[@]}")"
fi

# --- does it need the host? --------------------------------------------------------------------
# Each reason stops the run before any change; the same command outside the sandbox does it all.
host_reasons=()

# A path the update touches that the sandbox can't write (.claude/settings.json, hooks, skills:
# sandbox.md, "When git does need the host") makes the fast-forward stop half-way with "unable
# to unlink". Ask the filesystem about every touched path rather than guess whether this is the
# sandbox: outside it, the same paths are writable and the run goes on.
writable() { # repo path -> can git replace, delete or create it in the main folder?
  local p=$main/$1 d
  if [[ -e $p || -L $p ]]; then
    is_placeholder "$p" && return 1
    [[ -w $p ]] || return 1
  fi
  d=$(dirname "$p")
  while [[ ! -e $d ]]; do d=$(dirname "$d"); done
  [[ -d $d && -w $d ]]
}
blocked=()
while IFS= read -r -d '' changed; do
  writable "$changed" || blocked+=("$changed")
done < <(git -C "$main" diff --name-only -z "$old" "$new")
wait $! || die 1 "git diff of main..origin/main failed; nothing changed"
if ((${#blocked[@]})); then
  host_reasons+=("the update to main changes paths the sandbox can't write:
$(list "${blocked[@]}")")
fi

# Placeholders are mount points, so the worktree folder can't be deleted while they're mounted
# ("Device or resource busy", 8 Nov). A mount can also hide a real file at the same path. Outside
# the sandbox they're gone, and git status shows what's really there.
if ((${#placeholders[@]})); then
  host_reasons+=("the worktree holds sandbox placeholders, which can't be deleted from inside the sandbox and may hide real files:
$(list "${placeholders[@]}")")
fi

if ((${#host_reasons[@]})); then
  {
    echo "after-merge: needs the host; nothing changed."
    printf -- '- %s\n' "${host_reasons[@]}"
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
    die 1 "fast-forwarding main failed; check: git -C $(printf %q "$main") status"
  n=$(git -C "$main" rev-list --count "$old..$new")
  ((n == 1)) && commits=commit || commits=commits
  echo "main: fast-forwarded ${old:0:7}..${new:0:7} ($n $commits)"
fi

# Plain git worktree remove (no --force) checks the worktree is clean before it deletes
# anything. If it refused, the folder and its admin folder are intact: stop and say why. If it
# started deleting, git found it clean, so what's left of the folder can go; any step that
# didn't finish goes on a list of commands to run outside the sandbox.
finish_outside=()
if removed=$(git -C "$main" worktree remove "$path" 2>&1); then
  echo "worktree: removed $path"
  ((${#ignored[@]} == 0)) || printf 'worktree: with its ignored files:\n%s\n' "$(list "${ignored[@]}")"
elif [[ -e $path/.git && -d $admin ]]; then
  die 1 "main is updated, but git worktree remove refused, so the worktree and branch stay:
$(printf '%s\n' "$removed" | sed 's/^/  git: /')"
else
  printf '%s\n' "$removed" | sed 's/^/  git: /' >&2
fi
git -C "$main" worktree prune 2>/dev/null || true
[[ -e $path ]] && finish_outside+=("rm -rf $(printf %q "$path")")
find_worktree
if ((${#finish_outside[@]})) || [[ -n $wt_registered || -e $admin ]]; then
  finish_outside+=("git -C $(printf %q "$main") worktree prune")
else
  echo "worktrees: pruned"
fi

# git branch -D also drops the branch's section from .git/config, which the sandbox protects: it
# warns, but the ref is gone (sandbox.md). So check the ref, not the exit code.
git -C "$main" branch -D "$branch" >/dev/null 2>&1 || true
if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  finish_outside+=("git -C $(printf %q "$main") branch -D $(printf %q "$branch")")
else
  echo "branch: deleted $branch (was ${tip:0:7})"
fi

if ((${#finish_outside[@]})); then
  {
    echo "after-merge: main is updated, but the rest didn't finish. Run these outside the sandbox:"
    printf '  %s\n' "${finish_outside[@]}"
  } >&2
  exit 3
fi

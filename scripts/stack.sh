#!/usr/bin/env bash
# The one way to build a split as a native GitHub stack (#264; CONSTRAINTS.md, "Split size"), for
# local and cloud lanes alike. Plain git plus `gh api` over REST: the stack endpoints
# (repos/{o}/{r}/stacks, stacks/{n}/add) and pulls are REST, while `gh stack` and `gh pr` reach
# GraphQL, which the cloud GitHub proxy refuses. It never merges a PR or a stack, never takes a part out of a stack,
# never force-pushes and never moves a base by hand: merging stays with the admin.
# Tests: scripts/stack.test.sh. Needs git 2.38+ (merge-tree --write-tree) and an authenticated gh.
set -euo pipefail
shopt -s inherit_errexit # a failed gh inside $( … ) stops the script too

REPO=sssoto17/sunny-pastures
P=repos/$REPO

usage() {
  cat >&2 <<'EOF'
usage: scripts/stack.sh <command> ...

  open [--base <branch>] [--label <name>]... <branch>=<body-file>...
      Push the parts, open each PR on the part below (part 1 on --base, default main), and link
      them as one native stack. Each part must be built on the one below and add commits of its
      own. A body file's first line is the PR title; the rest is the body. Run it again after a
      failure: it reuses the PRs and the stack it finds.
  add <pr> [--label <name>]... <branch>=<body-file>
      Append a part on top of the stack that holds <pr>.
  update <pr>
      After an edit to a lower part: merge each open part into the one above it (no rebase), then
      push them all, fast-forward only.
  refresh <pr>
      After a lower part merged: GitHub has rebased the parts above it and moved the lowest
      open part's base. Move each local branch to GitHub's rebased one, and stop on a branch
      with local commits the rebase doesn't have. It never merges main into a part: the stack
      merge needs the parts the way GitHub left them.
  status <pr>
      Each part of the stack: its PR, state, base, approvals, checks, and whether the local
      branch matches GitHub's.

<pr> is any PR in the stack. Run from the repo, in the worktree that holds the parts.
Exit codes: 0 done; 1 a git or gh command failed; 2 refused, nothing pushed or created.
EOF
}

die() { # code message
  printf 'stack: %s\n' "$2" >&2
  exit "$1"
}

# --- parts --------------------------------------------------------------------------------------
branches=() bodies=() labels=()
parse_parts() { # <branch>=<body-file>... -> branches, bodies; checks each before anything runs
  local arg b f
  for arg in "$@"; do
    [[ $arg == *=* ]] || die 2 "a part is <branch>=<body-file>, got: $arg"
    b=${arg%%=*} f=${arg#*=}
    git rev-parse -q --verify "refs/heads/$b" >/dev/null || die 2 "no local branch $b"
    [[ -r $f ]] || die 2 "can't read the body file $f for $b"
    [[ -n $(head -n1 "$f" | tr -d '[:space:]') ]] || die 2 "the body file $f has no title on its first line"
    branches+=("$b") bodies+=("$f")
  done
}

check_chain() { # base-ref branch... : each part is built on the one below and adds commits
  local below=$1 b
  shift
  for b in "$@"; do
    git merge-base --is-ancestor "$below" "$b" || die 2 "$b is not built on ${below#origin/}: rebuild it on top, the stack can't hold a hand-made chain"
    [[ -n $(git rev-list -n1 "$below..$b") ]] || die 2 "$b has no commits of its own on top of ${below#origin/}"
    below=$b
  done
}

# --- GitHub -------------------------------------------------------------------------------------
open_pr_for() { # head -> "<number> <base>" of its open PR, or nothing
  gh api "$P/pulls?head=${REPO%%/*}:$1&state=open" --jq '.[0] | select(. != null) | "\(.number) \(.base.ref)"'
}

ensure_pr() { # head base body-file -> prints the PR number; reuses an open PR on the same base
  local head=$1 base=$2 f=$3 found title body
  found=$(open_pr_for "$head")
  if [[ -n $found ]]; then
    [[ ${found#* } == "$base" ]] || die 2 "#${found%% *} already has $head on ${found#* }, not on $base: a hand-chained PR. Close it, or retarget it to $base, then run this again"
    echo "${found%% *}"
    return
  fi
  title=$(head -n1 "$f")
  body=$(tail -n +2 "$f" | sed '/./,$!d')
  gh api -X POST "$P/pulls" -f title="$title" -f head="$head" -f base="$base" -f body="$body" --jq .number
}

add_labels() { # pr
  local l
  for l in "${labels[@]}"; do
    gh api -X POST "$P/issues/$1/labels" -f "labels[]=$l" --jq 'length' >/dev/null
  done
}

stack_of() { # pr -> its stack's number, or nothing
  gh api "$P/pulls/$1" --jq '.stack.number // empty' || die 1 "can't read PR #$1"
}

stack_parts() { # stack -> lines "<number> <state> <head ref> <head sha> <merged yes|no>", in order
  gh api "$P/stacks/$1" --jq '.pull_requests[] | "\(.number) \(.state) \(.head.ref) \(.head.sha) \(if .merged_at then "yes" else "no" end)"'
}

require_stack() { # pr -> stack number
  local s
  s=$(stack_of "$1")
  [[ -n $s ]] || die 2 "#$1 is not in a stack: open the stack with 'scripts/stack.sh open'"
  echo "$s"
}

# --- git ----------------------------------------------------------------------------------------
fetch() { # branch... : force-update each remote-tracking ref, as GitHub may have rebased it
  local b refspecs=()
  for b in "$@"; do refspecs+=("+refs/heads/$b:refs/remotes/origin/$b"); done
  git fetch -q origin "${refspecs[@]}"
}

checked_out_in() { # branch -> the worktree that has it checked out, or nothing
  git worktree list --porcelain | awk -v ref="branch refs/heads/$1" '/^worktree /{wt=substr($0,10)} $0==ref{print wt}'
}

move_branch() { # branch new-sha : to a commit that contains every local commit (checked first)
  local b=$1 new=$2 wt here
  wt=$(checked_out_in "$b") here=$(git rev-parse --show-toplevel)
  if [[ -z $wt ]]; then
    git update-ref "refs/heads/$b" "$new"
  elif [[ $wt == "$here" ]]; then
    git reset -q --keep "$new"
  else
    die 2 "$b is checked out in $wt: run this there"
  fi
}

# --- commands -----------------------------------------------------------------------------------
cmd_open() {
  local base=main
  while (($#)); do
    case $1 in
      --base) base=$2; shift 2 ;;
      --label) labels+=("$2"); shift 2 ;;
      *) break ;;
    esac
  done
  parse_parts "$@"
  ((${#branches[@]} >= 2)) || die 2 "a stack needs at least 2 parts; one part is a plain PR"
  git fetch -q origin "+refs/heads/$base:refs/remotes/origin/$base"
  check_chain "origin/$base" "${branches[@]}"

  # Refuse a hand-chained PR before anything is pushed or created.
  local i below found nums=()
  for i in "${!branches[@]}"; do
    below=$base
    ((i == 0)) || below=${branches[i - 1]}
    found=$(open_pr_for "${branches[i]}")
    [[ -z $found || ${found#* } == "$below" ]] ||
      die 2 "#${found%% *} already has ${branches[i]} on ${found#* }, not on $below: a hand-chained PR. Close it, or retarget it to $below, then run this again"
  done

  git push -q origin "${branches[@]}"
  for i in "${!branches[@]}"; do
    below=$base
    ((i == 0)) || below=${branches[i - 1]}
    nums+=("$(ensure_pr "${branches[i]}" "$below" "${bodies[i]}")")
    add_labels "${nums[i]}"
  done

  local s n same=1 first
  first=$(stack_of "${nums[0]}")
  for n in "${nums[@]}"; do [[ $(stack_of "$n") == "$first" ]] || same=0; done
  if [[ -n $first && $same == 1 ]]; then
    s=$first
  else
    for n in "${nums[@]}"; do
      [[ -z $(stack_of "$n") ]] || die 2 "#$n is already in another stack: take it out of that stack in the UI first"
    done
    local fields=()
    for n in "${nums[@]}"; do fields+=(-F "pull_requests[]=$n"); done
    s=$(gh api -X POST "$P/stacks" "${fields[@]}" --jq .number) ||
      die 1 "PRs $(printf '#%s ' "${nums[@]}")are open but not stacked; run the same command again"
  fi
  cmd_status "${nums[0]}"
}

cmd_add() {
  (($# >= 1)) || die 2 "add needs a PR number"
  local pr=$1
  shift
  while (($#)); do
    case $1 in
      --label) labels+=("$2"); shift 2 ;;
      *) break ;;
    esac
  done
  parse_parts "$@"
  ((${#branches[@]} == 1)) || die 2 "add takes one part"
  local s top
  s=$(require_stack "$pr")
  top=$(stack_parts "$s" | awk '$2 == "open" { b = $3 } END { print b }')
  [[ -n $top ]] || die 2 "stack #$s has no open part to build on"
  fetch "$top"
  check_chain "origin/$top" "${branches[0]}"
  git push -q origin "${branches[0]}"
  local n
  n=$(ensure_pr "${branches[0]}" "$top" "${bodies[0]}")
  add_labels "$n"
  gh api -X POST "$P/stacks/$s/add" -F "pull_requests[]=$n" --jq .number >/dev/null ||
    die 1 "#$n is open on $top but not in stack #$s; run the same command again"
  cmd_status "$n"
}

cmd_update() {
  (($# == 1)) || die 2 "update needs a PR number"
  local s heads=() num state head sha merged
  s=$(require_stack "$1")
  while read -r num state head sha merged; do
    [[ $state == open ]] && heads+=("$head")
  done < <(stack_parts "$s")
  ((${#heads[@]})) || die 2 "stack #$s has no open part"
  local b
  for b in "${heads[@]}"; do
    git rev-parse -q --verify "refs/heads/$b" >/dev/null || die 2 "no local branch $b: fetch it first"
  done
  fetch "${heads[@]}"
  for b in "${heads[@]}"; do
    git merge-base --is-ancestor "origin/$b" "$b" ||
      die 2 "$b is behind GitHub's: run 'scripts/stack.sh refresh $1' first (no force-push)"
  done

  local i lower upper wt here tree commit merged_any=0
  here=$(git rev-parse --show-toplevel)
  for ((i = 1; i < ${#heads[@]}; i++)); do
    lower=${heads[i - 1]} upper=${heads[i]}
    git merge-base --is-ancestor "$lower" "$upper" && continue
    merged_any=1
    wt=$(checked_out_in "$upper")
    if [[ $wt == "$here" ]]; then
      git merge -q --no-edit "$lower" >/dev/null 2>&1 || {
        git merge --abort 2>/dev/null || true
        die 2 "merging $lower into $upper conflicts: merge it by hand, then run update again (nothing pushed)"
      }
    elif [[ -n $wt ]]; then
      die 2 "$upper is checked out in $wt: run this there (nothing pushed)"
    else
      tree=$(git merge-tree --write-tree "$upper" "$lower" 2>/dev/null) ||
        die 2 "merging $lower into $upper conflicts: merge it by hand, then run update again (nothing pushed)"
      commit=$(git commit-tree "$tree" -p "$upper" -p "$lower" -m "Merge branch '$lower' into $upper")
      git update-ref "refs/heads/$upper" "$commit"
    fi
    echo "merged $lower into $upper"
  done

  local ahead=0
  for b in "${heads[@]}"; do
    [[ $(git rev-parse "$b") == $(git rev-parse "origin/$b") ]] || ahead=1
  done
  if ((merged_any == 0 && ahead == 0)); then
    echo "stack #$s is up to date"
    return
  fi
  git push -q origin "${heads[@]}"
  cmd_status "$1"
}

cmd_refresh() {
  (($# == 1)) || die 2 "refresh needs a PR number"
  local s num state head sha merged heads=()
  s=$(require_stack "$1")
  while read -r num state head sha merged; do
    if [[ $state == open ]]; then
      heads+=("$head")
    else
      echo "#$num $( [[ $merged == yes ]] && echo merged || echo closed)"
    fi
  done < <(stack_parts "$s")
  ((${#heads[@]})) || { echo "stack #$s has no open part"; return; }

  # Plan every branch before moving any.
  local b old new loc moves=() extra
  for b in "${heads[@]}"; do
    old=$(git rev-parse -q --verify "refs/remotes/origin/$b" || true)
    fetch "$b"
    new=$(git rev-parse "refs/remotes/origin/$b")
    loc=$(git rev-parse -q --verify "refs/heads/$b" || true)
    if [[ -z $loc || $loc == "$new" ]] || git merge-base --is-ancestor "$new" "$loc"; then
      continue # no local branch, in sync, or only ahead (push it with update)
    fi
    if [[ $loc == "$old" ]] || git merge-base --is-ancestor "$loc" "$new"; then
      moves+=("$b $new")
      continue
    fi
    extra=$(git cherry "$new" "$loc" | awk '$1 == "+" { print $2 }')
    if [[ -n $extra ]]; then
      die 2 "$b has commits GitHub's restack doesn't have; cherry-pick them onto origin/$b by hand (nothing moved):
$(git log --no-walk --format='  %h %s' $extra)"
    fi
    moves+=("$b $new")
  done
  local m
  for m in "${moves[@]}"; do
    move_branch "${m%% *}" "${m#* }"
    echo "moved ${m%% *} to GitHub's ${m#* }"
  done
  cmd_status "$1"
}

cmd_status() {
  (($# == 1)) || die 2 "status needs a PR number"
  local s
  s=$(require_stack "$1")
  gh api "$P/stacks/$s" --jq '"stack #\(.number) on \(.base.ref) (\(if .open then "open" else "closed" end))"'
  local parts=() line
  while IFS= read -r line; do parts+=("$line"); done < <(stack_parts "$s")
  local i num state head sha merged base reviews checks loc sync
  for i in "${!parts[@]}"; do
    read -r num state head sha merged <<<"${parts[i]}"
    if [[ $state != open ]]; then
      printf '%s/%s #%s %s\n' $((i + 1)) "${#parts[@]}" "$num" "$([[ $merged == yes ]] && echo merged || echo closed)"
      continue
    fi
    base=$(gh api "$P/pulls/$num" --jq .base.ref)
    reviews=$(gh api "$P/pulls/$num/reviews?per_page=100" --jq '
      [group_by(.user.login)[] | map(select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED")) | last | select(. != null)]
      | (map(select(.state == "APPROVED") | .user.login)) as $ok
      | (map(select(.state == "CHANGES_REQUESTED") | .user.login)) as $no
      | if ($ok | length) == 0 and ($no | length) == 0 then "no approval"
        else ([if ($ok | length) > 0 then "approved by " + ($ok | join(", ")) else empty end,
               if ($no | length) > 0 then "changes requested by " + ($no | join(", ")) else empty end] | join("; ")) end')
    checks=$(gh api "$P/commits/$sha/check-runs?per_page=100" --jq '
      .check_runs as $r
      | ([$r[] | select(.status == "completed" and (.conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral"))] | length) as $ok
      | ([$r[] | select(.status != "completed")] | length) as $wait
      | [$r[] | select(.status == "completed" and .conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral") | .name] as $bad
      | "\($ok) passing" + (if $wait > 0 then ", \($wait) pending" else "" end) + (if ($bad | length) > 0 then ", failing: " + ($bad | join(", ")) else "" end)')
    loc=$(git rev-parse -q --verify "refs/heads/$head" || true)
    if [[ -z $loc ]]; then sync="no local branch"
    elif [[ $loc == "$sha" ]]; then sync="local in sync"
    elif git merge-base --is-ancestor "$sha" "$loc" 2>/dev/null; then sync="local ahead: update"
    else sync="local differs: refresh"
    fi
    printf '%s/%s #%s %s base %s; %s; checks %s; %s\n' $((i + 1)) "${#parts[@]}" "$num" "$head" "$base" "$reviews" "$checks" "$sync"
  done
}

case ${1:-} in
  -h | --help) usage; exit 0 ;;
  open | add | update | refresh | status) cmd=$1; shift; "cmd_$cmd" "$@" ;;
  "") usage; exit 2 ;;
  *) usage; die 2 "unknown command: $1" ;;
esac

#!/usr/bin/env bash
# The one way to build a split as a native GitHub stack (#264; CONSTRAINTS.md, "Split size"), for
# local and cloud lanes alike: git plus `gh api` over REST (pulls, stacks), since `gh stack` and
# `gh pr` reach GraphQL, which the cloud proxy refuses. Each part's PR is opened by
# scripts/open-pr.sh, as sunny-factory[bot], and the open-pr workflow links it into the stack of the
# part below with the App's token; whatever the run didn't link, this links with the lane's token
# (#336). With --as-admin (#385) open-pr.sh opens each part as the admin, no run links it, and this
# links every part with the lane's token. It never merges, never takes a part out of
# a stack and never moves a base by hand: merging stays with the admin. It force-pushes only a
# stack's own part branches, each with a lease (update, refresh), never main or the stack's base.
# Tests: scripts/stack.test.sh. Needs bash 4+, git and an authenticated gh.
set -euo pipefail
shopt -s inherit_errexit # a failed gh inside $( … ) stops the script too

REPO=sssoto17/sunny-pastures
P=repos/$REPO
OPEN_PR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/open-pr.sh

usage() {
  cat >&2 <<'EOF'
usage: scripts/stack.sh <command> ...

  open [--as-admin] [--base <branch>] [--label <name>]... <branch>=<body-file>...
      Push the parts, open each PR on the part below (part 1 on --base, default main), and link
      them as one native stack. Each part must be built on the one below and add commits of its
      own. A body file's first line is the PR title; the rest is the body. Run it again after a
      failure: it reuses the PRs and the stack it finds.
  add <pr> [--as-admin] [--label <name>]... <branch>=<body-file>
      Append a part on top of the stack that holds <pr>.
  --as-admin is passed to scripts/open-pr.sh for each part: only for admin-owned paths, on a run
      the admin started with OPEN_PR_AS_ADMIN (#385). The parts are then linked with your token.
  update <pr>
      After an edit to a lower part: rebase each open part onto the new head of the one below,
      then push them, each with a lease on the head it fetched. The stack stays linear.
  refresh <pr>
      After a lower part merged (GitHub retargets but doesn't rebase): rebase the open parts onto
      the base, dropping the merged part's commits, then push as update does.
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
branches=() bodies=() labels=() open_pr_flags=()
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
  for b in "$@"; do # part 1 may sit on an older base: GitHub diffs it from the merge base
    [[ $below == origin/* ]] || git merge-base --is-ancestor "$below" "$b" ||
      die 2 "$b is not built on $below: rebuild it on top of $below"
    [[ -n $(git rev-list -n1 "$below..$b") ]] || die 2 "$b has no commits of its own on top of ${below#origin/}"
    below=$b
  done
}

# --- GitHub -------------------------------------------------------------------------------------
open_pr_for() { # head -> "<number> <base>" of its open PR, or nothing
  gh api "$P/pulls?head=${REPO%%/*}:$1&state=open" --jq '.[0] | select(. != null) | "\(.number) \(.base.ref)"'
}

refuse_other_base() { # head base "<number> <base>"|"" : an open PR for head on another base
  [[ -z $3 || ${3#* } == "$2" ]] ||
    die 2 "#${3%% *} already has $1 on ${3#* }, not on $2: a hand-chained PR. Close it, or retarget it to $2, then run this again"
}

ensure_pr() { # head base body-file -> "<number> new|reused"; reuses an open PR on the same base
  local head=$1 base=$2 f=$3 found l n args=()
  found=$(open_pr_for "$head")
  if [[ -n $found ]]; then
    refuse_other_base "$head" "$base" "$found"
    echo "${found%% *} reused"
    return
  fi
  for l in ${labels[@]+"${labels[@]}"}; do args+=(--label "$l"); done # open-pr.sh adds them as it opens the PR
  # its own line, so a failure stops here
  n=$("$OPEN_PR" ${open_pr_flags[@]+"${open_pr_flags[@]}"} --base "$base" ${args[@]+"${args[@]}"} "$head" "$f")
  echo "$n new"
}

add_labels() { # pr : on a PR this run reused
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

# Rebase each part onto the new head below, then push them with a lease each: linear, since GitHub's
# "Rebase stack" stops on a merge commit that replays empty after a squash (#315). <onto>/<upstream>
# move the bottom part too (refresh). A conflict restores every branch and pushes nothing.
held_once() { # branch : its reflog holds origin's head, so this clone wrote that head itself
  local log
  log=$'\n'$(git reflog --format=%H "refs/heads/$1")$'\n'
  [[ $log == *$'\n'"$(git rev-parse "refs/remotes/origin/$1")"$'\n'* ]]
}

restack() { # stack-base onto upstream branch...
  local base=$1 onto=$2 upstream=$3 here start b i wt below_new below_old
  shift 3
  local heads=("$@")
  declare -A was_local was_remote
  git diff --quiet && git diff --cached --quiet ||
    die 2 "uncommitted changes here: commit them first, since restacking checks branches out"
  here=$(git rev-parse --show-toplevel)
  start=$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)
  for b in "${heads[@]}"; do
    [[ $b != "$base" && $b != main ]] || die 2 "a part's head is $b: stack.sh never force-pushes main or the stack's base"
    wt=$(checked_out_in "$b")
    [[ -z $wt || $wt == "$here" ]] || die 2 "$b is checked out in $wt: run this there"
    git rev-parse -q --verify "refs/heads/$b" >/dev/null || git branch -q --no-track "$b" "origin/$b"
    # GitHub's head must be in the local branch, or once have been its head (the lane rewrote it):
    # a merge commit or a dropped commit on GitHub is never pushed over.
    git merge-base --is-ancestor "origin/$b" "$b" || held_once "$b" ||
      die 2 "$b lacks commits that GitHub's $b has: rebase or fast-forward your $b onto origin/$b first"
    was_local[$b]=$(git rev-parse "refs/heads/$b") was_remote[$b]=$(git rev-parse "refs/remotes/origin/$b")
  done
  for i in "${!heads[@]}"; do
    b=${heads[i]}
    if ((i == 0)); then
      [[ -n $onto ]] || continue
      below_new=$onto below_old=$upstream
    else
      below_new=$(git rev-parse "refs/heads/${heads[i - 1]}") below_old=${was_remote[${heads[i - 1]}]}
    fi
    if git merge-base --is-ancestor "$below_new" "$b"; then
      # On top already. A merge commit in its range (the old merge-upward update) would stop
      # GitHub's restack, so rebuild the part as one commit with the same tree.
      [[ -n $(git rev-list --merges -n1 "$below_new..$b") ]] || continue
      local first
      first=$(git rev-list --reverse --no-merges "$below_new..$b" | head -n1)
      # Message: the first commit's subject and body, the other commits' subjects, its trailers last.
      local msg trailers
      msg=$(git log -1 --format=%B "$first")
      trailers=$(git log -1 --format='%(trailers:only,unfold)' "$first")
      [[ -z $trailers ]] || msg=$(head -n "-$(wc -l <<<"$trailers")" <<<"$msg")
      git update-ref "refs/heads/$b" "$(git commit-tree "$b^{tree}" -p "$below_new" -F <(
        printf '%s\n' "$msg"
        git log --reverse --no-merges --format='- %s' "$first..$b" | sed '1s/^/\nAlso in this part:\n/'
        [[ -z $trailers ]] || printf '\n%s\n' "$trailers"
      ))"
      echo "rebuilt $b as one commit"
      continue
    fi
    git merge-base --is-ancestor "$below_old" "$b" || below_old=$(git merge-base "$below_new" "$b")
    if ! git rebase -q --onto "$below_new" "$below_old" "$b" >/dev/null 2>&1; then
      git rebase --abort 2>/dev/null || true
      for b in "${heads[@]}"; do git update-ref "refs/heads/$b" "${was_local[$b]}"; done
      git switch -q "$start" 2>/dev/null || git switch -q --detach "$start"
      die 2 "rebasing ${heads[i]} onto ${heads[i - 1]:-the base} conflicts: rebase it by hand, then run this again (nothing pushed)"
    fi
    echo "rebased $b"
  done
  git switch -q "$start" 2>/dev/null || git switch -q --detach "$start"
  local leases=() refs=()
  for b in "${heads[@]}"; do
    [[ $(git rev-parse "refs/heads/$b") == "${was_remote[$b]}" ]] && continue
    leases+=("--force-with-lease=refs/heads/$b:${was_remote[$b]}") refs+=("$b")
  done
  ((${#refs[@]})) || { echo "nothing to push: the stack is up to date"; return 0; }
  git push -q --atomic "${leases[@]}" origin "${refs[@]}" || {
    git switch -q --detach HEAD
    for b in "${heads[@]}"; do git update-ref "refs/heads/$b" "${was_local[$b]}"; done
    git switch -q "$start" 2>/dev/null || git switch -q --detach "$start"
    die 1 "push refused (a lease or a rule): every branch is back where it was; fetch and run this again"
  }
}

# --- commands -----------------------------------------------------------------------------------
cmd_open() {
  local base=main
  while (($#)); do
    case $1 in
      --base) (($# >= 2)) || die 2 "--base needs a branch"; base=$2; shift 2 ;;
      --label) (($# >= 2)) || die 2 "--label needs a name"; labels+=("$2"); shift 2 ;;
      --as-admin) open_pr_flags=(--as-admin); shift ;;
      *) break ;;
    esac
  done
  parse_parts "$@"
  ((${#branches[@]} >= 2)) || die 2 "a stack needs at least 2 parts; one part is a plain PR"
  git fetch -q origin "+refs/heads/$base:refs/remotes/origin/$base" 2>/dev/null ||
    die 2 "no branch $base on origin"
  check_chain "origin/$base" "${branches[@]}"

  # Every refusal comes first: a hand-chained PR, or a PR in a stack these parts don't make up.
  local i bases=("$base" "${branches[@]}") found pr st s="" in_stack=0 whole=1 nums=()
  for i in "${!branches[@]}"; do
    found=$(open_pr_for "${branches[i]}")
    refuse_other_base "${branches[i]}" "${bases[i]}" "$found"
    st=""
    if [[ -n $found ]]; then pr=${found%% *}; st=$(stack_of "$pr"); fi
    [[ -n $st ]] && in_stack=1
    if ((i == 0)); then s=$st; elif [[ $st != "$s" ]]; then whole=0; fi
  done
  [[ -n $s ]] || whole=0
  ((whole || !in_stack)) || die 2 "a part's PR is already in a stack: add a part with 'scripts/stack.sh add', or unlink it in the UI"

  git push -q origin "${branches[@]}"
  local got
  for i in "${!branches[@]}"; do
    got=$(ensure_pr "${branches[i]}" "${bases[i]}" "${bodies[i]}")
    nums+=("${got%% *}")
    [[ $got == *reused ]] && add_labels "${nums[i]}"
  done
  ((whole)) || link_stack "${nums[@]}"
  cmd_status "${nums[0]}"
}

# The open-pr run links each part into the stack of the part below with the App's token. What it
# left out (/stacks refused the token, the part below was a reused PR, or --as-admin opened it with
# no run) is linked here.
link_stack() { # pr... in order
  local s n i fields=()
  s=$(stack_of "$1")
  if [[ -z $s ]]; then
    for n in "$@"; do fields+=(-F "pull_requests[]=$n"); done
    s=$(gh api -X POST "$P/stacks" "${fields[@]}" --jq .number) ||
      die 1 "PRs $(printf '#%s ' "$@")are open but not stacked; run the same command again"
    echo "stack: linked $(printf '#%s ' "$@")as stack #$s with your token: the open-pr run didn't (or --as-admin opened it)" >&2
    return
  fi
  for ((i = 2; i <= $#; i++)); do
    n=${!i}
    [[ $(stack_of "$n") == "$s" ]] && continue
    gh api -X POST "$P/stacks/$s/add" -F "pull_requests[]=$n" --jq .number >/dev/null ||
      die 1 "#$n is open but not in stack #$s; run the same command again"
    echo "stack: linked #$n into stack #$s with your token: the open-pr run didn't (or --as-admin opened it)" >&2
  done
}

cmd_add() {
  (($# >= 1)) || die 2 "add needs a PR number"
  local pr=$1
  shift
  while (($#)); do
    case $1 in
      --label) (($# >= 2)) || die 2 "--label needs a name"; labels+=("$2"); shift 2 ;;
      --as-admin) open_pr_flags=(--as-admin); shift ;;
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
  git merge-base --is-ancestor "origin/$top" "${branches[0]}" ||
    die 2 "${branches[0]} is not built on $top: rebuild it on top of $top"
  check_chain "origin/$top" "${branches[0]}"
  refuse_other_base "${branches[0]}" "$top" "$(open_pr_for "${branches[0]}")"
  git push -q origin "${branches[0]}"
  local n got
  got=$(ensure_pr "${branches[0]}" "$top" "${bodies[0]}")
  n=${got%% *}
  [[ $got == *reused ]] && add_labels "$n"
  if [[ $(stack_of "$n") != "$s" ]]; then
    gh api -X POST "$P/stacks/$s/add" -F "pull_requests[]=$n" --jq .number >/dev/null ||
      die 1 "#$n is open on $top but not in stack #$s; run the same command again"
    echo "stack: linked #$n into stack #$s with your token: the open-pr run didn't (or --as-admin opened it)" >&2
  fi
  cmd_status "$n"
}

open_heads() { # stack -> the open parts' head refs, bottom first
  local num state head sha merged
  while read -r num state head sha merged; do
    [[ $state == open ]] && echo "$head"
  done < <(stack_parts "$1")
}

cmd_update() {
  (($# == 1)) || die 2 "update needs a PR number"
  local s base heads=()
  s=$(require_stack "$1")
  base=$(gh api "$P/stacks/$s" --jq .base.ref)
  mapfile -t heads < <(open_heads "$s")
  ((${#heads[@]})) || die 2 "stack #$s has no open part"
  fetch "${heads[@]}"
  restack "$base" "" "" "${heads[@]}" # not in a condition, so errexit holds inside it
  cmd_status "$1"
}

cmd_refresh() {
  (($# == 1)) || die 2 "refresh needs a PR number"
  local s base num state head sha merged heads=() upstream=""
  s=$(require_stack "$1")
  base=$(gh api "$P/stacks/$s" --jq .base.ref)
  while read -r num state head sha merged; do
    if [[ $state == open ]]; then
      heads+=("$head")
    else
      echo "#$num $([[ $merged == yes ]] && echo merged || echo closed)"
      ((${#heads[@]})) || upstream=$sha # the last part below the open ones
    fi
  done < <(stack_parts "$s")
  ((${#heads[@]})) || { echo "stack #$s has no open part"; return; }
  git fetch -q origin "+refs/heads/$base:refs/remotes/origin/$base"
  fetch "${heads[@]}"
  # A merged part below: GitHub retargets the lowest open part to the base but leaves it on the
  # merged part's commits, which a squash already holds, so it moves onto the base.
  if [[ -n $upstream ]] && git cat-file -e "$upstream^{commit}" 2>/dev/null; then
    restack "$base" "origin/$base" "$upstream" "${heads[@]}"
  else
    [[ -z $upstream ]] || echo "stack: the merged part's head ${upstream:0:7} isn't in this clone, so the lowest open part stays where it is; rebase it onto origin/$base by hand" >&2
    restack "$base" "" "" "${heads[@]}"
  fi
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
    # One run per check name: two events on one push can leave a cancelled twin beside the real
    # run, so a cancelled run counts only when no other run of that name exists.
    checks=$(gh api "$P/commits/$sha/check-runs?per_page=100" --jq '
      [.check_runs | group_by(.name)[] | sort_by(.id) | (map(select(.conclusion != "cancelled")) | last) // last] as $r
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

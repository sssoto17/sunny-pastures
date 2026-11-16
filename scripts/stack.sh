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

  open [--base <branch>] <branch>=<body-file>...
      Push the parts, open each PR on the part below (part 1 on --base, default main), and link
      them as one native stack. Each part must be built on the one below and add commits of its
      own. A body file's first line is the PR title; the rest is the body. Run it again after a
      failure: it reuses the PRs and the stack it finds.
Run from the repo, in the worktree that holds the parts.
Exit codes: 0 done; 1 a git or gh command failed; 2 refused, nothing pushed or created.
EOF
}

die() { # code message
  printf 'stack: %s\n' "$2" >&2
  exit "$1"
}

# --- parts --------------------------------------------------------------------------------------
branches=() bodies=()
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

stack_of() { # pr -> its stack's number, or nothing
  gh api "$P/pulls/$1" --jq '.stack.number // empty' || die 1 "can't read PR #$1"
}

stack_parts() { # stack -> lines "<number> <state> <head ref> <head sha> <merged yes|no>", in order
  gh api "$P/stacks/$1" --jq '.pull_requests[] | "\(.number) \(.state) \(.head.ref) \(.head.sha) \(if .merged_at then "yes" else "no" end)"'
}

# --- commands -----------------------------------------------------------------------------------
cmd_open() {
  local base=main
  while (($#)); do
    case $1 in
      --base) base=$2; shift 2 ;;
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
  echo "stack #$s on $base"
  stack_parts "$s" | awk '{ printf "  #%s %s\n", $1, $3 }'
}

case ${1:-} in
  -h | --help) usage; exit 0 ;;
  open) cmd=$1; shift; "cmd_$cmd" "$@" ;;
  "") usage; exit 2 ;;
  *) usage; die 2 "unknown command: $1" ;;
esac

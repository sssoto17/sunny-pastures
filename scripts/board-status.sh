#!/usr/bin/env bash
# The board workflow's two halves (#417; docs/agents/issue-tracker.md, "Status rules"): `decide`
# reads GitHub with a read-only token and says which issue moves where; `move` makes one such move
# through scripts/issue-fields.sh's guarded form (--from), which holds the field logic. The
# workflow (.github/workflows/board.yml) runs them in separate jobs, so the job that holds the
# Project token never reads anything a PR wrote. GitHub's built-in Project workflows do Done.
#
#   kind    Status       only from              when
#   start   In progress  Ready                  a branch <N>-<slug> appears, or a PR that closes #N
#                                               is open with its checks still running
#   back    In progress  Ready, In review       that PR is a draft, its checks went red, or it
#                                               closed unmerged
#   review  In review    Ready, In progress     that PR is ready (not a draft) and its checks are
#                                               green, `guard / code-owned` apart (admin, 21 Nov)
#
# Never Ready, never out of Backlog, never Mode: issue-fields.sh refuses each, and an issue that
# isn't on the Project is left alone. Only the PR GitHub records as closing #N moves #N (its
# closingIssuesReferences), so the `Part of #N` parts of a split don't.
# It prints numbers, kinds and fixed text only, never a name or text a PR or a check chose, so
# nothing it logs can run as a workflow command.
# Tests: scripts/board-status.test.sh. Needs bash 4.4+, jq and an authenticated gh.
set -euo pipefail
shopt -s inherit_errexit

REPO=sssoto17/sunny-pastures
R=repos/$REPO
here="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: scripts/board-status.sh decide pr <number>
       scripts/board-status.sh decide commit <sha>
       scripts/board-status.sh decide branch <name>
       scripts/board-status.sh move <issue>:<kind>

decide  reads GitHub (read-only) and prints one line, `moves=` then the moves, each
        <issue>:<kind> and space-separated, or nothing after `=` when nothing moves.
        pr      a PR: the open issues it closes, by its state, draft flag and checks
        commit  every open PR whose head is this commit (a finished workflow run's head)
        branch  a new branch: <N>-<slug>, optionally after one `<prefix>/` and `issue-`
move    one move: scripts/issue-fields.sh <issue> --status <Status> --from <list>
        start  -> In progress from Ready
        back   -> In progress from Ready, In review
        review -> In review from Ready, In progress

Checks are green when every check run on the head (the latest of each name) passed, skipped or
was neutral and every commit status passed, leaving out `guard / code-owned` (red until the
admin approves a code-owned head) and this workflow's own `board / ...` jobs. Any failure,
time-out or start-up failure is red; anything still running, cancelled or stale, or no check at
all, is pending.

Exit codes: 0 done (nothing to move is done too), 1 a gh call or a move failed, 2 bad arguments.
EOF
}

die() { # code message
  printf 'board-status: %s\n' "$2" >&2
  exit "$1"
}

say() { printf 'board-status: %s\n' "$*" >&2; }

valid_number() { [[ $1 =~ ^[1-9][0-9]{0,6}$ ]]; }

# --- decide -------------------------------------------------------------------------------------

# The open issues of this repo that GitHub will close when the PR merges. GraphQL with the job's
# read-only token: REST has no closing references. GitHub records them only while the base is the
# default branch, so a stack's closing part counts once it sits on main (CONSTRAINTS.md, "Split
# size").
CLOSING_QUERY='query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner,
  name: $name) { pullRequest(number: $pr) { closingIssuesReferences(first: 25) { nodes { number
  state repository { nameWithOwner } } } } } }'
closing() { # pr -> issue numbers, one a line
  gh api graphql -f query="$CLOSING_QUERY" -F owner="${REPO%/*}" -F name="${REPO#*/}" -F pr="$1" \
    --jq ".data.repository.pullRequest.closingIssuesReferences.nodes[]
      | select(.state == \"OPEN\" and .repository.nameWithOwner == \"$REPO\") | .number"
}

# green, red or pending for a head commit (see usage).
checks() { # sha
  local runs statuses
  runs=$(gh api --paginate "$R/commits/$1/check-runs?per_page=100" \
    --jq '.check_runs[] | [.id, .status, (.conclusion // "-"), .name] | @tsv') ||
    die 1 "could not read the check runs of $1"
  statuses=$(gh api "$R/commits/$1/status" --jq '.statuses[] | [.state, .context] | @tsv') ||
    die 1 "could not read the commit statuses of $1"
  {
    # The latest run of each name: a re-run or a newer event's run replaces the older one.
    awk -F'\t' 'NF >= 4 && $4 != "guard / code-owned" && $4 !~ /^board \// {
        if (!($4 in id) || $1 + 0 > id[$4] + 0) { id[$4] = $1; st[$4] = $2; co[$4] = $3 }
      }
      END { for (n in id) print (st[n] == "completed" ? co[n] : "running") }' <<<"$runs"
    awk -F'\t' 'NF >= 2 { print "status-" $1 }' <<<"$statuses"
  } | awk '
    /^(success|neutral|skipped|status-success)$/ { green++; next }
    /^(failure|timed_out|action_required|startup_failure|status-failure|status-error)$/ { red++; next }
    { pending++ }
    END { print (red ? "red" : (pending || !green) ? "pending" : "green") }'
}

decide_pr() { # pr -> moves on stdout, one a line
  local pr=$1 row state draft merged sha kind verdict issues
  row=$(gh api "$R/pulls/$pr" --jq '[.state, .draft, .merged, .head.sha] | @tsv') ||
    die 1 "could not read PR #$pr"
  IFS=$'\t' read -r state draft merged sha <<<"$row"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die 1 "unexpected answer from GitHub for PR #$pr"
  if [[ $merged == true ]]; then
    say "PR #$pr merged: Done is the Project's built-in workflow"
    return 0
  fi
  issues=$(closing "$pr") || die 1 "could not read the issues PR #$pr closes"
  if [[ -z $issues ]]; then
    say "PR #$pr closes no open issue of $REPO: nothing moves"
    return 0
  fi
  if [[ $state != open ]]; then
    kind=back verdict="closed unmerged"
  elif [[ $draft == true ]]; then
    kind=back verdict="a draft"
  else
    verdict=$(checks "$sha")
    case $verdict in
      green) kind=review ;;
      red) kind=back ;;
      *) kind=start ;;
    esac
    verdict="open, checks $verdict"
  fi
  local n
  while read -r n; do
    valid_number "$n" || die 1 "unexpected issue number from GitHub for PR #$pr"
    say "PR #$pr $verdict: #$n $kind"
    printf '%s:%s\n' "$n" "$kind"
  done <<<"$issues"
}

decide_commit() { # sha
  local prs pr
  # The SHA is checked to be 40 hex digits before it goes into the filter.
  prs=$(gh api "$R/commits/$1/pulls" --jq ".[] | select(.state == \"open\" and .head.sha == \"$1\") | .number") ||
    die 1 "could not read the PRs of $1"
  [[ -n $prs ]] || { say "no open PR has $1 as its head: nothing moves"; return 0; }
  while read -r pr; do
    valid_number "$pr" || die 1 "unexpected PR number from GitHub for $1"
    decide_pr "$pr"
  done <<<"$prs"
}

decide_branch() { # name
  local n row
  if [[ $1 =~ ^([A-Za-z0-9._-]+/)?(issue-)?([1-9][0-9]{0,6})-[A-Za-z0-9._-]+$ ]]; then
    n=${BASH_REMATCH[3]}
  else
    say "the new branch names no issue (<N>-<slug>): nothing moves"
    return 0
  fi
  row=$(gh api "$R/issues/$n" --jq '[.state, has("pull_request")] | @tsv' 2>/dev/null) || {
    say "the new branch names #$n, which can't be read as an issue: nothing moves"
    return 0
  }
  if [[ $row != $'open\tfalse' ]]; then
    say "the new branch names #$n, which isn't an open issue: nothing moves"
    return 0
  fi
  say "a branch for #$n: #$n start"
  printf '%s:start\n' "$n"
}

# --- move ---------------------------------------------------------------------------------------

move() { # issue:kind
  [[ $1 =~ ^([1-9][0-9]{0,6}):(start|back|review)$ ]] || die 2 "not a move: \"$1\" (<issue>:start|back|review)"
  local n=${BASH_REMATCH[1]} kind=${BASH_REMATCH[2]} status from
  case $kind in
    start) status="In progress" from="Ready" ;;
    back) status="In progress" from="Ready,In review" ;;
    review) status="In review" from="Ready,In progress" ;;
  esac
  "$here/issue-fields.sh" "$n" --status "$status" --from "$from"
}

# --- arguments ----------------------------------------------------------------------------------
case ${1-} in
  -h | --help) usage; exit 0 ;;
  decide)
    (($# == 3)) || { usage; exit 2; }
    case $2 in
      pr) valid_number "$3" || die 2 "not a PR number: \"$3\""; out=$(decide_pr "$3") ;;
      commit) [[ $3 =~ ^[0-9a-f]{40}$ ]] || die 2 "not a commit SHA: \"$3\""; out=$(decide_commit "$3") ;;
      branch) out=$(decide_branch "$3") ;;
      *) usage; exit 2 ;;
    esac
    printf 'moves=%s\n' "$(sort -u <<<"$out" | paste -sd' ' - | sed 's/^ *//')"
    ;;
  move)
    (($# == 2)) || { usage; exit 2; }
    move "$2"
    ;;
  *) usage; exit 2 ;;
esac

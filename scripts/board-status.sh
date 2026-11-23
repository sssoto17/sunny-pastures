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
#   factory-progress  In progress  Ready, In review, Backlog   the issue carries factory:working
#                                                              or factory:failed (#620)
#   factory-review    In review    Ready, In progress, Backlog  the issue carries factory:review
#
# A factory issue's Status mirrors its label and never gates the factory (admin, 23 Nov):
# factory:ready moves nothing, and an issue with two of those labels at once (one being swapped)
# waits for the next label event. The labels are read when the job runs, not taken from the event,
# so two quick label events that finish out of order still end on the current label.
# Never Ready, never another field: issue-fields.sh refuses Ready, and every move here sets Status
# alone. Never out of Backlog, but for a factory issue: issue-fields.sh's guard refuses Backlog,
# so a factory move that its guard reports in Backlog takes the plain form (move_factory). An
# issue that isn't on the Project is left alone. Only the PR that closes #N moves #N: on main, the issues
# GitHub records (closingIssuesReferences); on another base (a stack's closing part, for which
# GitHub records none), the body's closing keyword, which `guard / pr-body` allows only on the
# closing part. So the `Part of #N` parts of a split don't move it.
# A finished check run (`decide commit`) only says whether checks turned green or red: the PR's own
# events already moved it to In progress, so a pending, draft or closed PR there moves nothing, and
# the token's job doesn't start for it. Whether the issue is already where a move would put it
# can't be read here: the Project needs the token.
# It prints numbers, kinds and fixed text only, never a name or text a PR or a check chose, so
# nothing it logs can run as a workflow command.
# Tests: scripts/board-status.test.sh. Needs bash 4.4+, jq and an authenticated gh.
set -euo pipefail
shopt -s inherit_errexit

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "board-status: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

REPO=sssoto17/sunny-pastures
R=repos/$REPO
here="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: scripts/board-status.sh decide pr <number> [<action>]
       scripts/board-status.sh decide commit <sha> [<pr>...]
       scripts/board-status.sh decide branch <name>
       scripts/board-status.sh decide issue <number>
       scripts/board-status.sh move <issue>:<kind>

decide  reads GitHub (read-only) and prints one line, `moves=` then the moves, each
        <issue>:<kind> and space-separated, or nothing after `=` when nothing moves.
        pr      a PR: the open issues it closes, by its state, draft flag and checks; a
                fork's PR moves nothing. On a base other than main, the issues come from the
                body's closing keywords (#N or sssoto17/sunny-pastures#N), open issues only.
                <action> is the PR event's: on ready_for_review it never gives review
        commit  every open PR whose head is this commit, and each <pr> given (a finished
                workflow run's head and its pull_requests: a pull_request_target run's head
                may be main's commit, so its PRs come from the event). Checks only: review
                when a ready PR is green, back when it's red, nothing otherwise
        branch  a new branch: <N>-<slug>, optionally after one `<prefix>/` and `issue-`
        issue   an issue whose factory:* label changed: an open issue with one of
                factory:working or factory:failed (factory-progress) or factory:review
                (factory-review); factory:ready, none or two of them move nothing
move    one move: scripts/issue-fields.sh <issue> --status <Status> --from <list>
        start            -> In progress from Ready
        back             -> In progress from Ready, In review
        review           -> In review from Ready, In progress
        factory-progress -> In progress from Ready, In review, and Backlog
        factory-review   -> In review from Ready, In progress, and Backlog
        A factory move reads the issue's labels again and moves nothing if they no longer
        give it. Out of Backlog only when the guarded form reports Backlog, and then with
        `scripts/issue-fields.sh <issue> --status <Status>`; never for an issue carrying
        `triage`, one off the Project, or one in Done.

Checks are green when every check run on the head (the latest of each name) passed, skipped or
was neutral and every commit status passed, leaving out `guard / code-owned` (red until the
admin approves a code-owned head, or reviews it on a PR the admin opened) and this workflow's
own `board / ...` jobs. Any failure, time-out or start-up failure is red; anything still
running, cancelled or stale, or no check at all, is pending.

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
# default branch (CONSTRAINTS.md, "Split size"), so a PR on another base, a stack's closing part,
# is read from its body instead (body_closing).
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
  statuses=$(gh api --paginate "$R/commits/$1/status?per_page=100" --jq '.statuses[] | [.state, .context] | @tsv') ||
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

# A stack's closing part, before it sits on main: the issues its body closes, digits only. The
# keywords are GitHub's nine, any case, an optional colon, then #N or this repo's owner/name#N;
# another repo's reference doesn't match. Each must be an open issue of this repo, not a PR.
BODY_FILTER='(.body // "") | ascii_downcase
  | [scan("\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \\t]+(?:sssoto17/sunny-pastures)?#([0-9]{1,7})\\b")]
  | .[][0]'
# A failed read returns 1, so the caller stops instead of reading "closes nothing"; an issue that
# doesn't exist (404) or was deleted (410) is only left out. Explicit returns: errexit is off in a `|| die` caller.
body_closing() { # pr -> issue numbers, one a line
  local nums n row err
  nums=$(gh api "$R/pulls/$1" --jq "$BODY_FILTER") || return 1
  nums=$(sort -un <<<"$nums" | sed '/^$/d') || return 1
  [[ -n $nums ]] || return 0
  err=$(mktemp "${TMPDIR:-/tmp}/board-status.XXXXXX") || return 1
  while read -r n; do
    valid_number "$n" || continue
    if ! row=$(gh api "$R/issues/$n" --jq '[.state, has("pull_request")] | @tsv' 2>"$err"); then
      if grep -qE 'HTTP (404|410)' "$err"; then continue; fi
      cat "$err" >&2
      rm -f "$err"
      return 1
    fi
    if [[ $row == $'open\tfalse' ]]; then printf '%s\n' "$n"; fi
  done <<<"$nums"
  rm -f "$err"
  return 0
}

# mode: `checks` for a finished check run, or the PR event's action. A ready_for_review never gives
# `review`: on a draft the CI jobs were skipped, and until the new run's checks exist the skipped
# ones read as green, so the CI run's own completion decides In review.
decide_pr() { # pr [checks|<action>] -> moves on stdout, one a line
  local pr=$1 mode=${2-event} row state draft merged sha head_repo base kind verdict issues
  row=$(gh api "$R/pulls/$pr" --jq '[.state, .draft, .merged, .head.sha, (.head.repo.full_name // "-"), .base.ref] | @tsv') ||
    die 1 "could not read PR #$pr"
  IFS=$'\t' read -r state draft merged sha head_repo base <<<"$row"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die 1 "unexpected answer from GitHub for PR #$pr"
  if [[ $head_repo != "$REPO" ]]; then
    say "PR #$pr comes from another repository: nothing moves"
    return 0
  fi
  if [[ $merged == true ]]; then
    say "PR #$pr merged: Done is the Project's built-in workflow"
    return 0
  fi
  if [[ $mode == checks && ($state != open || $draft == true) ]]; then
    say "PR #$pr isn't open and ready: its own events moved it, a check run moves nothing"
    return 0
  fi
  if [[ $base == main ]]; then
    issues=$(closing "$pr") || die 1 "could not read the issues PR #$pr closes"
  else
    issues=$(body_closing "$pr") || die 1 "could not read the issues PR #$pr closes"
  fi
  if [[ -z $issues ]]; then
    say "PR #$pr closes no open issue of $REPO: nothing moves"
    return 0
  fi
  if [[ $state != open ]]; then
    kind=back verdict="closed unmerged"
  elif [[ $draft == true ]]; then
    kind=back verdict="a draft"
  else
    local checked
    checked=$(checks "$sha")
    verdict="open, checks $checked"
    case $checked in
      green)
        if [[ $mode == ready_for_review ]]; then
          kind=start verdict="just marked ready, checks not run yet"
        else
          kind=review
        fi
        ;;
      red) kind=back ;;
      *)
        if [[ $mode == checks ]]; then
          say "PR #$pr checks still pending: nothing moves until they're green or red"
          return 0
        fi
        kind=start
        ;;
    esac
  fi
  local n
  while read -r n; do
    valid_number "$n" || die 1 "unexpected issue number from GitHub for PR #$pr"
    say "PR #$pr $verdict: #$n $kind"
    printf '%s:%s\n' "$n" "$kind"
  done <<<"$issues"
}

decide_commit() { # sha [pr...]
  local sha=$1 prs pr
  shift
  # The SHA is checked to be 40 hex digits before it goes into the filter.
  prs=$(gh api "$R/commits/$sha/pulls" --jq ".[] | select(.state == \"open\" and .head.sha == \"$sha\") | .number") ||
    die 1 "could not read the PRs of $sha"
  (($#)) && prs+=$'\n'$(printf '%s\n' "$@")
  prs=$(sort -un <<<"$prs" | sed '/^$/d')
  [[ -n $prs ]] || { say "no open PR has $sha as its head: nothing moves"; return 0; }
  while read -r pr; do
    valid_number "$pr" || die 1 "unexpected PR number from GitHub for $sha"
    decide_pr "$pr" checks
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

# The factory's labels (#620): Status mirrors the one a factory issue carries, never gates it.
# working and failed are In progress, review In review; factory:ready moves nothing.
factory_kind() { # label -> its move kind, or nothing
  case $1 in
    factory:working | factory:failed) printf 'factory-progress' ;;
    factory:review) printf 'factory-review' ;;
  esac
  return 0
}

# The kind an issue's labels give: an open issue (not a PR) with exactly one of the factory's
# labels that move it. Prints the kind, then " triage" when it carries `triage`, or says why
# nothing moves; never prints a label's name.
issue_kind() { # issue -> "<kind>[ triage]" on stdout, or nothing; exit 1 on a failed read
  local n=$1 row state is_pr label kind kinds=() labels triage=""
  row=$(gh api "$R/issues/$n" --jq '[.state, has("pull_request")] + [.labels[]?.name] | @tsv') || return 1
  IFS=$'\t' read -r state is_pr _ <<<"$row"
  if [[ $state != open || $is_pr != false ]]; then
    say "#$n isn't an open issue: nothing moves (Done is the Project's built-in workflow)"
    return 0
  fi
  IFS=$'\t' read -ra labels <<<"$row"
  for label in "${labels[@]:2}"; do
    [[ $label == triage ]] && triage=" triage"
    kind=$(factory_kind "$label")
    [[ -n $kind ]] && kinds+=("$kind")
  done
  case ${#kinds[@]} in
    0) say "#$n carries no factory:working, factory:review or factory:failed: nothing moves" ;;
    1) printf '%s%s' "${kinds[0]}" "$triage" ;;
    *) say "#$n carries more than one of factory:working, factory:review and factory:failed: nothing moves until one is left" ;;
  esac
}

decide_issue() { # issue
  local kind
  kind=$(issue_kind "$1") || die 1 "could not read issue #$1"
  kind=${kind%% *}
  [[ -n $kind ]] || return 0
  say "a factory label: #$1 $kind"
  printf '%s:%s\n' "$1" "$kind"
}

# --- move ---------------------------------------------------------------------------------------

move() { # issue:kind
  [[ $1 =~ ^([1-9][0-9]{0,6}):(start|back|review|factory-progress|factory-review)$ ]] ||
    die 2 "not a move: \"$1\" (<issue>:start|back|review|factory-progress|factory-review)"
  local n=${BASH_REMATCH[1]} kind=${BASH_REMATCH[2]} status from
  case $kind in
    start) status="In progress" from="Ready" ;;
    back) status="In progress" from="Ready,In review" ;;
    review) status="In review" from="Ready,In progress" ;;
    factory-progress) status="In progress" from="Ready,In review" ;;
    factory-review) status="In review" from="Ready,In progress" ;;
  esac
  if [[ $kind != factory-* ]]; then
    "$here/issue-fields.sh" "$n" --status "$status" --from "$from"
    return
  fi
  move_factory "$n" "$kind" "$status" "$from"
}

# A factory label's move (#620). The labels are read again, so one changed since `decide` moves
# nothing. Then the guarded form, from every open Status but Backlog (issue-fields.sh refuses
# Backlog in --from). Only when that guard reports the issue in Backlog does the plain form move
# it out: the one exception to "never out of Backlog" (admin, 23 Nov). Never for an issue that
# isn't on the Project or is Done (the guard's answer stands), nor for one still carrying `triage`
# (the plain form would try to remove it, with the job's read-only token).
move_factory() { # issue kind status from
  local n=$1 kind=$2 status=$3 from=$4 now triage out rc
  now=$(issue_kind "$n") || die 1 "could not read issue #$n"
  read -r now triage <<<"$now"
  if [[ $now != "$kind" ]]; then
    say "#$n no longer gives $kind: nothing moves"
    return 0
  fi
  out=$("$here/issue-fields.sh" "$n" --status "$status" --from "$from") || {
    rc=$?
    [[ -z $out ]] || printf '%s\n' "$out"
    return "$rc"
  }
  printf '%s\n' "$out"
  # issue-fields.sh's answer when its guard leaves an issue alone: "Status:   <now> (left alone:
  # <why>)". Its tests pin that line; this reads only <now>.
  grep -qE '^Status:[[:space:]]+Backlog \(left alone: ' <<<"$out" || return 0
  if [[ -n $triage ]]; then
    say "#$n is a factory issue in Backlog but still carries triage: it stays in Backlog"
    return 0
  fi
  say "#$n is a factory issue in Backlog: $kind moves it out of Backlog"
  "$here/issue-fields.sh" "$n" --status "$status"
}

# --- arguments ----------------------------------------------------------------------------------
case ${1-} in
  -h | --help) usage; exit 0 ;;
  decide)
    (($# >= 3)) || { usage; exit 2; }
    [[ $2 == commit ]] || (($# == 3)) || [[ $2 == pr && $# == 4 ]] || { usage; exit 2; }
    case $2 in
      pr)
        valid_number "$3" || die 2 "not a PR number: \"$3\""
        action=${4-event}
        [[ $action =~ ^[a-z_]{1,40}$ && $action != checks ]] || die 2 "not an event action"
        out=$(decide_pr "$3" "$action")
        ;;
      commit)
        [[ $3 =~ ^[0-9a-f]{40}$ ]] || die 2 "not a commit SHA: \"$3\""
        for p in "${@:4}"; do valid_number "$p" || die 2 "not a PR number: \"$p\""; done
        out=$(decide_commit "${@:3}")
        ;;
      branch) out=$(decide_branch "$3") ;;
      issue)
        valid_number "$3" || die 2 "not an issue number: \"$3\""
        out=$(decide_issue "$3")
        ;;
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

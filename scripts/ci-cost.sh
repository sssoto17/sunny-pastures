#!/usr/bin/env bash
# Runner minutes per PR and per workflow, and the reviewer's Claude cost, over a date range
# (CONSTRAINTS.md, "Ratchets"; ADR-0002, "Caps"). Read-only: REST GETs through `gh api`, no
# writes. #98 recorded the first values with it. Tests: scripts/ci-cost.test.sh.
set -euo pipefail

OWNER=sssoto17
REPO=sunny-pastures
API=repos/$OWNER/$REPO
REVIEW_PATH=.github/workflows/review.yml
PER_PAGE=100
# The runs list answers at most 1,000 runs for a search by `created` (GitHub's REST docs, "List
# workflow runs for a repository"); past that it would drop runs without saying so.
MAX_RUNS=1000

# Any unexpected failure is exit 3, never 0 or 4, which mean "report printed".
trap 'exit 3' ERR

usage() {
  cat >&2 <<'EOF'
usage: scripts/ci-cost.sh --from YYYY-MM-DD --to YYYY-MM-DD [--pr N]...

Reports the GitHub Actions runner minutes of sssoto17/sunny-pastures for the workflow runs
created from --from to --to (UTC days, both included), and the reviewer's Claude cost. With
--pr, only the runs of those PRs count. Three tab-separated tables go to stdout:

  per PR        pr, runs, jobs, minutes, reviews, claude_usd
  per workflow  workflow, runs, jobs, minutes
  total         key, value: prs, runs, jobs, minutes, minutes_per_pr, reviews, claude_usd,
                claude_usd_per_reviewed_pr, unattributed_minutes, cancelled_reviews_without_log

Minutes: each job's run time from the jobs API (started_at to completed_at), rounded up to a
whole minute per job, as GitHub bills it; a job that never started counts 0. Re-run attempts
count too. The timing API's "billable" field is not used: it reads 0 for every run here (#98).

A run belongs to the PR in its pull_requests[] field. Most runs here have it empty (pull_request
and pull_request_target alike), so the run's head branch is matched to the PR with that head
branch opened most recently at or before the run. A run with no PR (a Dependabot update, say)
shows as PR "-" and counts only in "unattributed_minutes" and the per-workflow table.

Claude cost: the review job's log of each review.yml run, line "RESULT subtype=...
total_cost_usd=...". A log with no such line costs 0 (Claude never ran). A log that can't be
read shows the PR's cost as "?" and the command to read it goes to stderr, except for a
cancelled review job: GitHub keeps no log for one stopped in its first seconds, so it costs 0 and
counts in "cancelled_reviews_without_log". "reviews" counts the review jobs that ran; claude_usd_per_reviewed_pr divides by the PRs with at least one.

Exit codes: 0 report printed, 2 bad arguments (nothing read), 3 GitHub couldn't be read or
answered in an unexpected shape (nothing printed), 4 report printed but at least one review log
couldn't be read, so the Claude cost is incomplete.
EOF
}

die() { # code message
  printf 'ci-cost: %s\n' "$2" >&2
  exit "$1"
}
bad_args() { # message
  usage
  die 2 "$1"
}

from="" to=""
declare -A want_pr=()
while (($#)); do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --from | --to | --pr)
      (($# >= 2)) || bad_args "$1 needs a value"
      case $1 in
        --from) from=$2 ;;
        --to) to=$2 ;;
        --pr)
          [[ $2 =~ ^#?([0-9]+)$ ]] || bad_args "--pr takes a PR number, got \"$2\""
          want_pr[${BASH_REMATCH[1]}]=1
          ;;
      esac
      shift 2
      ;;
    *) bad_args "unexpected argument \"$1\"" ;;
  esac
done
[[ -n $from && -n $to ]] || bad_args "--from and --to are both required"
date_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
[[ $from =~ $date_re && $to =~ $date_re ]] || bad_args "dates are YYYY-MM-DD, got \"$from\" and \"$to\""
[[ ! $from > $to ]] || bad_args "--from $from is after --to $to"

# GET one page of an endpoint through a --jq filter. Pages are counted here, not with --paginate:
# gh follows the Link header, which names the repository by its numeric ID, and a cloud session's
# proxy refuses those paths (seen 16 Nov).
page_of() { # endpoint page filter [-f key=value]...
  local endpoint=$1 page=$2 filter=$3
  shift 3
  gh api -X GET "$endpoint" "$@" -f per_page=$PER_PAGE -f page="$page" --jq "$filter"
}

# --- the runs ---------------------------------------------------------------------------------
# A first line "total<TAB>N", then one row per run: id, workflow name, workflow path, event, head
# branch ("-" if none), the first linked PR ("-" if none), created_at.
RUNS='"total\t\(.total_count)", (.workflow_runs[] | [.id, .name, .path, .event,
  (.head_branch // "-" | if . == "" then "-" else . end),
  (.pull_requests[0].number // "-"), .created_at] | @tsv)'
runs="" total="" page=1 seen=0
while :; do
  chunk=$(page_of "$API/actions/runs" "$page" "$RUNS" -f created="$from..$to") ||
    die 3 "could not read the workflow runs of $OWNER/$REPO (see gh's error above)"
  head=${chunk%%$'\n'*}
  [[ $head =~ ^total$'\t'([0-9]+)$ ]] || die 3 "unexpected answer from the runs list, has the API changed?"
  total=${BASH_REMATCH[1]}
  ((total <= MAX_RUNS)) || die 3 "$total runs from $from to $to; the API answers at most $MAX_RUNS: use a shorter range"
  rows=""
  [[ $chunk == *$'\n'* ]] && rows=${chunk#*$'\n'}
  n=0
  [[ -n $rows ]] && n=$(grep -c '' <<<"$rows")
  runs+=$rows${rows:+$'\n'}
  seen=$((seen + n))
  ((n == PER_PAGE && seen < total)) || break
  page=$((page + 1))
done
((seen == total)) || die 3 "the runs list said $total runs but gave $seen"

# --- PRs by head branch, only when some run has no linked PR ----------------------------------
declare -A by_branch=() # branch → "created_at<TAB>number" lines
need_pulls=0
while IFS=$'\t' read -r id _ _ _ branch pr _; do
  [[ -z $id ]] && continue
  [[ $pr == - && $branch != - ]] && need_pulls=1
done <<<"$runs"
if ((need_pulls)); then
  PULLS='.[] | [.number, .head.ref, .created_at] | @tsv'
  page=1
  while :; do
    chunk=$(page_of "$API/pulls" "$page" "$PULLS" -f state=all) ||
      die 3 "could not read the pull requests of $OWNER/$REPO (see gh's error above)"
    n=0
    while IFS=$'\t' read -r number ref created; do
      [[ -z $number ]] && continue
      [[ $number =~ ^[0-9]+$ ]] || die 3 "unexpected row from the pulls list, has the API changed?"
      by_branch[$ref]+="$created"$'\t'"$number"$'\n'
      n=$((n + 1))
    done <<<"$chunk"
    ((n == PER_PAGE)) || break
    page=$((page + 1))
  done
fi
pr_by_branch() { # branch created_at → the PR number, or "-"
  local best="" line
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    [[ ${line%%$'\t'*} > $2 ]] && continue
    [[ -z $best || ${line%%$'\t'*} > ${best%%$'\t'*} ]] && best=$line
  done <<<"${by_branch[$1]-}"
  if [[ -n $best ]]; then printf '%s' "${best#*$'\t'}"; else printf -- '-'; fi
}

# --- jobs, minutes and the reviewer's cost ----------------------------------------------------
# A first line "total<TAB>N", then one row per job of every attempt: id, name, conclusion, seconds
# run (0 for a job that never started; never negative).
JOBS='"total\t\(.total_count)", (.jobs[] | [.id, .name, (.conclusion // .status),
  (if .started_at and .completed_at then
    [((.completed_at | fromdate) - (.started_at | fromdate)), 0] | max else 0 end)] | @tsv)'

declare -A pr_runs=() pr_jobs=() pr_min=() pr_reviews=() pr_usd=() pr_unread=()
declare -A wf_runs=() wf_jobs=() wf_min=()
unread_cmds=()
cancelled_nolog=0
errfile=$(mktemp)
trap 'rm -f "$errfile"' EXIT

usd_add() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.6f", a + b }'; }

while IFS=$'\t' read -r id name path event branch pr created; do
  [[ -z $id ]] && continue
  [[ $id =~ ^[0-9]+$ ]] || die 3 "unexpected row from the runs list, has the API changed?"
  if [[ $pr == - && $branch != - ]]; then pr=$(pr_by_branch "$branch" "$created"); fi
  if ((${#want_pr[@]})); then [[ $pr != - && -n ${want_pr[$pr]-} ]] || continue; fi

  jobs=$(page_of "$API/actions/runs/$id/jobs" 1 "$JOBS" -f filter=all) ||
    die 3 "could not read the jobs of run $id (see gh's error above)"
  [[ ${jobs%%$'\n'*} =~ ^total$'\t'([0-9]+)$ ]] || die 3 "unexpected answer from the jobs of run $id"
  ((BASH_REMATCH[1] <= PER_PAGE)) || die 3 "run $id has more than $PER_PAGE jobs, which this script doesn't page"
  njobs=0 minutes=0
  while IFS=$'\t' read -r job jname conclusion seconds; do
    [[ -z $job || $job == total ]] && continue
    [[ $job =~ ^[0-9]+$ && $seconds =~ ^[0-9]+$ ]] || die 3 "unexpected job row in run $id"
    njobs=$((njobs + 1))
    minutes=$((minutes + (seconds + 59) / 60))
    # The review job's log holds the reviewer's cost; a job that never started has no log.
    if [[ $path == "$REVIEW_PATH" && $jname == review ]] && ((seconds > 0)); then
      pr_reviews[$pr]=$((${pr_reviews[$pr]-0} + 1))
      # gh's error goes to a variable, never to the terminal: only "HTTP 404" is read from it.
      if log=$(gh api "$API/actions/jobs/$job/logs" 2>"$errfile"); then
        cost=$(sed 's/\x1b\[[0-9;]*m//g' <<<"$log" |
          sed -nE 's/^[^ ]* RESULT subtype=.* total_cost_usd=([0-9.eE+-]+|null)( .*)?$/\1/p' | tail -n 1)
        [[ -z $cost || $cost == null ]] && cost=0
        pr_usd[$pr]=$(usd_add "${pr_usd[$pr]-0}" "$cost")
      elif [[ $conclusion == cancelled ]] && grep -q 'HTTP 404' "$errfile"; then
        cancelled_nolog=$((cancelled_nolog + 1))
      else
        pr_unread[$pr]=1
        unread_cmds+=("gh api $API/actions/jobs/$job/logs | grep 'RESULT subtype='")
      fi
    fi
  done <<<"$jobs"

  pr_runs[$pr]=$((${pr_runs[$pr]-0} + 1))
  pr_jobs[$pr]=$((${pr_jobs[$pr]-0} + njobs))
  pr_min[$pr]=$((${pr_min[$pr]-0} + minutes))
  wf_runs[$name]=$((${wf_runs[$name]-0} + 1))
  wf_jobs[$name]=$((${wf_jobs[$name]-0} + njobs))
  wf_min[$name]=$((${wf_min[$name]-0} + minutes))
done <<<"$runs"

# --- report -----------------------------------------------------------------------------------
fmt_usd() { awk -v a="$1" 'BEGIN { printf "%.2f", a }'; }
prs=0 runs_n=0 jobs_n=0 minutes_n=0 pr_minutes=0 reviews=0 reviewed_prs=0 usd=0 unattributed=0
echo "== per PR"
printf 'pr\truns\tjobs\tminutes\treviews\tclaude_usd\n'
for pr in $(printf '%s\n' "${!pr_runs[@]}" | sort -n); do
  r=${pr_reviews[$pr]-0}
  if [[ -n ${pr_unread[$pr]-} ]]; then c="?"; elif ((r)); then c=$(fmt_usd "${pr_usd[$pr]-0}"); else c="-"; fi
  label=$pr
  [[ $pr == - ]] || label="#$pr"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "${pr_runs[$pr]}" "${pr_jobs[$pr]}" "${pr_min[$pr]}" "$r" "$c"
  runs_n=$((runs_n + pr_runs[$pr]))
  jobs_n=$((jobs_n + pr_jobs[$pr]))
  minutes_n=$((minutes_n + pr_min[$pr]))
  if [[ $pr == - ]]; then
    unattributed=${pr_min[$pr]}
    continue
  fi
  prs=$((prs + 1))
  pr_minutes=$((pr_minutes + pr_min[$pr]))
  reviews=$((reviews + r))
  ((r)) && reviewed_prs=$((reviewed_prs + 1))
  usd=$(usd_add "$usd" "${pr_usd[$pr]-0}")
done
echo "== per workflow"
printf 'workflow\truns\tjobs\tminutes\n'
while IFS= read -r wf; do
  [[ -z $wf ]] && continue
  printf '%s\t%s\t%s\t%s\n' "$wf" "${wf_runs[$wf]}" "${wf_jobs[$wf]}" "${wf_min[$wf]}"
done < <(printf '%s\n' "${!wf_runs[@]}" | sort)
echo "== total"
per_pr="-" usd_per="-"
((prs)) && per_pr=$(awk -v m="$pr_minutes" -v n="$prs" 'BEGIN { printf "%.1f", m / n }')
((reviewed_prs)) && usd_per=$(awk -v a="$usd" -v n="$reviewed_prs" 'BEGIN { printf "%.2f", a / n }')
usd_total=$(fmt_usd "$usd")
if ((${#unread_cmds[@]})); then usd_total="?" usd_per="?"; fi
printf 'prs\t%s\nruns\t%s\njobs\t%s\nminutes\t%s\nminutes_per_pr\t%s\nreviews\t%s\nclaude_usd\t%s\nclaude_usd_per_reviewed_pr\t%s\nunattributed_minutes\t%s\ncancelled_reviews_without_log\t%s\n' \
  "$prs" "$runs_n" "$jobs_n" "$minutes_n" "$per_pr" "$reviews" "$usd_total" "$usd_per" "$unattributed" \
  "$cancelled_nolog"

if ((${#unread_cmds[@]})); then
  printf 'ci-cost: %d review log(s) could not be read, so the Claude cost is incomplete. Read each with:\n' "${#unread_cmds[@]}" >&2
  printf '  %s\n' "${unread_cmds[@]}" >&2
  exit 4
fi
echo "ci-cost: $runs_n runs from $from to $to" >&2

#!/usr/bin/env bash
# Gather what /today needs (#78), read-only: no gh write, no git write, no file written. Prints
# plain sections that the /today skill (.claude/skills/today/SKILL.md) reads; /today stage 2
# (#109) is to reuse it. Tests: scripts/today-gather.test.sh.
# Needs bash 4.4+, git 2.36+, GNU date and an authenticated gh with the `project` scope.
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "today-gather: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
PROJECT=3
TZONE=Europe/Copenhagen

usage() {
  cat >&2 <<'EOF'
usage: scripts/today-gather.sh [--date YYYY-MM-DD]

Gathers what /today needs and prints it, read-only: it reads GitHub and git and writes nothing,
not even a file. Run it from the main folder (from a worktree, "out" is that worktree's).
--date picks the day (default: today in Europe/Copenhagen).

Output: sections headed "== <name>", one tab-separated record per line, "-" for an empty field,
in this order:
  today      date; week (the board's Week iteration that contains the date, or -); root (the
             main folder); out (.scratch/ of this checkout); handoff (path, present|missing)
  ready      every Ready item, by priority then number: #N, mode, priority, size, week,
             parent (#N), an existing .scratch/brief-<N>-*.md, title
  week       every item in this week's iteration, by number: #N, status, mode, priority, size,
             title
  orphans    open issues without a workstream parent (scripts/orphan-issues.sh): #N, title
  worktrees  every worktree but the main folder: path, branch, the PR's state by branch
             (merged|open|closed|none|detached), PR (#N), locked
  strays     folders under .claude/worktrees/ that git doesn't list as worktrees

Exit codes: 0 done; 2 bad arguments (nothing read); 3 GitHub or git couldn't be read, or
answered in an unexpected shape (nothing printed on stdout).
EOF
}

die() { # code message
  printf 'today-gather: %s\n' "$2" >&2
  exit "$1"
}

# --- arguments ----------------------------------------------------------------------------------
today=""
while (($#)); do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --date)
      (($# >= 2)) || { usage; die 2 "--date needs a value"; }
      today=$2
      shift 2
      ;;
    --date=*) today=${1#--date=}; shift ;;
    *) usage; die 2 "unexpected argument \"$1\"" ;;
  esac
done
if [[ -n $today ]]; then
  [[ $today =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && $(date -d "$today" +%F 2>/dev/null) == "$today" ]] ||
    { usage; die 2 "--date takes a real date as YYYY-MM-DD, got \"$today\""; }
else
  today=$(TZ=$TZONE date +%F)
fi

# --- where things are ---------------------------------------------------------------------------
# The main folder holds the handoff and the worktrees; the output goes to the checkout this runs
# in (the main folder, for the coordinator). --git-common-dir is the main folder's .git from any
# worktree.
common=$(git rev-parse --path-format=absolute --git-common-dir) || die 3 "not inside a git repository"
root=$(cd "${common%/.git}" && pwd -P)
top=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
handoff=$root/.remember/remember.md

# --- the board ----------------------------------------------------------------------------------
# One row per item, tab-separated: number, type (Issue/PullRequest/DraftIssue), status, mode,
# priority, size, week title, week start, week duration, title; "-" for a missing field. `week`
# is an object in item-list's JSON. A first "total" line gives the item count, so a --limit
# below it shows up as an error instead of a short board.
BOARD_FILTER='"total\t\(.totalCount)", (.items[] | [(.content.number // "-"), (.content.type // "-"),
  (.status // "-"), (.mode // "-"), (.priority // "-"), (.size // "-"), (.week.title // "-"),
  (.week.startDate // "-"), (.week.duration // "-"), (.title // "-")] | @tsv)'
LIMIT=1000
board=$(gh project item-list "$PROJECT" --owner "$OWNER" --format json --limit "$LIMIT" --jq "$BOARD_FILTER") ||
  die 3 "could not read Project $PROJECT from GitHub (see gh's error above)"

# Check the shape once, so the loops below can trust it.
total="" rows=0
while IFS=$'\t' read -r number type status mode priority size wtitle wstart wdur title; do
  [[ -n $number ]] || continue
  if [[ $number == total ]]; then
    [[ -z $total && $type =~ ^[0-9]+$ ]] || die 3 "unexpected total line from GitHub, has the API changed? $type"
    total=$type
    continue
  fi
  rows=$((rows + 1))
  [[ $number =~ ^[0-9]+$ || ($number == - && $type != Issue) ]] &&
    [[ ($wstart == - && $wdur == -) || ($wstart =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && $wdur =~ ^[0-9]+$) ]] ||
    die 3 "unexpected board row from GitHub, has the API changed? $number $type $wstart $wdur"
done <<<"$board"
[[ -n $total ]] || die 3 "unexpected answer from GitHub: no item count"
((rows >= total)) || die 3 "the board has $total items but $rows were read; raise LIMIT in $0"

week="-"
while IFS=$'\t' read -r number type status mode priority size wtitle wstart wdur title; do
  [[ $number == total || $wstart == - ]] && continue
  if [[ ! $today < $wstart && $today < $(date -d "$wstart $wdur days" +%F) ]]; then
    week=$wtitle
    break
  fi
done <<<"$board"
[[ $week != - ]] || echo "today-gather: no Week iteration on the board contains $today" >&2

# Sections are collected first and printed at the end, so a failed read prints no partial list.
report=""
add_section() { # name lines -> "== name", then the lines; an empty section is just its header
  report+="== $1"$'\n'${2}${2:+$'\n'}
}
add_section today "$(
  printf 'date\t%s\nweek\t%s\nroot\t%s\nout\t%s\n' "$today" "$week" "$root" "$top/.scratch"
  printf 'handoff\t%s\t%s\n' "$handoff" "$([[ -f $handoff ]] && echo present || echo missing)"
)"

# --- ready --------------------------------------------------------------------------------------
# Every Ready item, whatever its week, by priority then number: number, mode, priority, size,
# week, parent ("#N" or "-"), the path of a brief already written for it (or "-"), title. The
# parent comes from REST (item-list doesn't carry it): one GET per Ready item, a handful a day.
parent_of() { # issue number -> "#N" or "-"
  local url
  url=$(gh api -X GET "repos/$OWNER/$REPO/issues/$1" --jq '.parent_issue_url // "-"') ||
    die 3 "could not read the parent of #$1 from GitHub (see gh's error above)"
  if [[ $url == - ]]; then
    echo -
  elif [[ $url =~ /issues/([0-9]+)$ ]]; then
    echo "#${BASH_REMATCH[1]}"
  else
    die 3 "unexpected parent of #$1 from GitHub, has the API changed? $url"
  fi
}
brief_of() { # issue number -> the first .scratch/brief-<N>-*.md in the output folder, or "-"
  local f
  for f in "$top/.scratch/brief-$1-"*.md; do
    [[ -f $f ]] && { echo "$f"; return; }
  done
  echo -
}
ready=""
while IFS=$'\t' read -r number type status mode priority size wtitle wstart wdur title; do
  [[ $number == total || $status != Ready ]] && continue
  if [[ $type != Issue ]]; then
    echo "today-gather: skipped a Ready $type (only issues get a brief): $title" >&2
    continue
  fi
  parent=$(parent_of "$number") # a failed read exits here (set -e), with parent_of's code
  ready+=$(printf '%s\t#%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$priority" "$number" "$mode" "$priority" \
    "$size" "$wtitle" "$parent" "$(brief_of "$number")" "$title")$'\n'
done <<<"$board"
add_section ready "$(printf '%s' "$ready" | sort -t$'\t' -k1,1 -k2.2n | cut -f2-)"

# --- week ---------------------------------------------------------------------------------------
# Every item in this week's iteration, by number: number, status, mode, priority, size, title.
inweek=""
while IFS=$'\t' read -r number type status mode priority size wtitle wstart wdur title; do
  [[ $number == total || $week == - || $wtitle != "$week" ]] && continue
  inweek+=$(printf '#%s\t%s\t%s\t%s\t%s\t%s' "$number" "$status" "$mode" "$priority" "$size" "$title")$'\n'
done <<<"$board"
add_section week "$(printf '%s' "$inweek" | sort -k1.2n)"

# --- orphans ------------------------------------------------------------------------------------
# Open issues without a workstream parent, as orphan-issues.sh (#76) prints them: "#N", tab,
# title. Its exit 1 means "listed", not a failure.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
orphan_code=0
orphans=$(bash "$here/orphan-issues.sh") || orphan_code=$?
((orphan_code <= 1)) || die 3 "orphan-issues.sh failed with exit $orphan_code (see its error above)"
add_section orphans "$orphans"

# --- worktrees ----------------------------------------------------------------------------------
# Every registered worktree but the main folder: path (from the main folder when inside it),
# branch ("-" when detached), the state of the branch's PR (merged/open/closed/none, or
# "detached"), the PR ("#N" or "-") and "locked" or "-". PRs are squash-merged, so the branch is
# never an ancestor of main: "merged" is the PR's state, looked up by branch name. Removing a
# merged worktree is scripts/after-merge.sh's job (#77), not this script's.
wt_paths=() wt_branches=() wt_locks=()
path="" branch="" lock="-"
flush() {
  if [[ -n $path && $path != "$root" ]]; then
    wt_paths+=("$path") wt_branches+=("${branch:--}") wt_locks+=("$lock")
  fi
  path="" branch="" lock="-"
}
worktrees=$(git worktree list --porcelain) || die 3 "git worktree list failed"
while IFS= read -r line; do
  case $line in
    "worktree "*) flush; path=$(cd "${line#worktree }" 2>/dev/null && pwd -P || echo "${line#worktree }") ;;
    "branch refs/heads/"*) branch=${line#branch refs/heads/} ;;
    locked | "locked "*) lock=locked ;;
  esac
done <<<"$worktrees"
flush

# One read for every PR, then a pick per branch: merged, else open, else the newest closed.
declare -A pr_state=() pr_number=()
if ((${#wt_paths[@]})); then
  prs=$(gh pr list --repo "$OWNER/$REPO" --state all --limit "$LIMIT" --json number,state,headRefName \
    --jq '.[] | [.headRefName, .state, .number] | @tsv') ||
    die 3 "could not read the pull requests of $OWNER/$REPO from GitHub (see gh's error above)"
  rank() { case $1 in MERGED) echo 3 ;; OPEN) echo 2 ;; CLOSED) echo 1 ;; *) echo 0 ;; esac; }
  better() { # state number head -> does this PR beat the one picked so far for head?
    local old=${pr_state[$3]-}
    [[ -z $old ]] && return 0
    (($(rank "$1") != $(rank "$old"))) && { (($(rank "$1") > $(rank "$old"))); return; }
    (($2 > pr_number[$3]))
  }
  while IFS=$'\t' read -r head state number; do
    [[ -n $head ]] || continue
    [[ $number =~ ^[0-9]+$ ]] || die 3 "unexpected pull request row from GitHub, has the API changed? $head $state $number"
    if better "$state" "$number" "$head"; then
      pr_state[$head]=$state pr_number[$head]=$number
    fi
  done <<<"$prs"
fi

wts=""
for i in "${!wt_paths[@]}"; do
  p=${wt_paths[i]} b=${wt_branches[i]}
  [[ $p == "$root"/* ]] && p=${p#"$root"/}
  if [[ $b == - ]]; then
    state=detached pr=-
  elif [[ -n ${pr_state[$b]-} ]]; then
    state=${pr_state[$b],,} pr="#${pr_number[$b]}"
  else
    state=none pr=-
  fi
  wts+=$(printf '%s\t%s\t%s\t%s\t%s' "$p" "$b" "$state" "$pr" "${wt_locks[i]}")$'\n'
done
add_section worktrees "$(printf '%s' "$wts" | sort)"

# --- strays -------------------------------------------------------------------------------------
# Folders under .claude/worktrees/ that git doesn't list as worktrees (for example a worktree
# removed by hand, or 4-local-supabase): paths from the main folder. Never touched here.
strays=""
for d in "$root/.claude/worktrees/"*/; do
  [[ -d $d ]] || continue
  d=$(cd "$d" && pwd -P)
  registered=""
  for p in "${wt_paths[@]}"; do [[ $p == "$d" ]] && registered=1; done
  [[ -n $registered ]] || strays+=${d#"$root"/}$'\n'
done
add_section strays "$(printf '%s' "$strays" | sort)"

printf '%s' "$report"

#!/usr/bin/env bash
# Gather what /today needs (#78), read-only: no gh write, no git write, no file written. Prints
# plain sections that the /today skill (.claude/skills/today/SKILL.md) reads; /today stage 2
# (#109) is to reuse it. REST only (`gh api`; #346, docs/agents/github-rest.md): the board through
# the REST Projects API, PRs and parents through repos/<owner>/<repo>.
# Tests: scripts/today-gather.test.sh.
# Needs bash 4.4+, git 2.36+, GNU date and an authenticated gh with the `project` scope.
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "today-gather: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
TZONE=Europe/Copenhagen
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# PROJECT_API, PROJECT_NUMBER, PROJECT_JQ_DEFS, PROJECT_SKIPPED, project_refused.
# shellcheck source=scripts/lib/project-rest.sh
. "$script_dir/lib/project-rest.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/today-gather.sh [--date YYYY-MM-DD]

Gathers what /today needs and prints it, read-only: it reads GitHub and git and writes nothing,
not even a file. Run it from the main folder; from a worktree, "out" is that worktree's.
--date picks the day (default: today in Europe/Copenhagen).

Output: sections headed "== <name>", one tab-separated record per line, "-" for an empty field,
in this order:
  today      date; week (the board's Week iteration that contains the date, or -: weeks are
             read from the items, so an iteration no item is in yet shows as -); root (the
             main folder); out (.scratch/ of the checkout it runs in); handoff (path,
             present|missing)
  ready      every Ready issue, by priority (none last) then number: #N, mode, priority, size,
             week, parent (#N), an existing <out>/brief-<N>-*.md, title
  week       every issue in this week's iteration, by number: #N, status, mode, priority,
             size, title
  orphans    open issues without a workstream parent (scripts/orphan-issues.sh): #N, title
  worktrees  every worktree but the main folder: path, branch, the state of its PR into main
             (open|merged|closed|none|detached; an open PR wins), PR (#N), locked
  strays     folders under .claude/worktrees/ that git doesn't list as worktrees

Where GitHub refuses the Project (HTTP 403, as the cloud's GitHub proxy does), every section is
still printed, but week is - and ready and week are empty because the board couldn't be read;
stderr names the skipped step and it exits 4. Run it again from a local session for those.

Exit codes: 0 done; 2 bad arguments (nothing read); 3 GitHub or git couldn't be read, or
answered in an unexpected shape (nothing printed on stdout); 4 the board was skipped: GitHub
refused the Project, so today's week, ready and week are empty (the other sections are whole).
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

# Any unexpected failure is exit 3, the documented "couldn't be read", never a bare 1.
trap 'exit 3' ERR

# --- where things are ---------------------------------------------------------------------------
# The main folder holds the handoff and the worktrees. The output goes to .scratch/ of the
# checkout this runs in: the main folder for the coordinator, a worktree's own folder from a
# worktree session. --git-common-dir is the main folder's .git from any worktree.
common=$(git rev-parse --path-format=absolute --git-common-dir) || die 3 "not inside a git repository"
root=$(cd "${common%/.git}" && pwd -P)
checkout=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
out=$checkout/.scratch
handoff=$root/.remember/remember.md

# Sections are collected first and printed at the end, so a failed read prints no partial list.
report=""
add_section() { # name lines -> "== name", then the lines; an empty section is just its header
  report+="== $1"$'\n'${2}${2:+$'\n'}
}

# --- the board ----------------------------------------------------------------------------------
# Read through the REST Projects API: the fields first (their ids, and each Week iteration's start
# and length), then every item with those fields, paginated. One row per item, tab-separated:
# number, type (Issue/PullRequest/DraftIssue), status, mode, priority, size, week title, week
# start, week duration, title; "-" for a missing field. An item's iteration value carries its
# title; its start and length come from the field's iterations when the value lacks them.
FIELDS_FILTER="$PROJECT_JQ_DEFS"'
  (["ids", ([.[].id] | map(tostring) | join(","))] | @tsv),
  (.[] | select(.name == "Week") | (.configuration.iterations // []) + (.configuration.completed_iterations // [])
    | .[] | ["iteration", (.title | txt), .start_date, .duration] | @tsv)'
BOARD_FILTER="$PROJECT_JQ_DEFS"'
  .[] | ([.fields[]? | select(.name == "Week") | .value] | first) as $w
  | [(.content.number // "-"), (.content_type // "-"),
    (fv("Status") // "-"), (fv("Mode") // "-"), (fv("Priority") // "-"), (fv("Size") // "-"),
    (if $w then ($w.title | txt) else "-" end), ($w.start_date // "-"), ($w.duration // "-"),
    (fv("Title") // .content.title // "-")] | @tsv'
board_ok=1
err_file=$(mktemp "${TMPDIR:-/tmp}/today-gather.XXXXXX")
trap 'rm -f "$err_file"' EXIT
declare -A iter_start=() iter_days=()
rows=""
if ! fields=$(gh api "$PROJECT_API/fields?per_page=100" --jq "$FIELDS_FILTER" 2>"$err_file"); then
  cat "$err_file" >&2
  project_refused "$err_file" ||
    die 3 "could not read Project $PROJECT_NUMBER from GitHub (see gh's error above)"
  board_ok=0
fi
if ((board_ok)); then
  ids=""
  while IFS=$'\t' read -r kind a b c; do
    case $kind in
      ids) ids=$a ;;
      iteration) iter_start[$a]=$b iter_days[$a]=$c ;;
    esac
  done <<<"$fields"
  [[ $ids =~ ^[0-9]+(,[0-9]+)*$ ]] || die 3 "unexpected fields of Project $PROJECT_NUMBER from GitHub, has the API changed? $ids"
  rows=$(gh api --paginate "$PROJECT_API/items?per_page=100&fields=$ids" --jq "$BOARD_FILTER") ||
    die 3 "could not read Project $PROJECT_NUMBER from GitHub (see gh's error above)"
fi

# Parsed once into parallel arrays (item_*), one entry per board item, after checking the shape.
item_number=() item_type=() item_status=() item_mode=() item_priority=() item_size=()
item_week=() item_start=() item_days=() item_title=()
while IFS=$'\t' read -r number type status mode priority size wtitle wstart wdays title; do
  [[ -n $number ]] || continue
  if [[ $wtitle != - && $wstart == - && -n ${iter_start[$wtitle]-} ]]; then
    wstart=${iter_start[$wtitle]} wdays=${iter_days[$wtitle]}
  fi
  [[ $number =~ ^[0-9]+$ || ($number == - && $type != Issue) ]] &&
    [[ ($wstart == - && $wdays == -) || ($wstart =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && $wdays =~ ^[0-9]+$) ]] ||
    die 3 "unexpected board row from GitHub, has the API changed? $number $type $wstart $wdays"
  item_number+=("$number") item_type+=("$type") item_status+=("$status") item_mode+=("$mode")
  item_priority+=("$priority") item_size+=("$size") item_week+=("$wtitle") item_start+=("$wstart")
  item_days+=("$wdays") item_title+=("$title")
done <<<"$rows"

# This week: the iteration whose dates contain the date (start <= date < start + days).
week="-"
for i in "${!item_number[@]}"; do
  start=${item_start[i]}
  [[ $start != - && ! $today < $start && $today < $(date -d "$start ${item_days[i]} days" +%F) ]] || continue
  week=${item_week[i]}
  break
done
[[ $week != - ]] || ((!board_ok)) || echo "today-gather: no Week iteration on the board contains $today" >&2

add_section today "$(
  printf 'date\t%s\nweek\t%s\nroot\t%s\nout\t%s\n' "$today" "$week" "$root" "$out"
  printf 'handoff\t%s\t%s\n' "$handoff" "$([[ -f $handoff ]] && echo present || echo missing)"
)"

# --- ready --------------------------------------------------------------------------------------
# Every Ready issue, whatever its week, by priority (none last) then number: number, mode,
# priority, size, week, parent ("#N" or "-"), the path of a brief already written for it (or
# "-"), title. The parent comes from REST (item-list doesn't carry it): one GET per Ready item.
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
  for f in "$out/brief-$1-"*.md; do
    [[ -f $f ]] && { echo "$f"; return; }
  done
  echo -
}
ready=""
for i in "${!item_number[@]}"; do
  [[ ${item_status[i]} == Ready ]] || continue
  if [[ ${item_type[i]} != Issue ]]; then
    echo "today-gather: skipped a Ready ${item_type[i]} (only issues get a brief): ${item_title[i]}" >&2
    continue
  fi
  number=${item_number[i]}
  parent=$(parent_of "$number") # a failed read exits here (set -e), with parent_of's code
  sort_key=${item_priority[i]/#-/P9} # no priority sorts after P3
  ready+=$(printf '%s\t#%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$sort_key" "$number" "${item_mode[i]}" \
    "${item_priority[i]}" "${item_size[i]}" "${item_week[i]}" "$parent" "$(brief_of "$number")" \
    "${item_title[i]}")$'\n'
done
add_section ready "$(printf '%s' "$ready" | LC_ALL=C sort -t$'\t' -k1,1 -k2.2n | cut -f2-)"

# --- week ---------------------------------------------------------------------------------------
# Every issue in this week's iteration, by number: number, status, mode, priority, size, title.
# Drafts have no number, so they're left out.
in_week=""
for i in "${!item_number[@]}"; do
  [[ $week != - && ${item_week[i]} == "$week" && ${item_type[i]} == Issue ]] || continue
  in_week+=$(printf '#%s\t%s\t%s\t%s\t%s\t%s' "${item_number[i]}" "${item_status[i]}" \
    "${item_mode[i]}" "${item_priority[i]}" "${item_size[i]}" "${item_title[i]}")$'\n'
done
add_section week "$(printf '%s' "$in_week" | LC_ALL=C sort -k1.2n)"

# --- orphans ------------------------------------------------------------------------------------
# Open issues without a workstream parent, as orphan-issues.sh (#76) prints them: "#N", tab,
# title. Its exit 1 means "listed", not a failure.
orphan_code=0
orphans=$(bash "$script_dir/orphan-issues.sh") || orphan_code=$?
((orphan_code <= 1)) || die 3 "orphan-issues.sh failed with exit $orphan_code (see its error above)"
add_section orphans "$orphans"

# --- worktrees ----------------------------------------------------------------------------------
# Every registered worktree but the main folder (wt_*: physical path, branch or "-", "locked" or
# "-"), from git worktree list's porcelain records.
wt_path=() wt_branch=() wt_lock=()
path="" branch="" lock="-"
end_record() {
  if [[ -n $path && $path != "$root" ]]; then
    wt_path+=("$path") wt_branch+=("${branch:--}") wt_lock+=("$lock")
  fi
  path="" branch="" lock="-"
}
worktrees=$(git worktree list --porcelain) || die 3 "git worktree list failed"
while IFS= read -r line; do
  case $line in
    "worktree "*) end_record; path=$(cd "${line#worktree }" 2>/dev/null && pwd -P || echo "${line#worktree }") ;;
    "branch refs/heads/"*) branch=${line#branch refs/heads/} ;;
    locked | "locked "*) lock=locked ;;
  esac
done <<<"$worktrees"
end_record

# The PR of each branch, from one read of every PR into main (pr_state, pr_number, keyed by head
# branch). A branch with several PRs keeps the open one (the branch is still in use), else the
# merged one, else the newest closed one. PRs are squash-merged, so the branch is never an
# ancestor of main: "merged" is the PR's state. Removing a merged worktree is
# scripts/after-merge.sh's job (#77), which checks the branch's commits again.
state_rank() { case $1 in OPEN) echo 3 ;; MERGED) echo 2 ;; CLOSED) echo 1 ;; *) echo 0 ;; esac; }
replaces() { # state number head -> does this PR replace the one kept so far for head?
  local kept_state=${pr_state[$3]-} kept_number=${pr_number[$3]-0} new_rank kept_rank
  [[ -n $kept_state ]] || return 0
  new_rank=$(state_rank "$1") kept_rank=$(state_rank "$kept_state")
  if ((new_rank != kept_rank)); then
    ((new_rank > kept_rank))
  else
    (($2 > kept_number))
  fi
}
declare -A pr_state=() pr_number=()
if ((${#wt_path[@]})); then
  # REST "List pull requests", every page: a closed PR with merged_at set is MERGED.
  prs=$(gh api --paginate "repos/$OWNER/$REPO/pulls?state=all&base=main&per_page=100" \
    --jq '.[] | [.head.ref, (if .merged_at then "MERGED" elif .state == "open" then "OPEN" else "CLOSED" end),
      .number] | @tsv') ||
    die 3 "could not read the pull requests of $OWNER/$REPO from GitHub (see gh's error above)"
  while IFS=$'\t' read -r head state number; do
    [[ -n $head ]] || continue
    [[ $number =~ ^[0-9]+$ ]] || die 3 "unexpected pull request row from GitHub, has the API changed? $head $state $number"
    if replaces "$state" "$number" "$head"; then
      pr_state[$head]=$state pr_number[$head]=$number
    fi
  done <<<"$prs"
fi

worktree_lines=""
for i in "${!wt_path[@]}"; do
  wt=${wt_path[i]} wt_br=${wt_branch[i]}
  [[ $wt == "$root"/* ]] && wt=${wt#"$root"/}
  if [[ $wt_br == - ]]; then
    state=detached pr=-
  elif [[ -n ${pr_state[$wt_br]-} ]]; then
    state=${pr_state[$wt_br],,} pr="#${pr_number[$wt_br]}"
  else
    state=none pr=-
  fi
  worktree_lines+=$(printf '%s\t%s\t%s\t%s\t%s' "$wt" "$wt_br" "$state" "$pr" "${wt_lock[i]}")$'\n'
done
add_section worktrees "$(printf '%s' "$worktree_lines" | LC_ALL=C sort)"

# --- strays -------------------------------------------------------------------------------------
# Folders under .claude/worktrees/ that git doesn't list as worktrees (for example a worktree
# removed by hand, or 4-local-supabase): paths from the main folder. Never touched here.
strays=""
for folder in "$root/.claude/worktrees/"*/; do
  [[ -d $folder ]] || continue
  folder=$(cd "$folder" && pwd -P)
  registered=""
  for wt in "${wt_path[@]}"; do [[ $wt == "$folder" ]] && registered=1; done
  [[ -n $registered ]] || strays+=${folder#"$root"/}$'\n'
done
add_section strays "$(printf '%s' "$strays" | LC_ALL=C sort)"

printf '%s' "$report"
if ((!board_ok)); then
  echo "today-gather: skipped the board: GitHub refused Project $PROJECT_NUMBER here ($PROJECT_REFUSED_WHY), so week is - and ready and week are empty; orphans, worktrees and strays are whole. Run it again where the Project can be reached for the board: scripts/today-gather.sh --date $today" >&2
  exit "$PROJECT_SKIPPED"
fi

#!/usr/bin/env bash
# Tests for today-gather.sh through its command line. `gh` is a fake on PATH that never reaches
# GitHub, and `git` is a wrapper that passes reads to the real git. Both record any write they
# are asked for in $work/writes, and every case fails if that file isn't empty: that is how
# "read-only" (#78) is a check, not a promise. Each case also snapshots the throwaway repo and
# fails if the script changed, added or removed a file in it.
# Run: bash scripts/today-gather.test.sh (needs git 2.36+ and GNU date)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/today-gather.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/today-gather-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
real_git=$(command -v git)

# --- fake gh ----------------------------------------------------------------------------------
# Allowed (reads): `api` as a GET, over REST (#346). Anything else is recorded
# in $work/writes and fails with exit 97: the writes this guards against are `issue
# create|edit|comment|close|...`, `project item-edit|item-add|...`, `pr create|merge|edit|...`,
# `label ...` and `api` with -X/--method other than GET, or with fields (-f/-F/--input) and no
# -X GET, which gh sends as a POST. Every call is logged to $work/calls, then a "--" line.
# Reads serve fixture files: $work/fields.json (the Project's fields, through the call's --jq),
# $work/board (the items' --jq rows), $work/prs (the pulls' --jq rows), $work/parents
# ("<n><tab><parent url or ->" lines, for api .../issues/<n>) and $work/orphan-rows (rows for
# orphan-issues.sh's own api call). $work/fail-<name> makes that read print the file to stderr
# and exit 1, as gh does on an HTTP error; $work/refuse-projects makes every Project read answer
# as the cloud proxy does (HTTP 403).
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
write() { printf 'gh %s\n' "$*" >>"$dir/writes"; echo "fake gh: refused a write: $*" >&2; exit 97; }
serve() { # name [args...] -> the fixture, or the call's --jq filter run over <name>.json if it exists
  local name=$1
  shift
  if [[ -f $dir/fail-$name ]]; then cat "$dir/fail-$name" >&2; exit 1; fi
  if [[ -f $dir/$name.json ]]; then
    while (($#)) && [[ $1 != --jq ]]; do shift; done
    [[ -n ${2-} ]] || { echo "fake: no --jq filter given" >&2; exit 98; }
    jq -r "$2" "$dir/$name.json"
    exit
  fi
  cat "$dir/$name" 2>/dev/null
  exit 0
}
[[ $1 == api ]] || write "$@"
method="" fields="" path=""
args=("${@:2}")
for ((i = 0; i < ${#args[@]}; i++)); do
  case ${args[i]} in
    -X | --method) method=${args[i + 1]}; i=$((i + 1)) ;;
    -X*) method=${args[i]#-X} ;;
    --method=*) method=${args[i]#--method=} ;;
    -f | -F | --field | --raw-field | --input) fields=1; i=$((i + 1)) ;;
    --jq | -q | -H | --header | -t | --template | -p | --preview | --hostname | --cache) i=$((i + 1)) ;;
    -*) ;;
    *) [[ -z $path ]] && path=${args[i]} ;;
  esac
done
if [[ -n $method ]]; then
  [[ ${method^^} == GET ]] || write "$@"
elif [[ -n $fields ]]; then
  write "$@"
fi
if [[ -f $dir/refuse-projects && $path == users/*/projectsV2/* ]]; then
  echo 'gh: This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...). (HTTP 403)' >&2
  exit 1
fi
case $path in
  users/sssoto17/projectsV2/3/fields\?*) serve fields "$@" ;;
  users/sssoto17/projectsV2/3/items\?*) serve board "$@" ;;
  repos/sssoto17/sunny-pastures/pulls\?*) serve prs "$@" ;;
  repos/*/issues) serve orphan-rows ;;
  repos/*/issues/*)
    [[ -f $dir/fail-parents ]] && serve parents
    n=${path##*/}
    awk -F'\t' -v n="$n" '$1 == n { print $2; found = 1 } END { exit !found }' "$dir/parents" ||
      { echo "fake gh: no parent fixture for issue $n" >&2; exit 1; }
    exit 0 ;;
esac
echo "fake gh: unexpected read: $*" >&2
exit 99
FAKE

# --- git wrapper ------------------------------------------------------------------------------
# Passes the read subcommands this script needs (rev-parse, worktree list) to the real git and
# records anything else in $work/writes, failing with exit 97. Global options before the
# subcommand (-C <dir>, -c <k=v>, --no-pager and the like) are skipped to find it.
cat >"$work/bin/git" <<FAKE
#!/usr/bin/env bash
real_git='$real_git'
dir='$work'
FAKE
cat >>"$work/bin/git" <<'FAKE'
args=("$@")
i=0
while ((i < ${#args[@]})); do
  case ${args[i]} in
    -C | -c) i=$((i + 2)) ;;
    -*) i=$((i + 1)) ;;
    *) break ;;
  esac
done
sub=${args[i]-}
next=${args[i + 1]-}
case "$sub" in
  rev-parse) ;;
  worktree) [[ $next == list ]] || { printf 'git %s\n' "$*" >>"$dir/writes"; echo "git wrapper: refused: $*" >&2; exit 97; } ;;
  *) printf 'git %s\n' "$*" >>"$dir/writes"; echo "git wrapper: refused: $*" >&2; exit 97 ;;
esac
exec "$real_git" "$@"
FAKE
chmod +x "$work/bin/gh" "$work/bin/git"

# --- fixtures ---------------------------------------------------------------------------------
T=$'\t'
WK2="Wk 2 · 9–15 Nov"
WK3="Wk 3 · 16–22 Nov"
# One board row as the script's --jq filter emits it: number, type, status, priority, size, week
# title, week start, week duration, title. Missing fields are "-".
item() { # number status priority size week-title week-start title (a week lasts 7 days)
  local dur=7
  [[ $6 == - ]] && dur=-
  printf '%s\tIssue\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$dur" "$7"
}
board() { # rows... -> the items' answer, through the script's filter
  printf '%s' "$*" >"$work/board"
}
# The Project's fields as REST lists them: ids, and the Week iterations. Mode (4) and Track (7)
# are still on the Project until the admin deletes them (#621); the script never asks for them.
fields_json() {
  jq -n --arg w2 "$WK2" --arg w3 "$WK3" '[{id: 1, name: "Title", data_type: "title"},
    {id: 2, name: "Status", data_type: "single_select", options: []},
    {id: 4, name: "Mode", data_type: "single_select", options: []},
    {id: 5, name: "Priority", data_type: "single_select", options: []},
    {id: 6, name: "Size", data_type: "single_select", options: []},
    {id: 7, name: "Track", data_type: "single_select", options: []},
    {id: 3, name: "Week", data_type: "iteration", configuration: {iterations: [
      {id: "7f9c9b7a", title: {raw: $w2, html: $w2}, start_date: "2026-11-09", duration: 7},
      {id: "b40f9349", title: {raw: $w3, html: $w3}, start_date: "2026-11-16", duration: 7}]}}]' \
    >"$work/fields.json"
}

# A throwaway main folder with a commit, under $work/repo. Built with the real git: only the
# script under test runs behind the wrapper.
new_repo() {
  rm -rf "$work/repo"
  "$real_git" init -q -b main "$work/repo"
  "$real_git" -C "$work/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  mkdir -p "$work/repo/.claude/worktrees"
}
add_worktree() { # name [branch] -> a registered worktree; no branch means a detached HEAD
  if [[ -n ${2-} ]]; then
    "$real_git" -C "$work/repo" worktree add -q --no-track -b "$2" ".claude/worktrees/$1"
  else
    "$real_git" -C "$work/repo" worktree add -q --detach ".claude/worktrees/$1"
  fi
}

reset() { # -> an empty board, no PRs, no orphans, a fresh repo
  rm -f "$work"/calls "$work"/writes "$work"/board "$work"/prs "$work"/parents "$work"/orphan-rows "$work"/fail-* "$work"/refuse-* "$work"/*.json
  : >"$work/prs"
  : >"$work/parents"
  : >"$work/orphan-rows"
  board ""
  fields_json
  new_repo
}

snapshot() { # -> one line per path in the repo: type, size, mtime, path
  find "$work/repo" -path "$work/repo/.git/objects" -prune -o -printf '%y %s %T@ %P\n' | sort
}

run() { # args... -> sets code, out, err, calls; runs in $work/repo unless $cwd is set
  local before after
  before=$(snapshot)
  out=$(cd "${cwd:-$work/repo}" && PATH="${extra_path:+$extra_path:}$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
  after=$(snapshot)
  assert "read-only: no gh or git write was attempted" test ! -s "$work/writes"
  assert "read-only: the repo's files are unchanged" test "$before" == "$after"
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  case: %s\n  exit: %s\n  stdout:\n%s\n  stderr: %s\n  writes: %s\n' \
    "$1" "${label-}" "${code-}" "${out-}" "${err-}" "$(cat "$work/writes" 2>/dev/null)"
}
assert() { # message command... -> ok if the command succeeds
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_no_gh() { assert "expected no gh calls at all" test -z "$calls"; }
# The lines of one section: from "== <name>" up to the next "== " line, without the header.
section() { awk -v h="== $1" '$0 == h { on = 1; next } /^== / { on = 0 } on' <<<"$out"; }
expect_section() { # name expected-lines
  assert "expected section $1 to be exactly:"$'\n'"$2"$'\n'"got:"$'\n'"$(section "$1")" test "$(section "$1")" == "$2"
}
case_() { label=$1; shift; run "$@"; }

# --- usage ------------------------------------------------------------------------------------
for flag in --help -h; do
  reset
  case_ "$flag" "$flag"
  expect_code 0
  expect_err "usage:"
  expect_no_gh
done

for bad_args in "--colour" "28" "--date" "--date 9-11-2026" "--date 2026-02-30" "--date 2026-11-09 extra"; do
  reset
  read -ra words <<<"$bad_args"
  case_ "bad: $bad_args" "${words[@]}"
  expect_code 2
  expect_err "usage:"
  expect_no_gh
done

# --- today: the date, this week's iteration, where things are --------------------------------
# The week is the iteration whose dates contain the date: start <= date < start + duration.
two_weeks="$(item 81 'In progress' P0 M "$WK2" 2026-11-09 'Sim package')
$(item 82 Backlog P0 M "$WK3" 2026-11-16 'Wheat end to end')"
for pair in "2026-11-09|$WK2" "2026-11-15|$WK2" "2026-11-16|$WK3"; do
  reset
  board "$two_weeks"
  case_ "week of ${pair%%|*}" --date "${pair%%|*}"
  expect_code 0
  repo=$(cd "$work/repo" && pwd -P)
  expect_section today "date${T}${pair%%|*}
week${T}${pair#*|}
root${T}$repo
out${T}$repo/.scratch
handoff${T}$repo/.remember/remember.md${T}missing"
done

reset
board "$two_weeks"
mkdir -p "$work/repo/.remember"
echo "handoff" >"$work/repo/.remember/remember.md"
case_ "handoff present" --date 2026-11-09
expect_section today "date${T}2026-11-09
week${T}$WK2
root${T}$repo
out${T}$repo/.scratch
handoff${T}$repo/.remember/remember.md${T}present"
expect_call() { # substring of one call, its arguments joined by spaces
  if awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls" |
    grep -qF -- "$1"; then ok; else bad "expected a gh call containing: $1"; fi
}
expect_call "api users/sssoto17/projectsV2/3/fields?per_page=100 --jq"
expect_call "api --paginate users/sssoto17/projectsV2/3/items?per_page=100&fields=1,2,5,6,3 --jq"

# No --date: today in Copenhagen. A `date` stub answers a bare `date +%F` by TZ (late on 8 Nov
# in UTC is already 9 Nov in Copenhagen) and passes every other call to the real date.
mkdir -p "$work/datebin"
cat >"$work/datebin/date" <<FAKE
#!/usr/bin/env bash
if [[ \$# -eq 1 && \$1 == +%F ]]; then
  [[ \${TZ-} == Europe/Copenhagen ]] && echo 2026-11-09 || echo 2026-11-08
  exit 0
fi
exec $(command -v date) "\$@"
FAKE
chmod +x "$work/datebin/date"
reset
board "$two_weeks"
extra_path="$work/datebin"
case_ "default date"
unset extra_path
expect_code 0
assert "expected today in Copenhagen" contains "$(section today)" "date${T}2026-11-09"$'\n'"week${T}$WK2"

# No iteration holds the date: say so, list no week, but still gather the rest.
reset
board "$two_weeks"
case_ "no week" --date 2026-12-01
expect_code 0
assert "expected week -" contains "$(section today)" "week${T}-"
expect_err "no Week iteration on the board contains 2026-12-01"

# --- ready: what the admin chose, with each item's parent and any brief already written --------
# Every Ready item, whatever its week, by priority then number. A brief counts as written when
# .scratch/brief-<N>-*.md exists in the output folder; /today leaves it alone.
P72=https://api.github.com/repos/sssoto17/sunny-pastures/issues/72
P73=https://api.github.com/repos/sssoto17/sunny-pastures/issues/73
ready_board="$(item 55 Ready P2 S "$WK2" 2026-11-09 'Retro inbox')
$(item 81 Ready P0 M "$WK2" 2026-11-09 'Sim package, purity guard and state hash')
$(item 82 Backlog P0 M "$WK3" 2026-11-16 'Wheat end to end')
$(item 90 Ready P1 S "$WK3" 2026-11-16 'Factory job')
$(item 91 Ready P1 S - - 'No week yet')
$(item 92 Ready - - - - 'No priority yet')"
reset
board "$ready_board"
printf '81\t%s\n55\t-\n90\t%s\n91\t-\n92\t-\n' "$P72" "$P73" >"$work/parents"
mkdir -p "$work/repo/.scratch"
echo "hand-written" >"$work/repo/.scratch/brief-81-sim-package.md"
case_ "ready" --date 2026-11-09
expect_code 0
repo=$(cd "$work/repo" && pwd -P)
expect_section ready "#81${T}P0${T}M${T}$WK2${T}#72${T}$repo/.scratch/brief-81-sim-package.md${T}Sim package, purity guard and state hash
#90${T}P1${T}S${T}$WK3${T}#73${T}-${T}Factory job
#91${T}P1${T}S${T}-${T}-${T}-${T}No week yet
#55${T}P2${T}S${T}$WK2${T}-${T}-${T}Retro inbox
#92${T}-${T}-${T}-${T}-${T}-${T}No priority yet"
expect_call "api -X GET repos/sssoto17/sunny-pastures/issues/81 --jq"

# A brief for another number that starts with the same digits isn't this item's brief.
reset
board "$(item 8 Ready P1 S "$WK2" 2026-11-09 'Eight')"
printf '8\t-\n' >"$work/parents"
mkdir -p "$work/repo/.scratch"
echo "x" >"$work/repo/.scratch/brief-81-sim-package.md"
case_ "brief prefix" --date 2026-11-09
expect_section ready "#8${T}P1${T}S${T}$WK2${T}-${T}-${T}Eight"

# A parent that can't be read stops the run: a brief drafted without its parent's Context
# would miss what the lane must read.
reset
board "$ready_board"
echo "HTTP 502" >"$work/fail-parents"
case_ "parent unreadable" --date 2026-11-09
expect_code 3
expect_err "could not read the parent of #"

# --- week: every issue in this week's iteration, by number; drafts have no number, so none -----
reset
board "$(item 111 Done P2 S "$WK2" 2026-11-09 'PostToolUse hook')
$(printf -- '-\tDraftIssue\tBacklog\t-\t-\t%s\t2026-11-09\t7\tA draft' "$WK2")
$(item 82 Backlog P0 M "$WK3" 2026-11-16 'Wheat end to end')
$(item 78 'In progress' P1 M "$WK2" 2026-11-09 '/today stage 1 (read-only)')
$(item 31 Backlog P2 S "$WK2" 2026-11-09 'Decide how action logs stay replayable')"
case_ "week" --date 2026-11-10
expect_code 0
expect_section week "#31${T}Backlog${T}P2${T}S${T}Decide how action logs stay replayable
#78${T}In progress${T}P1${T}M${T}/today stage 1 (read-only)
#111${T}Done${T}P2${T}S${T}PostToolUse hook"

reset
board "$(item 82 Backlog P0 M "$WK3" 2026-11-16 'Wheat end to end')"
case_ "week, none" --date 2026-12-01
expect_code 0
expect_section week ""
assert "expected the sections in order" test "$(grep '^== ' <<<"$out" | tr '\n' ' ')" == \
  "== today == ready == week == orphans == worktrees == strays "
assert "expected no blank lines" test "$(grep -c '^$' <<<"$out")" -eq 0

# --- orphans: open issues without a workstream parent, from orphan-issues.sh (#76) -------------
# The fake serves orphan-issues.sh's own rows: number, kind, parent, sub-issue total, labels
# (joined by \x1f, "-" for none), title.
reset
printf '31\tissue\tnone\t0\tdesign\tDecide how action logs stay replayable\n28\tissue\tnone\t0\tbug\tCheck transaction use\n76\tissue\tparent\t0\tchore\tParented\n' >"$work/orphan-rows"
case_ "orphans" --date 2026-11-09
expect_code 0
expect_section orphans "#28${T}Check transaction use
#31${T}Decide how action logs stay replayable"
expect_call "api -X GET repos/sssoto17/sunny-pastures/issues -f state=open"

reset
case_ "orphans, none" --date 2026-11-09
expect_code 0
expect_section orphans ""

reset
echo "HTTP 502" >"$work/fail-orphan-rows"
case_ "orphans unreadable" --date 2026-11-09
expect_code 3
expect_err "orphan-issues.sh failed"
assert "expected no stdout when a read fails" test -z "$out"

# --- worktrees and strays ---------------------------------------------------------------------
# Every registered worktree but the main folder: path from the main folder, branch, the state of
# its PR into main (open, merged, closed or none; a branch with several PRs shows the open one
# first, since the branch is still in use, then the merged one, then the newest closed one), the
# PR, and whether it's locked (a session may still hold it). PRs are squash-merged, so "merged"
# is the PR's state, never git ancestry.
# A stray is a folder under .claude/worktrees/ that git doesn't list.
reset
add_worktree 9-merged chore/9-merged
add_worktree 10-open chore/10-open
add_worktree 11-none chore/11-none
add_worktree 12-detached
add_worktree 13-closed chore/13-closed
add_worktree 14-reused chore/14-reused
"$real_git" -C "$work/repo" worktree lock --reason "claude session" .claude/worktrees/9-merged
mkdir -p "$work/repo/.claude/worktrees/4-local-supabase/supabase"
printf 'chore/9-merged\tCLOSED\t100\nchore/9-merged\tMERGED\t114\nchore/9-merged\tCLOSED\t120\nchore/10-open\tCLOSED\t130\nchore/10-open\tOPEN\t116\nchore/13-closed\tCLOSED\t90\nchore/13-closed\tCLOSED\t95\nchore/14-reused\tMERGED\t150\nchore/14-reused\tOPEN\t140\nchore/other\tMERGED\t7\n' >"$work/prs"
case_ "worktrees" --date 2026-11-09
expect_code 0
expect_section worktrees ".claude/worktrees/10-open${T}chore/10-open${T}open${T}#116${T}-
.claude/worktrees/11-none${T}chore/11-none${T}none${T}-${T}-
.claude/worktrees/12-detached${T}-${T}detached${T}-${T}-
.claude/worktrees/13-closed${T}chore/13-closed${T}closed${T}#95${T}-
.claude/worktrees/14-reused${T}chore/14-reused${T}open${T}#140${T}-
.claude/worktrees/9-merged${T}chore/9-merged${T}merged${T}#114${T}locked"
expect_section strays ".claude/worktrees/4-local-supabase"
expect_call "api --paginate repos/sssoto17/sunny-pastures/pulls?state=all&base=main&per_page=100 --jq"

# From inside a worktree: the main folder is still the root, the output goes to this checkout.
cwd="$work/repo/.claude/worktrees/10-open"
case_ "from a worktree" --date 2026-11-09
unset cwd
expect_code 0
repo=$(cd "$work/repo" && pwd -P)
assert "expected root to be the main folder" contains "$(section today)" "root${T}$repo"$'\n'
assert "expected out in the worktree" contains "$(section today)" "out${T}$repo/.claude/worktrees/10-open/.scratch"
assert "expected the main folder not listed" \
  test "$(section worktrees | awk -F'\t' -v r="$repo" '$1 == r || $1 == "." || $1 == ""' | wc -l)" -eq 0
assert "expected the other worktree listed" contains "$(section worktrees)" ".claude/worktrees/9-merged"

# A branch name is data, never code: a PR's head branch is chosen by whoever opens it.
reset
add_worktree 9-merged chore/9-merged
evil="x\$(touch $work/pwned)" # a literal $(...) in the branch name
printf '%s\tCLOSED\t1\n%s\tCLOSED\t2\n' "$evil" "$evil" >"$work/prs"
case_ "branch name as data" --date 2026-11-09
expect_code 0
assert "expected no command run from a branch name" test ! -e "$work/pwned"

reset
add_worktree 9-merged chore/9-merged
echo "HTTP 502" >"$work/fail-prs"
case_ "prs unreadable" --date 2026-11-09
expect_code 3
expect_err "could not read the pull requests"

# No worktrees: nothing to look up.
reset
case_ "no worktrees" --date 2026-11-09
expect_section worktrees ""
expect_section strays ""
assert "expected no pulls call" test "$(grep -c '/pulls?' <<<"$calls")" -eq 0

# --- the board can't be read ---------------------------------------------------------------------
# Every page is read (--paginate), so there is no item limit to hit.
reset
echo "gh: Bad credentials (HTTP 401)" >"$work/fail-board"
case_ "board unreadable" --date 2026-11-09
expect_code 3
expect_err "could not read Project 3"
assert "expected no stdout when the board fails" test -z "$out"

reset
echo "gh: Bad credentials (HTTP 401)" >"$work/fail-fields"
case_ "fields unreadable" --date 2026-11-09
expect_code 3
expect_err "could not read Project 3"
assert "expected no stdout when the fields fail" test -z "$out"

for broken in "$(printf 'abc\tIssue\tReady\tP0\tM\t-\t-\t-\tT')" \
  "$(printf '81\tIssue\tReady\tP0\tM\t%s\tsoon\t7\tT' "$WK2")"; do
  reset
  printf '%s\n' "$broken" >"$work/board"
  case_ "board shape: $broken" --date 2026-11-09
  expect_code 3
  expect_err "unexpected"
done

# --- the Project refused (the cloud proxy, #346) -----------------------------------------------
# Every section is still printed in its format, the board's empty; exit 4 names what was skipped.
reset
touch "$work/refuse-projects"
board "$(item 81 Ready P0 M "$WK2" 2026-11-09 'Sim package')"
printf '7\tissue\tnone\t0\tchore\tLonely\n' >"$work/orphan-rows"
add_worktree 9-merged chore/9-merged
printf 'chore/9-merged\tMERGED\t114\n' >"$work/prs"
case_ "board refused" --date 2026-11-09
expect_code 4
repo=$(cd "$work/repo" && pwd -P)
expect_section today "date${T}2026-11-09
week${T}-
root${T}$repo
out${T}$repo/.scratch
handoff${T}$repo/.remember/remember.md${T}missing"
expect_section ready ""
expect_section week ""
expect_section orphans "#7${T}Lonely"
expect_section worktrees ".claude/worktrees/9-merged${T}chore/9-merged${T}merged${T}#114${T}-"
expect_err "(HTTP 403)"
expect_err "today-gather: skipped the board: GitHub refused Project 3 here"
expect_err "Run it again where the Project can be reached for the board: scripts/today-gather.sh --date 2026-11-09"
expect_err "gh auth refresh -h github.com -s project"
assert "expected no 'no Week iteration' warning when the board was skipped" test "${err/no Week iteration/}" == "$err"

# --- the script's own --jq filters, over answers in GitHub's shape ------------------------------
# REST shapes as GitHub's REST description shows them ("List items for a user owned project",
# "List pull requests"): a single-select value's name is {raw, html}; an iteration value has a
# title and may lack its dates (taken from the field's iterations); a draft has no number; an
# item may have no week or no size; Mode, still on the board until the admin deletes it (#621),
# is left out of the rows; a closed PR with merged_at is merged.
cat >"$work/board.json.in" <<'JSON'
[
  {"id": 1, "content_type": "Issue", "content": {"number": 81, "title": "Sim package"}, "fields": [
    {"id": 1, "name": "Title", "value": {"raw": "Sim package", "html": "Sim package", "number": 81}},
    {"id": 2, "name": "Status", "value": {"id": "eb23e874", "name": {"raw": "Ready", "html": "Ready"}}},
    {"id": 4, "name": "Mode", "value": {"id": "ca9bd7b8", "name": {"raw": "Manual", "html": "Manual"}}},
    {"id": 5, "name": "Priority", "value": {"id": "598fd74b", "name": {"raw": "P0", "html": "P0"}}},
    {"id": 6, "name": "Size", "value": {"id": "e0e2efb6", "name": {"raw": "M", "html": "M"}}},
    {"id": 3, "name": "Week", "value": {"id": "7f9c9b7a", "title": {"raw": "Wk 2 · 9–15 Nov", "html": "Wk 2 · 9–15 Nov"}}}]},
  {"id": 2, "content_type": "Issue", "content": {"number": 73, "title": "Agent workflow"}, "fields": [
    {"id": 2, "name": "Status", "value": {"id": "97a20eba", "name": {"raw": "Backlog", "html": "Backlog"}}},
    {"id": 5, "name": "Priority", "value": {"id": "ad39d061", "name": {"raw": "P1", "html": "P1"}}},
    {"id": 3, "name": "Week", "value": null}]},
  {"id": 3, "content_type": "DraftIssue", "content": {"title": "A draft"}, "fields": [
    {"id": 1, "name": "Title", "value": {"raw": "A draft", "html": "A draft"}},
    {"id": 2, "name": "Status", "value": {"id": "97a20eba", "name": {"raw": "Backlog", "html": "Backlog"}}},
    {"id": 3, "name": "Week", "value": {"id": "7f9c9b7a", "title": {"raw": "Wk 2 · 9–15 Nov", "html": "Wk 2 · 9–15 Nov"}}}]}
]
JSON
cat >"$work/prs.json.in" <<'JSON'
[{"number": 114, "state": "closed", "merged_at": "2026-11-10T10:00:00Z", "head": {"ref": "chore/9-merged"}},
 {"number": 113, "state": "closed", "merged_at": null, "head": {"ref": "chore/9-merged"}},
 {"number": 116, "state": "open", "merged_at": null, "head": {"ref": "chore/10-open"}}]
JSON
reset
cp "$work/board.json.in" "$work/board.json"
cp "$work/prs.json.in" "$work/prs.json"
printf '81\t%s\n' "$P72" >"$work/parents"
add_worktree 9-merged chore/9-merged
add_worktree 10-open chore/10-open
case_ "filters over real shapes" --date 2026-11-09
expect_code 0
# No item carries its own dates, so this week is found only by filling them from the field.
assert "expected this week from the field's iterations" contains "$(section today)" "week${T}$WK2"$'\n'
expect_section ready "#81${T}P0${T}M${T}$WK2${T}#72${T}-${T}Sim package"
expect_section week "#81${T}Ready${T}P0${T}M${T}Sim package"
expect_section worktrees ".claude/worktrees/10-open${T}chore/10-open${T}open${T}#116${T}-
.claude/worktrees/9-merged${T}chore/9-merged${T}merged${T}#114${T}-"

# --- the guards catch writes ------------------------------------------------------------------
# If the fakes let a write through, every "read-only" assertion above would pass for nothing.
guard_catches() { # tool args... -> ok if the fake refuses it and records it
  rm -f "$work/writes"
  if (cd "$work/repo" && PATH="$work/bin:$PATH" "$@" >/dev/null 2>&1); then
    bad "guard let through: $*"
  elif [[ -s $work/writes ]]; then ok; else bad "guard didn't record: $*"; fi
  rm -f "$work/writes"
}
reset
label="guards"
guard_catches gh issue edit 81 --add-label x
guard_catches gh issue comment 81 --body x
guard_catches gh issue create --title x
guard_catches gh issue close 81
guard_catches gh project item-edit --id x
guard_catches gh project item-add 3 --owner sssoto17 --url x
guard_catches gh pr create --title x
guard_catches gh pr merge 116
guard_catches gh pr edit 116 --add-label x
guard_catches gh label create x
guard_catches gh api -X POST repos/sssoto17/sunny-pastures/issues
guard_catches gh api --method PATCH repos/sssoto17/sunny-pastures/issues/81
guard_catches gh api -XDELETE repos/sssoto17/sunny-pastures/issues/81/labels/x
guard_catches gh api repos/sssoto17/sunny-pastures/issues -f title=x
guard_catches gh api graphql -f query=x
guard_catches gh project item-list 3 --owner sssoto17
guard_catches gh pr list --repo sssoto17/sunny-pastures
guard_catches git commit --allow-empty -m x
guard_catches git -C . branch -D main
guard_catches git worktree remove x
guard_catches git worktree prune
guard_catches git fetch origin
guard_catches git -c user.name=x merge --ff-only x

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

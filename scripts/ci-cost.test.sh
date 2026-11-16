#!/usr/bin/env bash
# Tests for ci-cost.sh through its command line, with `gh` replaced by a fake on PATH. The fake
# logs every call and never reaches GitHub. It serves JSON fixtures from $work/api, one file per
# endpoint and page, through the call's own --jq filter run by jq (gh runs it with gojq; these
# filters use nothing they differ on), and a job's log as raw text.
# Run: bash scripts/ci-cost.test.sh (needs jq)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ci-cost.sh"
pass=0
fail=0

if ! command -v jq >/dev/null; then
  echo "jq is not installed: install it to run these tests" >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/ci-cost-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# --- fake gh ----------------------------------------------------------------------------------
# Each call appends its arguments to $work/calls, one per line, then a "--" line. `gh api` reads
# the endpoint (its first argument that isn't a flag or a flag's value) and the page (-f page=N,
# default 1), and serves $work/api/<endpoint with / as _>@<page>.json through the --jq filter, or
# $work/api/<endpoint with / as _>.log as it is. A missing file is gh's HTTP 404: stderr, exit 1;
# a <endpoint with / as _>.fail file is any other failure: its text on stderr, exit 1.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
for a in "$@"; do printf '%s\n' "$a"; done >>"$dir/calls"
printf -- '--\n' >>"$dir/calls"
[[ $1 == api ]] || { echo "fake: unexpected gh call: $*" >&2; exit 99; }
shift
endpoint="" page=1 filter=""
while (($#)); do
  case $1 in
    -X | -H) shift 2 ;;
    -f | -F) [[ $2 == page=* ]] && page=${2#page=}; shift 2 ;;
    --jq) filter=$2; shift 2 ;;
    -*) echo "fake: unexpected flag $1" >&2; exit 98 ;;
    *) endpoint=$1; shift ;;
  esac
done
key=${endpoint//\//_}
if [[ -f $dir/api/$key.fail ]]; then
  cat "$dir/api/$key.fail" >&2
  exit 1
fi
if [[ -f $dir/api/$key.log ]]; then
  cat "$dir/api/$key.log"
  exit
fi
f=$dir/api/$key@$page.json
[[ -f $f ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
[[ -n $filter ]] || { echo "fake: no --jq filter given" >&2; exit 97; }
jq -r "$filter" "$f"
FAKE
chmod +x "$work/bin/gh"

# --- fixtures ---------------------------------------------------------------------------------
API=repos_sssoto17_sunny-pastures
reset() { rm -rf "$work/calls" "$work/api"; mkdir -p "$work/api"; }
serve() { cat >"$work/api/$1"; } # file name under $work/api, content on stdin

# A run as the list endpoint returns it. prs is a JSON array of PR numbers.
run_json() { # id name path event branch prs created conclusion
  printf '{"id":%s,"name":"%s","path":"%s","event":"%s","head_branch":"%s","pull_requests":%s,"created_at":"%s","status":"completed","conclusion":%s}' \
    "$1" "$2" "$3" "$4" "$5" "$(jq -c '[.[] | {number: .}]' <<<"$6")" "$7" "$8"
}
runs_page() { # page total runs-json...
  local page=$1 total=$2
  shift 2
  local IFS=,
  printf '{"total_count":%s,"workflow_runs":[%s]}' "$total" "$*" >"$work/api/${API}_actions_runs@$page.json"
}
# A job: id name conclusion started completed (null for a job that never started).
job_json() {
  local s=$4 c=$5
  [[ $s == null ]] || s="\"$s\""
  [[ $c == null ]] || c="\"$c\""
  printf '{"id":%s,"name":"%s","status":"completed","conclusion":"%s","started_at":%s,"completed_at":%s}' "$1" "$2" "$3" "$s" "$c"
}
jobs_of() { # run-id jobs-json...
  local id=$1
  shift
  local IFS=,
  printf '{"total_count":%s,"jobs":[%s]}' "$#" "$*" >"$work/api/${API}_actions_runs_${id}_jobs@1.json"
}
log_of() { # job-id, log text on stdin
  cat >"$work/api/${API}_actions_jobs_$1_logs.log"
}
pulls() { # page pulls-json (a JSON array of {number, head:{ref}, created_at})
  printf '%s' "$2" >"$work/api/${API}_pulls@$1.json"
}

run() { # args... -> sets code, out, err, calls
  out=$(PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls:\n%s\n' \
    "$1" "${args[*]-}" "$code" "$out" "$err" "    ${calls//$'\n'/$'\n'    }"
}
assert() { # message command... -> ok if the command succeeds
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
expect_out_lacks() { assert "expected stdout not to contain: $1" lacks "$out" "$1"; }
expect_out_empty() { assert "expected no stdout" test -z "$out"; }
expect_no_gh() { assert "expected no gh calls at all" test -z "$calls"; }
# The gh calls joined into one line each: "api -X GET repos/... -f per_page=100 ...".
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
# grep -q stops reading at the first match, so it reads a variable, not a pipe: with pipefail, the
# writer's SIGPIPE would fail the check.
has_call() { local lines; lines=$(call_lines); grep -qF -- "$1" <<<"$lines"; }
expect_call() { # substring of one joined call line
  if has_call "$1"; then ok; else bad "expected a gh call containing: $1"; fi
}
expect_no_call() { # substring no call line may contain
  if has_call "$1"; then bad "expected no gh call containing: $1"; else ok; fi
}
case_() { args=("$@"); run "$@"; }
T=$'\t'

# --- usage ------------------------------------------------------------------------------------
for flag in --help -h; do
  reset
  case_ "$flag"
  expect_code 0
  expect_err "usage:"
  expect_no_gh
done

for bad_args in "" "--from 2026-11-08" "--to 2026-11-15" "--from 8-11-2026 --to 2026-11-15" \
  "--from 2026-11-16 --to 2026-11-15" "--from 2026-11-08 --to 2026-11-15 --pr x" \
  "--from 2026-11-08 --to 2026-11-15 --pr" "--from 2026-11-08 --to 2026-11-15 extra" \
  "--from 2026-11-08 --to 2026-11-15 --colour"; do
  reset
  read -ra words <<<"$bad_args"
  case_ "${words[@]}"
  expect_code 2
  expect_err "usage:"
  expect_no_gh
  expect_out_empty
done

CI=.github/workflows/ci.yml
REV=.github/workflows/review.yml
RANGE=(--from 2026-11-08 --to 2026-11-15)

# --- minutes: per job, rounded up to a whole minute; a job that never started counts 0 ----------
reset
runs_page 1 2 \
  "$(run_json 11 ci "$CI" pull_request a '[94]' 2026-11-08T10:00:00Z '"success"')" \
  "$(run_json 12 ci "$CI" pull_request b '[95]' 2026-11-08T11:00:00Z '"failure"')"
jobs_of 11 \
  "$(job_json 101 'ci / test' success 2026-11-08T10:00:00Z 2026-11-08T10:01:01Z)" \
  "$(job_json 102 'ci / lint' success 2026-11-08T10:00:00Z 2026-11-08T10:00:01Z)" \
  "$(job_json 103 'ci / skipped' skipped null null)"
jobs_of 12 "$(job_json 104 'ci / test' failure 2026-11-08T11:00:00Z 2026-11-08T11:05:00Z)"
case_ "${RANGE[@]}"
expect_code 0
expect_out "#94${T}1${T}3${T}3${T}0${T}-"
expect_out "#95${T}1${T}1${T}5${T}0${T}-"
expect_out "ci${T}2${T}4${T}8"
expect_out "prs${T}2"
expect_out "minutes${T}8"
expect_out "minutes_per_pr${T}4.0"
expect_out "unattributed_minutes${T}0"
expect_call "api -X GET repos/sssoto17/sunny-pastures/actions/runs -f created=2026-11-08..2026-11-15 -f per_page=100 -f page=1 --jq"
expect_call "api -X GET repos/sssoto17/sunny-pastures/actions/runs/11/jobs -f filter=all -f per_page=100 -f page=1 --jq"
# Every PR here is linked on its run, so the PR list isn't read.
expect_no_call "/pulls"
# Read-only: every call is a GET.
assert "expected every gh api call to be a GET or a log read" \
  test -z "$(call_lines | grep -v -e '^api -X GET ' -e '/logs$')"

# --- a run without pull_requests[] goes to the latest PR on its branch opened before it ---------
reset
runs_page 1 3 \
  "$(run_json 21 review "$REV" pull_request_target reused '[]' 2026-11-12T10:00:00Z '"skipped"')" \
  "$(run_json 22 ci "$CI" pull_request reused '[]' 2026-11-14T10:00:00Z '"success"')" \
  "$(run_json 23 'pip update' dynamic-updates dynamic main '[]' 2026-11-14T11:00:00Z '"success"')"
pulls 1 '[{"number":200,"head":{"ref":"reused"},"created_at":"2026-11-11T09:00:00Z"},
  {"number":230,"head":{"ref":"reused"},"created_at":"2026-11-13T09:00:00Z"},
  {"number":260,"head":{"ref":"reused"},"created_at":"2026-11-15T09:00:00Z"},
  {"number":201,"head":{"ref":"other"},"created_at":"2026-11-10T09:00:00Z"}]'
jobs_of 21
jobs_of 22 "$(job_json 221 'ci / test' success 2026-11-14T10:00:00Z 2026-11-14T10:02:00Z)"
jobs_of 23 "$(job_json 231 'update' success 2026-11-14T11:00:00Z 2026-11-14T11:00:30Z)"
case_ "${RANGE[@]}"
expect_code 0
expect_out "#200${T}1${T}0${T}0"
expect_out "#230${T}1${T}1${T}2"
expect_out "-${T}1${T}1${T}1"
expect_out_lacks "#260"
expect_out "prs${T}2"
expect_out "unattributed_minutes${T}1"
expect_out "minutes_per_pr${T}1.0"
expect_out "pip update${T}1${T}1${T}1"
expect_call "api -X GET repos/sssoto17/sunny-pastures/pulls -f state=all -f per_page=100 -f page=1 --jq"

# --- the reviewer's cost from the review job's log ------------------------------------------------
ESC=$'\x1b'
reset
runs_page 1 3 \
  "$(run_json 31 review "$REV" pull_request_target a '[94]' 2026-11-12T10:00:00Z '"success"')" \
  "$(run_json 32 review "$REV" pull_request_target a '[94]' 2026-11-12T11:00:00Z '"success"')" \
  "$(run_json 33 review "$REV" pull_request_target b '[95]' 2026-11-12T12:00:00Z '"failure"')"
jobs_of 31 "$(job_json 311 review success 2026-11-12T10:00:00Z 2026-11-12T10:00:50Z)"
jobs_of 32 "$(job_json 321 review success 2026-11-12T11:00:00Z 2026-11-12T11:01:10Z)"
jobs_of 33 "$(job_json 331 review failure 2026-11-12T12:00:00Z 2026-11-12T12:00:20Z)"
log_of 311 <<EOF
2026-11-12T10:00:40.1Z ${ESC}[36;1mjq -r '.[] | "RESULT subtype=\(.subtype) total_cost_usd=\(.total_cost_usd)"'${ESC}[0m
2026-11-12T10:00:40.2Z some-token-like-text ghs_notARealTokenButLongEnough123
2026-11-12T10:00:40.3Z RESULT job_seconds=40
2026-11-12T10:00:40.4Z RESULT subtype=success is_error=false num_turns=15 total_cost_usd=0.1431323 duration_ms=14553
EOF
log_of 321 <<'EOF'
2026-11-12T11:01:00.0Z RESULT subtype=success is_error=false num_turns=9 total_cost_usd=0.25 duration_ms=900
EOF
# Claude never ran: no result line, so the run costs 0.
log_of 331 <<'EOF'
2026-11-12T12:00:10.0Z RESULT execution_file=missing
EOF
case_ "${RANGE[@]}"
expect_code 0
expect_out "#94${T}2${T}2${T}3${T}2${T}0.39"
expect_out "#95${T}1${T}1${T}1${T}1${T}0.00"
expect_out "review${T}3${T}3${T}4"
expect_out "reviews${T}3"
expect_out "claude_usd${T}0.39"
expect_out "claude_usd_per_reviewed_pr${T}0.20"
expect_out_lacks "ghs_"
assert "expected no secret-like text on stderr" lacks "$err" "ghs_"
expect_call "api repos/sssoto17/sunny-pastures/actions/jobs/311/logs"

# --- a log that can't be read: the cost is "?", the command goes to stderr, exit 4 ---------------
rm "$work/api/${API}_actions_jobs_321_logs.log"
case_ "${RANGE[@]}"
expect_code 4
expect_out "#94${T}2${T}2${T}3${T}2${T}?"
expect_out "claude_usd${T}?"
expect_out "minutes${T}4"
expect_err "1 review log(s) could not be read"
expect_err "gh api repos/sssoto17/sunny-pastures/actions/jobs/321/logs | grep 'RESULT subtype='"

# --- a cancelled review job with no log: Claude was stopped, so it counts 0, reported apart ------
reset
runs_page 1 1 "$(run_json 81 review "$REV" pull_request_target a '[94]' 2026-11-16T02:51:00Z '"cancelled"')"
jobs_of 81 "$(job_json 811 review cancelled 2026-11-16T02:51:05Z 2026-11-16T02:51:06Z)"
case_ "${RANGE[@]}"
expect_code 0
expect_out "#94${T}1${T}1${T}1${T}1${T}0.00"
expect_out "claude_usd${T}0.00"
expect_out "cancelled_reviews_without_log${T}1"

# Any other failure on a cancelled job's log is still an unread cost.
echo "gh: Bad Gateway (HTTP 502)" >"$work/api/${API}_actions_jobs_811_logs.fail"
case_ "${RANGE[@]}"
expect_code 4
expect_out "#94${T}1${T}1${T}1${T}1${T}?"
expect_out "cancelled_reviews_without_log${T}0"
assert "expected gh's error text kept off stderr" lacks "$err" "Bad Gateway"

# --- --pr keeps only those PRs' runs and reads no other run's jobs ------------------------------
reset
runs_page 1 2 \
  "$(run_json 41 ci "$CI" pull_request a '[94]' 2026-11-08T10:00:00Z '"success"')" \
  "$(run_json 42 ci "$CI" pull_request b '[95]' 2026-11-08T11:00:00Z '"success"')"
jobs_of 41 "$(job_json 411 'ci / test' success 2026-11-08T10:00:00Z 2026-11-08T10:03:00Z)"
jobs_of 42 "$(job_json 421 'ci / test' success 2026-11-08T11:00:00Z 2026-11-08T11:07:00Z)"
case_ "${RANGE[@]}" --pr 95 --pr '#97'
expect_code 0
expect_out "#95${T}1${T}1${T}7"
expect_out_lacks "#94"
expect_out "prs${T}1"
expect_no_call "runs/41/jobs"

# --- paging: a second page is read while the first is full ---------------------------------------
reset
page1=()
for i in $(seq 1 100); do
  page1+=("$(run_json $((1000 + i)) ci "$CI" pull_request a '[94]' 2026-11-08T10:00:00Z '"success"')")
  jobs_of $((1000 + i))
done
runs_page 1 101 "${page1[@]}"
runs_page 2 101 "$(run_json 2001 ci "$CI" pull_request a '[94]' 2026-11-08T10:00:00Z '"success"')"
jobs_of 2001 "$(job_json 9 'ci / test' success 2026-11-08T10:00:00Z 2026-11-08T10:00:10Z)"
case_ "${RANGE[@]}"
expect_code 0
expect_out "#94${T}101${T}1${T}1"
expect_call "-f page=2 --jq"

# --- failures never read as a result ------------------------------------------------------------
reset
case_ "${RANGE[@]}"
expect_code 3
expect_out_empty
expect_err "could not read the workflow runs"

reset
runs_page 1 1001 "$(run_json 51 ci "$CI" pull_request a '[94]' 2026-11-08T10:00:00Z '"success"')"
case_ "${RANGE[@]}"
expect_code 3
expect_out_empty
expect_err "use a shorter range"

reset
runs_page 1 2 \
  "$(run_json 61 ci "$CI" pull_request a '[94]' 2026-11-08T10:00:00Z '"success"')" \
  "$(run_json 62 ci "$CI" pull_request a '[94]' 2026-11-08T10:00:00Z '"success"')"
jobs_of 61
case_ "${RANGE[@]}"
expect_code 3
expect_out_empty
expect_err "could not read the jobs of run 62"

reset
runs_page 1 1 "$(run_json 71 ci "$CI" pull_request gone '[]' 2026-11-08T10:00:00Z '"success"')"
case_ "${RANGE[@]}"
expect_code 3
expect_out_empty
expect_err "could not read the pull requests"

reset
printf '{"message":"rate limited"}' >"$work/api/${API}_actions_runs@1.json"
case_ "${RANGE[@]}"
expect_code 3
expect_out_empty

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

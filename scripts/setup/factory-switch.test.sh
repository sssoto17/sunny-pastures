#!/usr/bin/env bash
# Tests for factory-switch.sh through its command line. The wizard reads its answers from stdin
# (no terminal, so no screen clearing). `gh` is a fake on PATH: it logs its arguments to
# $work/calls and keeps FACTORY_ENABLED in $work/var (no file: a 404; $work/var-broken: a 500).
# $work/runs holds the newest dispatch's id; each listed run is "completed" unless $work/stuck
# exists, and $work/lag keeps a new dispatch out of the first list after it. A run's log holds the
# SWITCH line the real script would write for the value it saw (or "SWITCH on" with
# $work/switch-on; $work/log-broken fails the call), and its jobs are the switch job as success
# ($work/switch-job overrides) and the stand-in as skipped ($work/stand-in overrides,
# $work/no-stand-in leaves it out). The wizard's --jq filters run over JSON shaped like GitHub's.
# $work/no-workflow makes the workflow file missing on main. Browser openers are no-ops.
# Run: bash scripts/setup/factory-switch.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/factory-switch.sh"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/factory-switch-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
for b in xdg-open wslview explorer.exe open; do printf '#!/bin/sh\nexit 0\n' >"$work/bin/$b"; done

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
d=$(dirname "$0")/..
printf '%s\n' "$*" >>"$d/calls"
R=sssoto17/sunny-pastures
W=check-106-factory-switch.yml
case "$*" in
  "auth status") [[ -f $d/signed-out ]] && exit 1; exit 0 ;;
  "api repos/$R/contents/.github/workflows/$W?ref=main --silent")
    [[ -f $d/no-workflow ]] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; exit 0 ;;
  "api repos/$R/actions/variables/FACTORY_ENABLED --jq "*)
    [[ -f $d/var-broken ]] && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    [[ -f $d/var ]] || { echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    jq -n --arg v "$(cat "$d/var")" '{name: "FACTORY_ENABLED", value: $v}' | jq -r "${*: -1}"; exit 0 ;;
  "variable set FACTORY_ENABLED --repo $R --body "*) echo "${*: -1}" >"$d/var"; exit 0 ;;
  "workflow run $W --repo $R --ref main")
    n=$(( $(cat "$d/runs" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$d/runs"
    [[ -f $d/lag ]] && touch "$d/lagging" # the next list still shows only the older run
    # The value the run sees, as the switch would log it.
    if [[ -f $d/var ]]; then v=$(printf '%q' "$(cat "$d/var")"); else v="''"; fi
    echo "$v" >"$d/seen-$n"; exit 0 ;;
  # The wizard's own --jq filter runs over JSON shaped like GitHub's, so a broken filter fails here.
  "run list --repo $R --workflow $W --event workflow_dispatch --limit 1 --json databaseId,status,url --jq "*)
    n=$(cat "$d/runs" 2>/dev/null || echo 0)
    [[ -f $d/lagging ]] && { rm -f "$d/lagging"; n=$((n - 1)); }
    status=completed; [[ -f $d/stuck ]] && status=in_progress
    if ((n == 0)); then echo '[]'; else
      jq -n --argjson n "$n" --arg s "$status" --arg r "$R" \
        '[{databaseId: $n, status: $s, url: "https://github.com/\($r)/actions/runs/\($n)"}]'
    fi | jq -r "${*: -1}"; exit 0 ;;
  "run view "*" --repo $R --json jobs --jq "*)
    jq -n --arg sw "$(cat "$d/switch-job" 2>/dev/null || echo success)" \
      --arg si "$(cat "$d/stand-in" 2>/dev/null || echo skipped)" --arg none "$([[ -f $d/no-stand-in ]] && echo 1)" \
      '{jobs: ([{name: "switch / switch", conclusion: $sw}] + (if $none == "1" then [] else [{name: "stand-in", conclusion: $si}] end))}' |
      jq -r "${*: -1}"; exit 0 ;;
  "run view "*" --repo $R --log")
    [[ -f $d/log-broken ]] && { echo "gh: failed to get run log" >&2; exit 1; }
    n=$3
    if [[ -f $d/switch-on ]]; then
      printf 'switch / switch\tRun bash\t2026-11-20T10:00:00.0000000Z SWITCH on: FACTORY_ENABLED is true (workflow: check-106-factory-switch)\n'
    else
      printf 'switch / switch\tRun bash\t2026-11-20T10:00:00.0000000Z SWITCH off: FACTORY_ENABLED is %s, not true: factory stops before a token or Claude (workflow: check-106-factory-switch)\n' "$(cat "$d/seen-$n")"
    fi
    exit 0 ;;
esac
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"

reset() {
  rm -f "$work"/calls "$work"/var "$work"/runs "$work"/seen-* "$work"/signed-out "$work"/no-workflow \
    "$work"/stuck "$work"/switch-on "$work"/stand-in "$work"/no-stand-in "$work"/var-broken \
    "$work"/lag "$work"/lagging "$work"/switch-job "$work"/log-broken
  rm -rf "$work/.scratch"
}
run() { # stdin-text args... -> code, out, err, calls
  out=$(cd "$work" && printf '%s' "$1" | PATH="$work/bin:$PATH" FACTORY_SWITCH_POLL_SECONDS=0 \
    FACTORY_SWITCH_POLL_TRIES=3 bash "$script" "${@:2}" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}
# Answers, variable unset: start, gh ok; dispatch? y, Enter; set false? y, Enter; dispatch? y,
# Enter; results Enter.
UNSET=$'\n\ny\n\ny\n\ny\n\n\n'
# Variable already false: start, gh ok; (no unset run) Enter; (already false) Enter; dispatch? y,
# Enter; results Enter.
ALREADY_FALSE=$'\n\n\n\ny\n\n\n'

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' "$1" "$code" "$out" "$err" "$calls"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
count() { grep -c -- "$2" <<<"$1"; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
results() { cat "$work/.scratch/106-results.md" 2>/dev/null; }

# --help
reset
run "" --help
expect_code 0
assert "exit codes in --help" contains "$err" "Exit codes:"
run "" extra
expect_code 2

# Variable unset: one run unset, then set false, then one run false; both pass.
reset
run "$UNSET"
expect_code 0
assert "two dispatches" test "$(count "$calls" "^workflow run ")" -eq 2
assert "dispatched on main" contains "$calls" "workflow run check-106-factory-switch.yml --repo sssoto17/sunny-pastures --ref main"
assert "set to false" contains "$calls" "variable set FACTORY_ENABLED --repo sssoto17/sunny-pastures --body false"
assert "reads false at the end" test "$(cat "$work/var")" = false
assert "first run saw it unset" contains "$(results)" "SWITCH off: FACTORY_ENABLED is '', not true"
assert "second run saw false" contains "$(results)" "SWITCH off: FACTORY_ENABLED is false, not true"
assert "results name the stand-in skipped" contains "$(results)" "| stand-in | skipped |"
assert "results carry the run links" contains "$(results)" "https://github.com/sssoto17/sunny-pastures/actions/runs/2"
assert "says how to flip it in the UI" contains "$out" "Settings → Secrets and variables → Actions"
assert "says how to post the results" contains "$out" "gh issue comment 106"

# Variable already false: no unset run, no write, one run.
reset
echo false >"$work/var"
run "$ALREADY_FALSE"
expect_code 0
assert "one dispatch" test "$(count "$calls" "^workflow run ")" -eq 1
assert "no write" lacks "$calls" "variable set"
assert "results hold the false run only" lacks "$(results)" "FACTORY_ENABLED unset"

# Variable true: the wizard asks before turning it off; declining changes nothing.
reset
echo true >"$work/var"
run $'\n\n\nn\n'
expect_code 2
assert "no write after declining" lacks "$calls" "variable set"
assert "no dispatch after declining" lacks "$calls" "workflow run"
assert "still true" test "$(cat "$work/var")" = true

# A stand-in that ran fails the check.
reset
echo success >"$work/stand-in"
run "$UNSET"
expect_code 1
assert "names the stand-in" contains "$err" "the stand-in ran (success)"

# A stand-in that never started (not listed at all) passes.
reset
touch "$work/no-stand-in"
run "$UNSET"
expect_code 0
assert "results say never started" contains "$(results)" "| stand-in | (never started) |"

# A run whose switch logged on fails.
reset
touch "$work/switch-on"
run "$UNSET"
expect_code 1
assert "names the SWITCH line" contains "$err" "didn't log SWITCH off"

# A run that doesn't finish in time.
reset
touch "$work/stuck"
run "$UNSET"
expect_code 3
assert "links the run" contains "$err" "actions/runs/1"

# An older dispatch exists and the new one lists late: the wizard waits for the new id.
reset
echo 7 >"$work/runs"
touch "$work/lag"
run "$UNSET"
expect_code 0
assert "checks the new run, not the older one" contains "$(results)" "actions/runs/8"
assert "never reports the older run" lacks "$(results)" "actions/runs/7"

# Reading the variable fails with something other than a 404: stop, never call it unset.
reset
touch "$work/var-broken"
run "$UNSET"
expect_code 1
assert "names the read" contains "$err" "reading FACTORY_ENABLED failed"
assert "no dispatch on a failed read" lacks "$calls" "workflow run"

# A switch job that failed, or a log that can't be read, fails with its own message.
reset
echo failure >"$work/switch-job"
run "$UNSET"
expect_code 1
assert "names the switch job" contains "$err" "the switch job didn't succeed (failure)"
reset
touch "$work/log-broken"
run "$UNSET"
expect_code 1
assert "names the log" contains "$err" "--log failed"

# gh signed out, or the workflow not on main yet: nothing dispatched or set.
reset
touch "$work/signed-out"
run "$UNSET"
expect_code 2
assert "sign-in hint" contains "$err" "gh auth login"
reset
touch "$work/no-workflow"
run "$UNSET"
expect_code 2
assert "merge first" contains "$err" "merge #106's PR first"
assert "no dispatch before merge" lacks "$calls" "workflow run"
assert "no write before merge" lacks "$calls" "variable set"

printf 'factory-switch.test.sh: %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

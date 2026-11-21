#!/usr/bin/env bash
# Tests for factory-switch.sh through its command line. The wizard reads its answers from stdin
# (no terminal, so no screen clearing). `gh` is a fake on PATH: it logs its arguments to
# $work/calls and keeps FACTORY_ENABLED in $work/var (no file: a 404; $work/var-broken: a 500;
# $work/set-broken fails the write). The wizard's --jq filter runs over JSON shaped like GitHub's.
# Browser openers are no-ops.
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
case "$*" in
  "auth status") [[ -f $d/signed-out ]] && exit 1; exit 0 ;;
  "api repos/$R/actions/variables/FACTORY_ENABLED --jq "*)
    [[ -f $d/var-broken ]] && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    [[ -f $d/var ]] || { echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    jq -n --arg v "$(cat "$d/var")" '{name: "FACTORY_ENABLED", value: $v}' | jq -r "${*: -1}"; exit 0 ;;
  "variable set FACTORY_ENABLED --repo $R --body "*)
    [[ -f $d/set-broken ]] && { echo "gh: Forbidden (HTTP 403)" >&2; exit 1; }
    echo "${*: -1}" >"$d/var"; exit 0 ;;
esac
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"

reset() {
  rm -f "$work"/calls "$work"/var "$work"/signed-out "$work"/var-broken "$work"/set-broken
}
run() { # stdin-text args... -> code, out, err, calls
  out=$(cd "$work" && printf '%s' "$1" | PATH="$work/bin:$PATH" bash "$script" "${@:2}" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}
# Answers: start, gh ok Enter; set false? y, Enter.
SET=$'\n\ny\n\n'
# Variable already false: start, gh ok Enter; (already false) Enter.
ALREADY_FALSE=$'\n\n\n'

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' "$1" "$code" "$out" "$err" "$calls"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }

# --help
reset
run "" --help
expect_code 0
assert "exit codes in --help" contains "$err" "Exit codes:"
run "" extra
expect_code 2

# Variable unset: set to false after asking, and read back.
reset
run "$SET"
expect_code 0
assert "says it was unset" contains "$out" "FACTORY_ENABLED now: (unset)"
assert "set to false" contains "$calls" "variable set FACTORY_ENABLED --repo sssoto17/sunny-pastures --body false"
assert "reads false at the end" test "$(cat "$work/var")" = false
assert "says how to flip it in the UI" contains "$out" "Settings → Secrets and variables → Actions"
assert "dispatches nothing" lacks "$calls" "workflow run"
assert "writes no results file" test ! -e "$work/.scratch"

# Variable already false: no write.
reset
echo false >"$work/var"
run "$ALREADY_FALSE"
expect_code 0
assert "no write" lacks "$calls" "variable set"
assert "says it is false already" contains "$out" "FACTORY_ENABLED is false already"

# Variable true: the wizard asks before turning it off; declining changes nothing, yes turns it off.
reset
echo true >"$work/var"
run $'\n\nn\n'
expect_code 2
assert "no write after declining" lacks "$calls" "variable set"
assert "still true" test "$(cat "$work/var")" = true
reset
echo true >"$work/var"
run "$SET"
expect_code 0
assert "true turned to false" test "$(cat "$work/var")" = false

# Reading the variable fails with something other than a 404: stop, never call it unset.
reset
touch "$work/var-broken"
run "$SET"
expect_code 1
assert "names the read" contains "$err" "reading FACTORY_ENABLED failed"
assert "no write on a failed read" lacks "$calls" "variable set"

# The write fails: stop with its own message.
reset
touch "$work/set-broken"
run "$SET"
expect_code 1
assert "names the write" contains "$err" "gh variable set FACTORY_ENABLED failed"

# gh signed out: nothing read or set.
reset
touch "$work/signed-out"
run "$SET"
expect_code 2
assert "sign-in hint" contains "$err" "gh auth login"
assert "no write when signed out" lacks "$calls" "variable set"

printf 'factory-switch.test.sh: %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

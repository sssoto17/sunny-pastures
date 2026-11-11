#!/usr/bin/env bash
# Tests for ci-claude.sh through its command line. The wizard reads its answers from stdin (no
# terminal). `gh` is a fake on PATH: it logs its arguments to $work/calls, saves what
# `gh secret set` reads on stdin to $work/stdin.<NAME>.<env>, and answers the Actions
# permission reads from $work/mode and $work/patterns. Each test pastes a token holding a unique
# marker and checks it reaches `gh secret set` on stdin, with --env, and never appears in the
# output or in any gh argument.
# Run: bash scripts/setup/ci-claude.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ci-claude.sh"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-claude-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
CLAUDE=anthropics/claude-code-action@c0949c50a78c1ec8ce2647db36629b870e715d0c
BUN=oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
case "$*" in
  "auth status") exit 0 ;;
  "secret set "*)
    cat >"$dir/stdin.$3.$5"; echo "✓ Set Actions secret $3"; exit 0 ;;
  "secret list "*) echo CLAUDE_CODE_OAUTH_TOKEN ;;
  "api repos/sssoto17/sunny-pastures/environments/"*)
    [[ -f $dir/no-env ]] && exit 1; exit 0 ;;
  *"actions/permissions --jq .allowed_actions") cat "$dir/mode" ;;
  *"selected-actions --jq .github_owned_allowed") echo true ;;
  *"selected-actions --jq .verified_allowed") echo false ;;
  *"selected-actions --jq .patterns_allowed // [] | .[]")
    [[ -f $dir/fail-patterns ]] && exit 1; cat "$dir/patterns" ;;
  "api -X PUT "*) exit 0 ;;
  *) echo "fake: unexpected gh call: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$work/bin/gh"

reset() {
  rm -f "$work"/calls "$work"/stdin.* "$work"/no-env "$work"/fail-patterns
  echo selected >"$work/mode"
  echo 'supabase/setup-cli@*' >"$work/patterns"
  token="sk-ant-oat01-FAKE$RANDOM$RANDOM"
}
run() { # stdin-text args... -> sets code, out, err, calls
  out=$(cd "$work" && printf '%s' "$1" | PATH="$work/bin:$PATH" bash "$script" "${@:2}" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}
# banner, check, setup-token, the token + Enter, write? (y/n) + Enter, check
answers() { printf '\n\n\n%s\n\n%s\n\n\n' "$1" "${2:-y}"; }

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' \
    "$1" "$code" "$out" "$err" "$calls"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_hidden() { # marker: in neither output nor any gh argument
  assert "token in stdout" lacks "$out" "$1"
  assert "token in stderr" lacks "$err" "$1"
  assert "token in a gh argument" lacks "$calls" "$1"
}

# --- usage ------------------------------------------------------------------------------------
reset
run "" --help
expect_code 0
assert "expected usage on --help" contains "$err" "usage:"
assert "expected exit codes in --help" contains "$err" "Exit codes:"
run "" extra
expect_code 2

# --- the happy path ---------------------------------------------------------------------------
reset
run "$(answers "$token")"
expect_code 0
for env in factory review; do
  assert "expected the token set in env $env" \
    contains "$calls" "secret set CLAUDE_CODE_OAUTH_TOKEN --env $env --repo sssoto17/sunny-pastures"
  assert "expected the token on stdin for $env, exactly" \
    test "$(cat "$work/stdin.CLAUDE_CODE_OAUTH_TOKEN.$env" 2>/dev/null)" == "$token"
done
expect_hidden "$token"
put=$(grep '^api -X PUT' <<<"$calls")
assert "expected one write of the selected actions" test "$(grep -c . <<<"$put")" -eq 1
assert "expected the existing pattern kept" contains "$put" "patterns_allowed[]=supabase/setup-cli@*"
assert "expected the pinned claude-code-action" contains "$put" "patterns_allowed[]=$CLAUDE"
assert "expected the setup-bun it uses" contains "$put" "patterns_allowed[]=$BUN"
assert "expected GitHub-owned kept" contains "$put" "github_owned_allowed=true"
assert "expected verified kept" contains "$put" "verified_allowed=false"

# --- re-run: a pattern already there isn't added twice ----------------------------------------
reset
printf '%s\n%s\n' "$CLAUDE" "$BUN" >"$work/patterns"
run "$(answers "$token")"
expect_code 0
put=$(grep '^api -X PUT' <<<"$calls")
assert "expected the pattern once" test "$(grep -o "$CLAUDE" <<<"$put" | grep -c .)" -eq 1

# --- the admin declines the allowed-actions write ---------------------------------------------
reset
run "$(answers "$token" n)"
expect_code 0
assert "expected no write" lacks "$calls" "api -X PUT"
assert "expected it listed as still to do" contains "$out" "Allowed actions: add"

# --- the pattern read fails: stop, never write a list without the existing patterns -------------
reset
touch "$work/fail-patterns"
run "$(answers "$token")"
expect_code 1
assert "expected no write" lacks "$calls" "api -X PUT"
expect_hidden "$token"

# --- an API key pasted by mistake: refused, nothing stored, never shown -----------------------
reset
key="sk-ant-api03-FAKE$RANDOM$RANDOM"
run "$(answers "$key")"
expect_code 2
assert "expected the refusal" contains "$err" "that is an API key"
assert "expected no secret set" lacks "$calls" "secret set"
expect_hidden "$key"

# --- nothing pasted: refused --------------------------------------------------------------------
reset
run "$(answers "")"
expect_code 2
assert "expected no secret set" lacks "$calls" "secret set"

# --- no environments yet: refused before the token is asked for -------------------------------
reset
touch "$work/no-env"
run "$(answers "$token")"
expect_code 2
assert "expected a pointer to ci-apps.sh" contains "$err" "ci-apps.sh"
assert "expected no secret set" lacks "$calls" "secret set"

# --- allowed actions not "selected": refused before writing it --------------------------------
reset
echo local_only >"$work/mode"
run "$(answers "$token")"
expect_code 2
assert "expected checklist step 8 named" contains "$err" "checklist step 8"
assert "expected no write" lacks "$calls" "api -X PUT"
expect_hidden "$token"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

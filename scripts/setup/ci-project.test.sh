#!/usr/bin/env bash
# Tests for ci-project.sh through its command line. The wizard reads its answers from stdin (no
# terminal). `gh` is a fake on PATH: it logs its arguments to $work/calls, saves what
# `gh secret set` reads on stdin to $work/stdin.<NAME>.<env>, logs whether GH_TOKEN was set for
# each call, and answers `api -i user` with the scopes in $work/scopes. Each test pastes a token
# holding a unique marker and checks it reaches `gh secret set` on stdin, with --env, and never
# appears in the output or in any gh argument.
# Run: bash scripts/setup/ci-project.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ci-project.sh"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-project-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
case "$*" in
  "auth status") exit 0 ;;
  "api -i user")
    [[ -n ${GH_TOKEN-} ]] && echo "token passed in env" >>"$dir/env"
    printf 'HTTP/2.0 200 OK\r\nX-Oauth-Scopes: %s\r\n\r\n{"login":"x"}\n' "$(cat "$dir/scopes")" ;;
  "api -X PUT repos/sssoto17/sunny-pastures/environments/sweep --silent") exit 0 ;;
  "secret set "*) cat >"$dir/stdin.$3.$5"; exit 0 ;;
  "secret list "*) echo PROJECT_READ_TOKEN ;;
  *) echo "fake: unexpected gh call: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$work/bin/gh"

reset() {
  rm -f "$work"/calls "$work"/stdin.* "$work"/env
  echo read:project >"$work/scopes"
  classic="ghp_FAKE$RANDOM$RANDOM"
  fine="github_pat_FAKE$RANDOM$RANDOM"
}
run() { # stdin-text args... -> sets code, out, err, calls
  out=$(cd "$work" && printf '%s' "$1" | PATH="$work/bin:$PATH" bash "$script" "${@:2}" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}
answers() { printf '\n\n\n%s\n\n\n' "$1"; } # banner, check, create, token, Enter, check

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
expect_stored() { # token
  assert "expected the token set in env sweep" \
    contains "$calls" "secret set PROJECT_READ_TOKEN --env sweep --repo sssoto17/sunny-pastures"
  assert "expected the token on stdin, exactly" \
    test "$(cat "$work/stdin.PROJECT_READ_TOKEN.sweep" 2>/dev/null)" == "$1"
}

# --- usage ------------------------------------------------------------------------------------
reset
run "" --help
expect_code 0
assert "expected exit codes in --help" contains "$err" "Exit codes:"
run "" --classic
expect_code 2

# --- a classic token with only read:project: stored ---------------------------------------------
reset
run "$(answers "$classic")"
expect_code 0
expect_stored "$classic"
expect_hidden "$classic"
assert "expected the scope check to get the token through env" test -s "$work/env"
assert "expected the sweep environment created" contains "$calls" "environments/sweep --silent"
assert "expected the repo warning" contains "$out" "Never tick repo"

# --- a classic token with repo (or anything more): refused, nothing stored ----------------------
for scopes in "read:project, repo" "repo" "project" ""; do
  reset
  echo "$scopes" >"$work/scopes"
  run "$(answers "$classic")"
  expect_code 2
  assert "expected no secret set for scopes '$scopes'" lacks "$calls" "secret set"
  assert "expected the refusal for scopes '$scopes'" contains "$err" "not only read:project"
  expect_hidden "$classic"
done

# --- the wrong kind for the mode: refused -------------------------------------------------------
reset
run "$(answers "$fine")"
expect_code 2
assert "expected no secret set" lacks "$calls" "secret set"
expect_hidden "$fine"
run "$(answers "$classic")" --fine-grained
expect_code 2
assert "expected no secret set" lacks "$calls" "secret set"
expect_hidden "$classic"

# --- the fine-grained fallback: stored without a scope check (it has no scopes header) ---------
reset
run "$(answers "$fine")" --fine-grained
expect_code 0
expect_stored "$fine"
expect_hidden "$fine"
assert "expected the one-repo instruction" contains "$out" "Only select repositories"
assert "expected the documented gap named" contains "$out" "gap of fine-grained tokens"

# --- nothing pasted: refused --------------------------------------------------------------------
reset
run "$(answers "")"
expect_code 2
assert "expected no secret set" lacks "$calls" "secret set"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

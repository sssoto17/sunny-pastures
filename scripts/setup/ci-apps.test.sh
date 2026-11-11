#!/usr/bin/env bash
# Tests for ci-apps.sh through its command line. The wizard reads its answers from stdin (no
# terminal, so no screen clearing). `gh` is a fake on PATH: it logs its arguments to $work/calls
# and saves what `gh secret set` reads on stdin to $work/stdin.<NAME>.<env>. Each test plants
# fake .pem keys holding a unique marker and checks the marker reaches `gh secret set` on stdin,
# with --env, and never appears in the wizard's output or in any gh argument. Environments live
# in $work/env.<name> (its policy, "false true" when custom) and $work/policies.<name>.
# Run: bash scripts/setup/ci-apps.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ci-apps.sh"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-apps-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/keys"

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
envof() { local e=${1#repos/sssoto17/sunny-pastures/environments/}; echo "${e%%/*}"; }
case "$*" in
  "api repos/sssoto17/sunny-pastures/environments/"*"/deployment-branch-policies --jq "*)
    cat "$dir/policies.$(envof "$2")" 2>/dev/null; exit 0 ;;
  "api repos/sssoto17/sunny-pastures/environments/"*" --jq "*)
    [[ -f $dir/env.$(envof "$2") ]] || { echo "fake: HTTP 404" >&2; exit 1; }
    cat "$dir/env.$(envof "$2")"; exit 0 ;;
  "api -X PUT repos/sssoto17/sunny-pastures/environments/"*)
    [[ $* == *"protected_branches]=false"*"custom_branch_policies]=true"* ]] &&
      echo "false true" >"$dir/env.$(envof "$4")"; exit 0 ;;
  "api -X POST repos/sssoto17/sunny-pastures/environments/"*"/deployment-branch-policies --silent -f name="*" -f type=branch")
    n=${7#name=}; echo "$n" >>"$dir/policies.$(envof "$4")"; exit 0 ;;
esac
case "$1 $2" in
  "auth status") [[ -f $dir/signed-out ]] && exit 1; exit 0 ;;
  "secret set")
    [[ -f $dir/fail-secret ]] && { echo "fake: HTTP 500" >&2; exit 1; }
    cat >"$dir/stdin.$3.$5"; echo "✓ Set Actions secret $3"; exit 0 ;;
  "variable set") exit 0 ;;
  "variable list") echo "${5^^}_APP_CLIENT_ID" ;;
  "secret list") echo "${5^^}_APP_PRIVATE_KEY" ;;
  *) echo "fake: unexpected gh call: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$work/bin/gh"

marker() { printf 'FAKE-KEY-%s-%s' "$1" "$RANDOM$RANDOM"; }
plant() { # name marker -> a fake PEM key at $work/keys/<name>.pem
  printf -- '-----BEGIN RSA PRIVATE KEY-----\n%s\n-----END RSA PRIVATE KEY-----\n' "$2" \
    >"$work/keys/$1.pem"
}
reset() {
  rm -f "$work"/calls "$work"/stdin.* "$work"/signed-out "$work"/fail-secret "$work"/keys/* \
    "$work"/env.* "$work"/policies.*
  fkey=$(marker factory) rkey=$(marker reviewer)
  plant factory "$fkey"
  plant reviewer "$rkey"
}
run() { # stdin-text args... -> sets code, out, err, calls
  out=$(cd "$work" && printf '%s' "$1" | PATH="$work/bin:$PATH" bash "$script" "${@:2}" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}
# Answers for one App: client ID, Enter, key path, delete? y, Enter, Enter (installed).
app_answers() { printf '%s\n\n%s\ny\n\n\n' "$1" "$2"; }
happy_input() {
  printf '\n\n\n'                                   # banner, check gh, environments
  app_answers Iv23factory "$work/keys/factory.pem"
  app_answers Iv23reviewer "$work/keys/reviewer.pem"
  printf '\n'                                       # names-only check
}

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' \
    "$1" "$code" "$out" "$err" "$calls"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
same_file() { cmp -s "$1" "$2"; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_hidden() { # marker...: in neither output nor any gh argument
  local m
  for m; do
    assert "key material in stdout" lacks "$out" "$m"
    assert "key material in stderr" lacks "$err" "$m"
    assert "key material in a gh argument" lacks "$calls" "$m"
  done
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
cp "$work/keys/factory.pem" "$work/factory.expected"
cp "$work/keys/reviewer.pem" "$work/reviewer.expected"
run "$(happy_input)"
expect_code 0
for env in factory review; do
  assert "expected $env created with a custom branch policy" contains "$calls" \
    "api -X PUT repos/sssoto17/sunny-pastures/environments/$env --silent -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true"
  assert "expected $env open to main and throwaway/* only" \
    test "$(cat "$work/policies.$env")" == $'main\nthrowaway/*'
done
assert "expected the factory client ID as an env variable" \
  contains "$calls" "variable set FACTORY_APP_CLIENT_ID --env factory --repo sssoto17/sunny-pastures --body Iv23factory"
assert "expected the reviewer client ID as an env variable" \
  contains "$calls" "variable set REVIEWER_APP_CLIENT_ID --env review --repo sssoto17/sunny-pastures --body Iv23reviewer"
assert "expected the factory key set in env factory" \
  contains "$calls" "secret set FACTORY_APP_PRIVATE_KEY --env factory --repo sssoto17/sunny-pastures"
assert "expected the reviewer key set in env review" \
  contains "$calls" "secret set REVIEWER_APP_PRIVATE_KEY --env review --repo sssoto17/sunny-pastures"
assert "expected the factory key on stdin, byte for byte" \
  same_file "$work/stdin.FACTORY_APP_PRIVATE_KEY.factory" "$work/factory.expected"
assert "expected the reviewer key on stdin, byte for byte" \
  same_file "$work/stdin.REVIEWER_APP_PRIVATE_KEY.review" "$work/reviewer.expected"
assert "expected no repo-level secret" lacks "$(grep '^secret set' <<<"$calls" | grep -v -- --env)" "secret"
expect_hidden "$fkey" "$rkey"
assert "expected the factory key file deleted" test ! -e "$work/keys/factory.pem"
assert "expected the reviewer key file deleted" test ! -e "$work/keys/reviewer.pem"
assert "expected the permissions in the registration URL" \
  contains "$out" "name=sunny-factory&url=https://github.com/sssoto17/sunny-pastures&public=false&contents=write&issues=write&pull_requests=write"
assert "expected the reviewer's permissions" contains "$out" "name=sunny-reviewer&url=https://github.com/sssoto17/sunny-pastures&public=false&contents=write&pull_requests=write"
assert "expected no Administration or Workflows permission requested" lacks "$out" "administration=write"
assert "expected names in the summary" contains "$out" "FACTORY_APP_PRIVATE_KEY (factory)"

# --- re-run: environments that already have the policy are left alone -------------------------
reset
for env in factory review; do
  echo "false true" >"$work/env.$env"
  printf 'main\nthrowaway/*\n' >"$work/policies.$env"
done
run "$(happy_input)"
expect_code 0
assert "expected no environment PUT on a re-run" lacks "$calls" "api -X PUT"
assert "expected no branch policy POST on a re-run" lacks "$calls" "api -X POST"

# --- an environment without a custom policy, or missing one pattern: only what is missing -------
reset
echo "null null" >"$work/env.factory"        # exists, all branches allowed
echo "false true" >"$work/env.review"
echo main >"$work/policies.review"
run "$(happy_input)"
expect_code 0
assert "expected factory restricted" contains "$calls" "api -X PUT repos/sssoto17/sunny-pastures/environments/factory"
assert "expected review not PUT again" lacks "$calls" "api -X PUT repos/sssoto17/sunny-pastures/environments/review"
assert "expected review to get only throwaway/*" \
  test "$(grep -c 'environments/review/deployment-branch-policies --silent' <<<"$calls")" -eq 1
assert "expected review's policies complete" test "$(cat "$work/policies.review")" == $'main\nthrowaway/*'

# --- a wrong path, then a file that isn't a key, then the key; keep the file -----------------
reset
echo "not a key" >"$work/keys/notes.txt"
input=$(
  printf '\n\n\n'
  printf 'Iv23factory\n\n%s\n%s\n%s\nn\n\n\n' "$work/keys/missing.pem" "$work/keys/notes.txt" \
    "$work/keys/factory.pem"
  app_answers Iv23reviewer "$work/keys/reviewer.pem"
  printf '\n'
)
run "$input"
expect_code 0
assert "expected a warning for the missing file" contains "$out" "no file at $work/keys/missing.pem"
assert "expected a warning for a file that isn't a key" contains "$out" "isn't a PEM private key"
assert "expected the kept key file to stay" test -f "$work/keys/factory.pem"
assert "expected a reminder to delete it" contains "$out" "delete it yourself"
expect_hidden "$fkey" "$rkey"

# --- gh secret set fails: exit 1, still no key material in the output -------------------------
reset
touch "$work/fail-secret"
run "$(happy_input)"
expect_code 1
assert "expected the failing command named" contains "$err" "gh secret set FACTORY_APP_PRIVATE_KEY --env factory failed"
expect_hidden "$fkey" "$rkey"
assert "expected the key file kept when storing failed" test -f "$work/keys/factory.pem"

# --- gh signed out: refused before any write ----------------------------------------------------
reset
touch "$work/signed-out"
run "$(happy_input)"
expect_code 2
assert "expected the sign-in hint" contains "$err" "gh auth login"
assert "expected no write" lacks "$calls" "set"
assert "expected no environment write" lacks "$calls" "api -X"

# --- input ends early: refused, nothing stored ------------------------------------------------
reset
run $'\n\n\n'
expect_code 2
assert "expected no secret set" lacks "$calls" "secret set"

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

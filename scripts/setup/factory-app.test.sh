#!/usr/bin/env bash
# Tests for factory-app.sh through its command line. The wizard reads its answers from stdin (no
# terminal, so no screen clearing). `gh` is a fake on PATH: it logs its arguments to $work/calls,
# keeps the environment in $work/env (its policy, "false true" when custom) and $work/policies
# ("<type> <name>" lines), the secret names in $work/secrets, the variable in $work/var, and saves
# what `gh secret set` reads on stdin to $work/stdin. $work/install holds the installation's
# answer ("<contents> <pull_requests> <administration> <workflows> <selection>"), $work/repos its
# repositories; no file there makes the installations call fail, as it may for gh's token.
# The planted key holds a marker that must reach `gh secret set` on stdin and nowhere else.
# Run: bash scripts/setup/factory-app.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/factory-app.sh"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/factory-app-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/keys"

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
d=$(dirname "$0")/..
printf '%s\n' "$*" >>"$d/calls"
E=repos/sssoto17/sunny-pastures/environments/factory-app
case "$*" in
  "auth status") [[ -f $d/signed-out ]] && exit 1; exit 0 ;;
  "api $E/deployment-branch-policies --jq "*) cat "$d/policies" 2>/dev/null; exit 0 ;;
  "api $E --jq "*) [[ -f $d/env ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; cat "$d/env"; exit 0 ;;
  "api -X PUT $E --silent -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true")
    echo "false true" >"$d/env"; exit 0 ;;
  "api -X POST $E/deployment-branch-policies --silent -f name=main -f type=branch")
    echo "branch main" >>"$d/policies"; exit 0 ;;
  "secret list --env factory-app --repo sssoto17/sunny-pastures --json name --jq .[].name")
    cat "$d/secrets" 2>/dev/null; exit 0 ;;
  "secret set FACTORY_APP_PRIVATE_KEY --env factory-app --repo sssoto17/sunny-pastures")
    [[ -f $d/fail-secret ]] && { echo "gh: HTTP 500" >&2; exit 1; }
    cat >"$d/stdin"; [[ -f $d/secret-lost ]] || echo FACTORY_APP_PRIVATE_KEY >>"$d/secrets"; exit 0 ;;
  "variable get FACTORY_APP_CLIENT_ID --env factory-app --repo sssoto17/sunny-pastures")
    [[ -f $d/var ]] || { echo "variable not found" >&2; exit 1; }; cat "$d/var"; exit 0 ;;
  "variable set FACTORY_APP_CLIENT_ID --env factory-app --repo sssoto17/sunny-pastures --body "*)
    echo "${*: -1}" >"$d/var"; exit 0 ;;
  "api user/installations --paginate --jq "*)
    [[ -f $d/install ]] || { echo "gh: Forbidden (HTTP 403)" >&2; exit 1; }
    echo "77 $(cat "$d/install")"; exit 0 ;;
  "api user/installations/77/repositories --paginate --jq "*) cat "$d/repos"; exit 0 ;;
esac
echo "fake: unexpected gh call: $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"

reset() {
  rm -f "$work"/calls "$work"/stdin "$work"/signed-out "$work"/fail-secret "$work"/secret-lost \
    "$work"/env "$work"/policies "$work"/secrets "$work"/var "$work"/install "$work"/repos "$work"/keys/*
  key=$(printf 'FAKE-KEY-%s' "$RANDOM$RANDOM")
  printf -- '-----BEGIN RSA PRIVATE KEY-----\n%s\n-----END RSA PRIVATE KEY-----\n' "$key" >"$work/keys/key.pem"
  cp "$work/keys/key.pem" "$work/expected.pem"
  echo "write write none none selected" >"$work/install"
  echo "sssoto17/sunny-pastures" >"$work/repos"
}
run() { # stdin-text args... -> code, out, err, calls
  out=$(cd "$work" && printf '%s' "$1" | PATH="$work/bin:$PATH" bash "$script" "${@:2}" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/calls" 2>/dev/null || true)
}
# Answers: start, gh ok, create env? y, Enter; key generated Enter; path, store? y, Enter;
# client ID, Enter; installation Enter; summary Enter.
happy() { printf '\n\ny\n\n\n%s\ny\n\nIv23factory\n\n\n\n' "$work/keys/key.pem"; }

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' "$1" "$code" "$out" "$err" "$calls"
}
assert() { if "${@:2}"; then ok; else bad "$1"; fi; }
contains() { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_hidden() {
  assert "key in stdout" lacks "$out" "$key"
  assert "key in stderr" lacks "$err" "$key"
  assert "key in a gh argument" lacks "$calls" "$key"
}

# --- usage ------------------------------------------------------------------------------------
reset
run "" --help
expect_code 0
assert "usage on --help" contains "$err" "usage:"
assert "exit codes in --help" contains "$err" "Exit codes:"
run "" extra
expect_code 2

# --- the happy path -----------------------------------------------------------------------------
reset
run "$(happy)"
expect_code 0
assert "environment created with a custom policy" contains "$calls" \
  "api -X PUT repos/sssoto17/sunny-pastures/environments/factory-app --silent"
assert "only main may use it" test "$(cat "$work/policies")" == "branch main"
assert "the policy read back" contains "$out" "factory-app: only main may use it"
assert "the key on stdin, byte for byte" cmp -s "$work/stdin" "$work/expected.pem"
assert "the key file deleted" test ! -e "$work/keys/key.pem"
assert "the secret read back by name" contains "$out" "FACTORY_APP_PRIVATE_KEY is set in factory-app"
assert "the client ID set in the environment" test "$(cat "$work/var")" == Iv23factory
assert "the variable read back" contains "$out" "FACTORY_APP_CLIENT_ID is Iv23factory"
assert "the installation checked" contains "$out" "on sssoto17/sunny-pastures only"
assert "no repo-level secret or variable" lacks "$(grep -E '^(secret|variable) set' <<<"$calls" | grep -v -- '--env factory-app')" "set"
assert "the App page opened" contains "$out" "https://github.com/settings/apps/sunny-factory"
expect_hidden

# --- re-run: environment as it should be, secret and variable there: nothing rewritten ----------
reset
echo "false true" >"$work/env"
echo "branch main" >"$work/policies"
echo FACTORY_APP_PRIVATE_KEY >"$work/secrets"
echo Iv23factory >"$work/var"
# start, gh ok, env Enter; replace key? n, Enter; client ID Enter (keeps), Enter; install; summary
run $'\n\n\nn\n\n\n\n\n\n'
expect_code 0
assert "no PUT on a re-run" lacks "$calls" "api -X PUT"
assert "no policy POST on a re-run" lacks "$calls" "-X POST"
assert "the key kept" lacks "$calls" "secret set"
assert "the client ID kept" test "$(cat "$work/var")" == Iv23factory
assert "the key file left alone" test -f "$work/keys/key.pem"

# --- an environment open to more than main: stop, change nothing -------------------------------
reset
echo "false true" >"$work/env"
printf 'branch main\nbranch throwaway/*\n' >"$work/policies"
run $'\n\n\n'
expect_code 1
assert "names the extra pattern" contains "$err" "throwaway/*"
assert "nothing deleted" lacks "$calls" "DELETE"
assert "no secret set" lacks "$calls" "secret set"
reset
echo "true false" >"$work/env" # protected branches only: not main-only
run $'\n\n\n'
expect_code 1
assert "refuses protected-branches mode" contains "$err" "Selected branches"

# --- declining the environment: stop before any write -------------------------------------------
reset
run $'\n\nn\n'
expect_code 2
assert "no write" lacks "$calls" "-X"

# --- a wrong path, a file that isn't a key, then the key ----------------------------------------
reset
echo "not a key" >"$work/keys/notes.txt"
run "$(printf '\n\ny\n\n\n%s\n%s\n%s\ny\n\nIv23factory\n\n\n\n' "$work/keys/missing.pem" "$work/keys/notes.txt" "$work/keys/key.pem")"
expect_code 0
assert "warns about the missing file" contains "$out" "no file at $work/keys/missing.pem"
assert "warns about a non-key" contains "$out" "isn't a PEM private key"
expect_hidden

# --- gh secret set fails, or the secret doesn't read back: stop, key kept -----------------------
reset
touch "$work/fail-secret"
run "$(happy)"
expect_code 1
assert "names the failed command" contains "$err" "gh secret set FACTORY_APP_PRIVATE_KEY --env factory-app failed"
assert "key file kept" test -f "$work/keys/key.pem"
expect_hidden
reset
touch "$work/secret-lost"
run "$(happy)"
expect_code 1
assert "the read-back fails" contains "$err" "FACTORY_APP_PRIVATE_KEY isn't listed"

# --- the installation is too wide: stop -----------------------------------------------------------
for bad_install in "write write write none selected" "write write none write selected" \
  "read write none none selected" "write write none none all"; do
  reset
  echo "$bad_install" >"$work/install"
  run "$(happy)"
  expect_code 1
  assert "installation '$bad_install' refused" contains "$err" "installation"
done
reset
printf 'sssoto17/sunny-pastures\nsssoto17/other\n' >"$work/repos"
run "$(happy)"
expect_code 1
assert "names the other repo" contains "$err" "sssoto17/other"

# --- installations unreadable with gh's token: the admin checks the page and answers ----------
reset
rm "$work/install"
run "$(printf '\n\ny\n\n\n%s\ny\n\nIv23factory\n\ny\n\n' "$work/keys/key.pem")"
expect_code 0
assert "asks the admin instead" contains "$out" "Repository permissions"
reset
rm "$work/install"
run "$(printf '\n\ny\n\n\n%s\ny\n\nIv23factory\n\nn\n' "$work/keys/key.pem")"
expect_code 1
assert "a no stops it" contains "$err" "fix the installation"

# --- gh signed out: refused before any write ----------------------------------------------------
reset
touch "$work/signed-out"
run "$(happy)"
expect_code 2
assert "sign-in hint" contains "$err" "gh auth login"
assert "no write" lacks "$calls" "set"

printf 'factory-app.test.sh: %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))

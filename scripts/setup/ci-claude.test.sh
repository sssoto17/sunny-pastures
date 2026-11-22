#!/usr/bin/env bash
# Tests for ci-claude.sh through its command line. The wizard reads its answers from stdin (no
# terminal). `gh` is a fake on PATH: it logs its arguments to $work/calls, saves what
# `gh secret set` reads on stdin to $work/stdin.<NAME>.<env>, answers the environment reads from
# $work/policy and $work/branches, each environment's secret names from $work/secrets.<env>, and
# the Actions permission reads from $work/mode and $work/patterns. Each test pastes a token
# holding a unique marker and checks it reaches `gh secret set` on stdin, with --env claude-seat
# and no other environment (#454), and never appears in the output or in any gh argument.
# Run: bash scripts/setup/ci-claude.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ci-claude.sh"
pass=0
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-claude-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
BUN=oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
repo=$(cd "$(dirname "$0")/../.." && pwd)
# Every `uses:` of claude-code-action in the workflows, with its version comment, one per line.
pins=$(cd "$repo" && grep -hoE 'uses: anthropics/claude-code-action@[^ ]+( # [^ ]+)?' \
  .github/workflows/*.yml scripts/setup/workflows/*.yml | sed 's/^uses: //' | sort -u)
# The wizard's ACTION_PATTERNS array, comments kept: the version sits in the comment.
patterns=$(sed -n '/^ACTION_PATTERNS=(/,/^)/p' "$script")
CLAUDE=${pins%% *}

cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
case "$*" in
  "auth status") exit 0 ;;
  "secret set "*)
    if [[ -f $dir/fail-secret ]]; then cat >/dev/null; echo "fake: HTTP 500" >&2; exit 1; fi
    cat >"$dir/stdin.$3.$5"; echo "✓ Set Actions secret $3"; exit 0 ;;
  "secret list "*) cat "$dir/secrets.$4" ;;
  "api repos/sssoto17/sunny-pastures/environments/claude-seat/deployment-branch-policies "*)
    cat "$dir/branches" ;;
  "api repos/sssoto17/sunny-pastures/environments/claude-seat "*)
    [[ -f $dir/no-env ]] && { echo '{"message":"Not Found"}'; exit 1; }; cat "$dir/policy" ;;
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
  rm -f "$work"/calls "$work"/stdin.* "$work"/no-env "$work"/fail-patterns "$work"/fail-secret
  echo selected >"$work/mode"
  echo 'false true' >"$work/policy"
  echo 'branch main' >"$work/branches"
  echo CLAUDE_CODE_OAUTH_TOKEN >"$work/secrets.claude-seat"
  echo FACTORY_APP_PRIVATE_KEY >"$work/secrets.factory"
  echo REVIEWER_APP_PRIVATE_KEY >"$work/secrets.review"
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

# --- the pattern follows the workflows' pin (#486): a bump that leaves the wizard behind fails ---
code=0 out=$pins err="" calls=$patterns
assert "expected a claude-code-action pin in the workflows" test -n "$pins"
assert "expected one pin, the same in every workflow" test "$(grep -c . <<<"$pins")" -eq 1
assert "expected the pin to be a full commit SHA with its version (ADR-0002, area 8)" \
  grep -qxE 'anthropics/claude-code-action@[0-9a-f]{40} # v[0-9.]+' <<<"$pins"
assert "expected exactly one claude-code-action pattern in the wizard" \
  test "$(grep -c 'anthropics/claude-code-action' <<<"$patterns")" -eq 1
assert "expected the wizard's pattern to carry the workflows' SHA and version" \
  grep -qxE "  ${pins//./\\.}(,.*)?" <<<"$patterns"

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
assert "expected the token set in claude-seat" \
  contains "$calls" "secret set CLAUDE_CODE_OAUTH_TOKEN --env claude-seat --repo sssoto17/sunny-pastures"
assert "expected the token on stdin for claude-seat, exactly" \
  test "$(cat "$work/stdin.CLAUDE_CODE_OAUTH_TOKEN.claude-seat" 2>/dev/null)" == "$token"
assert "expected one secret written" test "$(grep -c '^secret set' <<<"$calls")" -eq 1
for env in factory review; do
  assert "expected nothing written to $env" lacks "$calls" "secret set CLAUDE_CODE_OAUTH_TOKEN --env $env"
  assert "expected no token on stdin for $env" test ! -e "$work/stdin.CLAUDE_CODE_OAUTH_TOKEN.$env"
  assert "expected $env's names listed" contains "$calls" "secret list --env $env --repo sssoto17/sunny-pastures"
done
assert "expected main-only checked" contains "$calls" "environments/claude-seat/deployment-branch-policies"
assert "expected no warning while only claude-seat holds it" lacks "$out" "still holds"
assert "expected nothing deleted" lacks "$calls" "secret delete"
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

# --- gh secret set fails: exit 1, no "✓ set", and the token is never shown ---------------------
reset
touch "$work/fail-secret"
run "$(answers "$token")"
expect_code 1
assert "expected the failing command named" contains "$err" "gh secret set CLAUDE_CODE_OAUTH_TOKEN --env claude-seat failed"
assert "expected no success line" lacks "$out" "✓ set"
assert "expected no allowed-actions write after a failed upload" lacks "$calls" "api -X PUT"
expect_hidden "$token"

# --- a paste that isn't sk-ant-oat…: stored only on y ---------------------------------------------
reset
odd="odd-token-FAKE$RANDOM$RANDOM"
run "$(printf '\n\n\n%s\nn\n' "$odd")"
expect_code 2
assert "expected nothing stored on n" lacks "$calls" "secret set"
expect_hidden "$odd"
reset
run "$(printf '\n\n\n%s\ny\n\ny\n\n\n' "$odd")"
expect_code 0
assert "expected it stored on y" test "$(cat "$work/stdin.CLAUDE_CODE_OAUTH_TOKEN.claude-seat" 2>/dev/null)" == "$odd"
expect_hidden "$odd"

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

# --- no claude-seat yet: refused before the token is asked for ----------------------------------
reset
touch "$work/no-env"
run "$(answers "$token")"
expect_code 2
assert "expected claude-seat named" contains "$err" "no environment claude-seat"
assert "expected no secret set" lacks "$calls" "secret set"
assert "expected gh's error body dropped" lacks "$out$err" "Not Found"

# --- claude-seat not limited to selected branches: refused, nothing stored ----------------------
reset
echo 'true false' >"$work/policy"
run "$(answers "$token")"
expect_code 2
assert "expected the policy named" contains "$err" "isn't limited to Selected branches"
assert "expected no secret set" lacks "$calls" "secret set"
expect_hidden "$token"

# --- claude-seat admits a branch besides main: refused, nothing stored --------------------------
reset
printf '%s\n' 'branch main' 'branch throwaway/*' >"$work/branches"
run "$(answers "$token")"
expect_code 2
assert "expected the extra rule named" contains "$err" "may be used by more than main: branch main branch throwaway/*"
assert "expected no secret set" lacks "$calls" "secret set"
expect_hidden "$token"

# --- review or factory still holds the seat token: a warning and the command, never a delete ----
reset
printf '%s\n' REVIEWER_APP_PRIVATE_KEY CLAUDE_CODE_OAUTH_TOKEN >"$work/secrets.review"
run "$(answers "$token")"
expect_code 0
assert "expected the warning for review" contains "$out" "review still holds CLAUDE_CODE_OAUTH_TOKEN"
assert "expected no warning for factory" lacks "$out" "factory still holds"
assert "expected the delete command shown" \
  contains "$out" "gh secret delete CLAUDE_CODE_OAUTH_TOKEN --env review --repo sssoto17/sunny-pastures"
assert "expected it listed as still to do" contains "$out" "delete CLAUDE_CODE_OAUTH_TOKEN from review"
assert "expected nothing deleted" lacks "$calls" "secret delete"
expect_hidden "$token"

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

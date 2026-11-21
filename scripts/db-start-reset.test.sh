#!/usr/bin/env bash
# Tests for `supabase/db.sh start` and `reset` (`pnpm db:start`, `pnpm db:reset`, #382) through
# their command line, in a throwaway folder under $TMPDIR. `supabase` is a fake on PATH that logs
# its arguments and prints the secrets the real CLI prints. What's checked: `start` passes its
# flags on to `supabase start` (CI's --exclude), `reset` runs `supabase db reset`, and neither shows
# a secret, whether the CLI succeeds or fails.
# Run: bash scripts/db-start-reset.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/supabase/db.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/db-start-reset-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/repo"

cat >"$work/bin/supabase" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
if [[ $* == "status -o env" ]]; then
  echo 'DB_URL="postgresql://postgres:local-admin-pw@127.0.0.1:55322/postgres"'
  echo 'SECRET_KEY="sb_secret_abc"'
  exit 0
fi
# What the real CLI shows on both streams: the database URL with its password, and a key.
echo "Connecting to postgresql://postgres:local-admin-pw@127.0.0.1:55322/postgres"
echo "secret key: sb_secret_abc" >&2
[[ -f $dir/fail ]] && exit 1
exit 0
FAKE
chmod +x "$work/bin/supabase"
export PATH="$work/bin:$PATH"

check() {
  if [[ $2 == ok ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1" >&2
  fi
}

leaks() { grep -q -e 'local-admin-pw' -e 'sb_secret_abc' "$1"; }

cd "$work/repo" || exit 1

bash "$script" start --exclude studio,imgproxy >"$work/out" 2>&1
check "start succeeds" "$([[ $? == 0 ]] && echo ok)"
check "start passes its flags to supabase start" \
  "$(grep -qx 'start --exclude studio,imgproxy' "$work/calls" && echo ok)"
check "start shows no secret" "$(leaks "$work/out" || echo ok)"

: >"$work/calls"
bash "$script" reset >"$work/out" 2>&1
check "reset succeeds" "$([[ $? == 0 ]] && echo ok)"
check "reset runs supabase db reset" "$(grep -qx 'db reset' "$work/calls" && echo ok)"
check "reset shows no secret" "$(leaks "$work/out" || echo ok)"
check "reset says what's next" "$(grep -q 'pnpm db:env' "$work/out" && echo ok)"

touch "$work/fail"
bash "$script" reset >"$work/out" 2>&1
check "a failed reset fails" "$([[ $? != 0 ]] && echo ok)"
check "a failed reset shows the CLI's output" "$(grep -q 'Connecting to' "$work/out" && echo ok)"
check "a failed reset shows no secret" "$(leaks "$work/out" || echo ok)"

echo "db-start-reset.test.sh: $pass passed, $fail failed"
[[ $fail == 0 ]]

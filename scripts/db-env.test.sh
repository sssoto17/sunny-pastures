#!/usr/bin/env bash
# Tests for `supabase/db.sh env` (`pnpm db:env`, #372) through its command line, in a throwaway
# folder under $TMPDIR. `supabase` and `psql` are fakes on PATH: supabase answers `status -o env`
# with a local DB_URL, and psql records its stdin and arguments, or fails when $work/fail-psql
# exists. What's checked: the game_api password reaches psql on stdin only, lands in .env inside
# DATABASE_URL, is kept from an existing game_api DATABASE_URL (one stack, many worktrees), and
# never appears in the script's output, even when psql fails.
# Run: bash scripts/db-env.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/supabase/db.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/db-env-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/repo/supabase"
printf 'project_id = "test"\n' >"$work/repo/supabase/config.toml"

cat >"$work/bin/supabase" <<'FAKE'
#!/usr/bin/env bash
if [[ $* == "status -o env" ]]; then
  echo 'DB_URL="postgresql://postgres:local-admin-pw@127.0.0.1:55322/postgres"'
  echo 'API_URL="http://127.0.0.1:55321"'
  echo 'PUBLISHABLE_KEY="sb_publishable_xyz"'
  echo 'SECRET_KEY="sb_secret_abc"'
  exit 0
fi
echo "fake: unexpected supabase call: $*" >&2
exit 99
FAKE
cat >"$work/bin/psql" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >"$dir/psql-args"
printf '%s\n' "${PGPASSWORD:-}" >"$dir/psql-pgpassword"
cat >"$dir/psql-stdin"
if [[ -f $dir/fail-psql ]]; then
  echo "ERROR:  role \"game_api\" does not exist" >&2
  echo "LINE 1: $(cat "$dir/psql-stdin")" >&2
  exit 3
fi
FAKE
# Every other command the script runs goes through a wrapper that logs its arguments while the
# script runs (LOG_ARGV), so a test can check no password reached any of them: `ps` shows them.
for cmd in sed grep mktemp mv openssl head; do
  real=$(command -v "$cmd")
  printf '#!/usr/bin/env bash\n[[ -n ${LOG_ARGV:-} ]] && printf "%%s\\n" "$*" >>"%s/argv"\nexec %s "$@"\n' "$work" "$real" >"$work/bin/$cmd"
  chmod +x "$work/bin/$cmd"
done
chmod +x "$work/bin/supabase" "$work/bin/psql"
export PATH="$work/bin:$PATH"

check() {
  if [[ $2 == ok ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1" >&2
  fi
}

# Runs `db.sh env` in the throwaway repo; its combined output goes to $work/out.
run_env() { (cd "$work/repo" && LOG_ARGV=1 bash "$script" env) >"$work/out" 2>&1; }

password_in_env() { sed -n -E 's#^DATABASE_URL=postgresql://game_api:([0-9a-f]+)@.*#\1#p' "$work/repo/.env"; }

# --- a first run ------------------------------------------------------------------------------
printf 'OTHER=kept\nDATABASE_URL=postgresql://postgres:old@127.0.0.1:55322/postgres\n' >"$work/repo/.env"
run_env
check "exits 0" "$([[ $? -eq 0 ]] && echo ok)"
pw1=$(password_in_env)
check "writes game_api's DATABASE_URL with a 48-hex-digit password" \
  "$([[ ${#pw1} -eq 48 ]] && grep -qx "DATABASE_URL=postgresql://game_api:$pw1@127.0.0.1:55322/postgres" "$work/repo/.env" && echo ok)"
check "writes the postgres role's ADMIN_DATABASE_URL" \
  "$(grep -qx 'ADMIN_DATABASE_URL=postgresql://postgres:local-admin-pw@127.0.0.1:55322/postgres' "$work/repo/.env" && echo ok)"
check "replaces the old DATABASE_URL and keeps other lines" \
  "$([[ $(grep -c '^DATABASE_URL=' "$work/repo/.env") -eq 1 ]] && grep -qx 'OTHER=kept' "$work/repo/.env" && echo ok)"
check "sets the password with alter role, on psql's stdin" \
  "$(grep -qx "alter role game_api with password '$pw1';" "$work/psql-stdin" && echo ok)"
check "never passes the password as an argument" \
  "$(grep -q -e "$pw1" -e local-admin-pw "$work/psql-args" "$work/argv" || echo ok)"
check "hands psql the admin password in PGPASSWORD, and a URL without it" \
  "$(grep -qx local-admin-pw "$work/psql-pgpassword" && grep -q 'postgresql://postgres@127.0.0.1:55322/postgres' "$work/psql-args" && echo ok)"
check "never prints the password or the admin password" \
  "$(grep -q -e "$pw1" -e local-admin-pw -e sb_secret "$work/out" || echo ok)"
check "copies SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (#371) without printing the key" \
  "$(grep -qx 'SUPABASE_URL=http://127.0.0.1:55321' "$work/repo/.env" && grep -qx 'SUPABASE_PUBLISHABLE_KEY=sb_publishable_xyz' "$work/repo/.env" && ! grep -q sb_publishable "$work/out" && echo ok)"
check "keeps .env readable by its owner only" \
  "$([[ $(stat -c %a "$work/repo/.env") == 600 ]] && echo ok)"

# --- a second run keeps the password (every worktree shares one local stack) ---------------------
rm -f "$work/psql-stdin"
run_env
pw2=$(password_in_env)
check "a second run keeps the password" "$([[ $pw2 == "$pw1" ]] && echo ok)"
check "a second run still sets it, as a supabase db reset needs" \
  "$(grep -qx "alter role game_api with password '$pw1';" "$work/psql-stdin" && echo ok)"
check "a second run leaves one line per variable" \
  "$(for v in DATABASE_URL ADMIN_DATABASE_URL SUPABASE_URL SUPABASE_PUBLISHABLE_KEY; do [[ $(grep -c "^$v=" "$work/repo/.env") -eq 1 ]] || exit; done; echo ok)"
check "a second run prints no password either" "$(grep -q "$pw1" "$work/out" || echo ok)"

# --- no .env at all: a new password ---------------------------------------------------------------
mv "$work/repo/.env" "$work/env-kept"
run_env
pw3=$(password_in_env)
check "with no game_api URL in .env, makes a new 48-hex-digit password" \
  "$([[ ${#pw3} -eq 48 && $pw3 != "$pw1" ]] && grep -qx "alter role game_api with password '$pw3';" "$work/psql-stdin" && echo ok)"
check "with no .env, prints no password" "$(grep -q "$pw3" "$work/out" || echo ok)"
mv "$work/env-kept" "$work/repo/.env"

# --- psql fails ---------------------------------------------------------------------------------
cp "$work/repo/.env" "$work/env-before"
touch "$work/fail-psql"
run_env
status=$?
tried=$(sed -n -E "s/^alter role game_api with password '([0-9a-f]+)';$/\1/p" "$work/psql-stdin")
check "exits 1 when psql fails" "$([[ $status -eq 1 ]] && echo ok)"
check "leaves .env unchanged when psql fails" "$(cmp -s "$work/env-before" "$work/repo/.env" && echo ok)"
check "hides the password psql quotes back" \
  "$([[ -n $tried ]] && ! grep -q "$tried" "$work/out" && grep -q 'does not exist' "$work/out" && echo ok)"
check "says what to do" "$(grep -q 'supabase db reset' "$work/out" && echo ok)"
rm "$work/fail-psql"

echo "db-env.test.sh: $pass passed, $fail failed"
((fail == 0))

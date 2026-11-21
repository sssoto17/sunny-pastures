#!/usr/bin/env bash
# Wraps the Supabase CLI so its output never shows a secret value.
# The CLI prints keys and the database password on stdout and stderr, so both are captured.
#   start   start the local stack, then show `status`. Any further arguments go to
#           `supabase start` (CI excludes the services the tests don't use, #382)
#   reset   `supabase db reset`: recreate the local database and apply the migrations and seed.
#           Its output can show the database URL, so only a failure is shown, redacted (#382)
#   status  list the stack's variables: URLs with the password hidden, every other value hidden
#   env     set the game_api role's password and write its DATABASE_URL, and the postgres role's
#           ADMIN_DATABASE_URL, into ./.env, printing neither (#372). Reuses the password of a
#           game_api DATABASE_URL already in ./.env, since every worktree shares one local stack;
#           makes a random one only when there is none. Run it after `pnpm db:reset`, which
#           applies the migration that creates game_api with no password. Also copies
#           SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY from the running stack (#371), each skipped
#           if already set, without printing them.
set -euo pipefail

# Hide anything that looks like a credential in free-form output (errors, warnings).
redact() {
  sed -E \
    -e 's/(sb_secret_|sb_publishable_)[A-Za-z0-9_-]+/\1<hidden>/g' \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/<hidden-jwt>/g' \
    -e 's#(://[^:/@" ]+:)[^@" ]*@#\1<hidden>@#g' \
    -e 's/("[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*": *")[^"]*"/\1<hidden>"/g' \
    -e 's/^([A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*=).*/\1<hidden>/' \
    -e 's/[0-9a-fA-F]{32,}/<hidden>/g'
}

# Run the CLI with both streams captured; on failure, show the redacted output and stop.
run() {
  local out
  if ! out=$(supabase "$@" 2>&1); then
    printf '%s\n' "$out" | redact >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

status() {
  run status -o env | awk '!seen[$0]++' | while IFS= read -r line; do
    if [[ $line =~ ^[A-Z0-9_]+_URL= ]]; then
      printf '%s\n' "$line" | redact
    elif [[ $line =~ ^([A-Z0-9_]+)= ]]; then
      printf '%s=<hidden>\n' "${BASH_REMATCH[1]}"
    else
      printf '%s\n' "$line" | redact >&2
    fi
  done
}

# Copy one value of `supabase status -o env` ($3) into ./.env as $1, from its field $2. Prints the
# name only, never the value.
copy_variable() {
  local name=$1 field=$2 values=$3 value
  if grep -qs "^$name=" .env; then
    echo "$name is already set in .env; not changed."
    return
  fi
  value=$(printf '%s\n' "$values" | sed -n -E "s/^$field=\"?([^\"]*)\"?\$/\1/p" | head -n 1)
  if [[ -z $value ]]; then
    echo "supabase status gave no $field; is the stack running? Try: pnpm db:start" >&2
    exit 1
  fi
  printf '%s=%s\n' "$name" "$value" >> .env
  echo "Wrote $name to .env."
}

write_env() {
  local values admin password url
  values=$(run status -o env)
  admin=$(printf '%s\n' "$values" | sed -n -E 's/^DB_URL="?([^"]*)"?$/\1/p' | head -n 1)
  if [[ -z $admin ]]; then
    echo "supabase status gave no DB_URL; is the stack running? Try: pnpm db:start" >&2
    exit 1
  fi
  # Every worktree shares one local stack, so a new password here would break the DATABASE_URL in
  # every other worktree's .env: keep the one .env already holds, and set it again, which a
  # `supabase db reset` needs. Hex only, so it needs no escaping in SQL or in a URL.
  password=
  if [[ -f .env ]]; then
    password=$(sed -n -E 's#^DATABASE_URL=[a-z]+://game_api:([0-9a-f]+)@.*#\1#p' .env | head -n 1)
  fi
  if [[ -z $password ]]; then
    password=$(openssl rand -hex 24)
  fi
  # On stdin, never in argv, so `ps` doesn't show it either.
  if ! printf "alter role game_api with password '%s';\n" "$password" | run_sql "$admin" "$password"; then
    echo "Could not set game_api's password. Has pnpm db:reset applied the migrations?" >&2
    exit 1
  fi
  # Parameter expansion, not sed: a command's arguments show in `ps`, so neither password goes there.
  url="${admin%%://*}://game_api:${password}@${admin#*@}"
  set_env DATABASE_URL "$url"
  set_env ADMIN_DATABASE_URL "$admin"
  echo "Set game_api's password; wrote DATABASE_URL (game_api) and ADMIN_DATABASE_URL to .env."
  # The auth module and the anonymous sign-up test helper read these two (#371).
  copy_variable SUPABASE_URL API_URL "$values"
  copy_variable SUPABASE_PUBLISHABLE_KEY PUBLISHABLE_KEY "$values"
}

# Runs the SQL on stdin against the URL in $1 with psql, or, without a local psql, with the one in
# the stack's Postgres image (supabase/README.md). The URL's password goes in PGPASSWORD, never in
# psql's arguments. Output is dropped; an error is shown redacted, with the secret in $2 hidden,
# since psql quotes the failing statement.
run_sql() {
  local out userinfo plain
  userinfo=${1#*://}
  userinfo=${userinfo%%@*}
  plain="${1%%://*}://${userinfo%%:*}@${1#*@}"
  if [[ $userinfo == *:* ]]; then
    export PGPASSWORD=${userinfo#*:}
  fi
  if command -v psql >/dev/null; then
    out=$(psql "$plain" -X -q -v ON_ERROR_STOP=1 2>&1 >/dev/null) && return 0
  else
    local project image
    project=$(sed -n -E 's/^project_id = "([^"]+)"/\1/p' supabase/config.toml)
    image=$(docker inspect -f '{{.Config.Image}}' "supabase_db_${project}") || return 1
    # `-e PGPASSWORD` with no value passes this shell's variable on, not a value in argv.
    out=$(docker run --rm -i -e PGPASSWORD --network host --entrypoint psql "$image" "$plain" -X -q -v ON_ERROR_STOP=1 2>&1 >/dev/null) && return 0
  fi
  printf '%s\n' "${out//"$2"/<hidden>}" | redact >&2
  return 1
}

# Sets NAME=value in ./.env: replaces the line if there is one, keeps every other line, and keeps
# the file readable by its owner only.
set_env() {
  local tmp
  tmp=$(umask 077 && mktemp .env.XXXXXX)
  grep -v "^$1=" .env 2>/dev/null >"$tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  mv "$tmp" .env
}

case "${1:-}" in
  start) shift; run start "$@" > /dev/null; status ;;
  reset) run db reset > /dev/null; echo "Reset the local database: migrations and seed applied. Next: pnpm db:env" ;;
  status) status ;;
  env) write_env ;;
  *) echo "usage: supabase/db.sh start [supabase start flags]|reset|status|env" >&2; exit 2 ;;
esac

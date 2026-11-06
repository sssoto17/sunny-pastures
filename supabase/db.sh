#!/usr/bin/env bash
# Wraps the Supabase CLI so its output never shows a secret value.
# The CLI prints keys and the database password on stdout and stderr, so both are captured.
#   start   start the local stack, then show `status`
#   status  list the stack's variables: URLs with the password hidden, every other value hidden
#   env     write DATABASE_URL into ./.env without printing it (skipped if already set)
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

write_env() {
  if grep -qs '^DATABASE_URL=' .env; then
    echo "DATABASE_URL is already set in .env; not changed."
    return
  fi
  local url
  url=$(run status -o env | sed -n -E 's/^DB_URL="?([^"]*)"?$/\1/p' | head -n 1)
  if [[ -z $url ]]; then
    echo "supabase status gave no DB_URL; is the stack running? Try: pnpm db:start" >&2
    exit 1
  fi
  printf 'DATABASE_URL=%s\n' "$url" >> .env
  echo "Wrote DATABASE_URL to .env."
}

case "${1:-}" in
  start) run start > /dev/null; status ;;
  status) status ;;
  env) write_env ;;
  *) echo "usage: supabase/db.sh start|status|env" >&2; exit 2 ;;
esac

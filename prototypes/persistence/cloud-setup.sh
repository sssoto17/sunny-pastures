#!/usr/bin/env bash
# Cloud-session setup for the persistence spike (#7; #15 extends it). Safe to run twice.
#   1. Node 24 (from nodejs.org, checksum-verified) if `node --version` isn't v24
#   2. corepack + pnpm install
#   3. plain Postgres from apt (no Docker, no Supabase CLI), started on 127.0.0.1:5432
#   4. a login role with a random password and its own database
#   5. DATABASE_URL written to the repo-root .env (gitignored), never printed
#
# Run:     prototypes/persistence/cloud-setup.sh
# Source:  . prototypes/persistence/cloud-setup.sh   (also exports DATABASE_URL into your shell)
# Needs root (cloud containers run as root). Prints only names and versions, never the URL.

_sp_setup() (
  set -euo pipefail
  local repo
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  cd "$repo"

  local node_major=24 role=spike db=sunny_pastures port=5432

  # 1. Node 24 ------------------------------------------------------------------------------
  if [[ $(node --version 2>/dev/null) != v${node_major}.* ]]; then
    local version dir
    version=$(curl -fsS https://nodejs.org/dist/index.json |
      python3 -c "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v${node_major}.')))")
    dir=/opt/node-$version
    if [[ ! -x $dir/bin/node ]]; then
      local tmp file=node-$version-linux-x64.tar.xz
      tmp=$(mktemp -d)
      curl -fsS -o "$tmp/$file" "https://nodejs.org/dist/$version/$file"
      curl -fsS -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$version/SHASUMS256.txt"
      (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
      mkdir -p "$dir"
      tar -xJf "$tmp/$file" -C "$dir" --strip-components=1
      rm -rf "$tmp"
    fi
    # Link into the first writable PATH directory that comes before the current node (the
    # image's /opt/node22/bin sits ahead of /usr/local/bin), so new shells find Node 24 first.
    local bindir=/usr/local/bin old p
    old=$(dirname "$(command -v node 2> /dev/null || echo /nonexistent/node)")
    IFS=: read -ra path_dirs <<< "$PATH"
    for p in "${path_dirs[@]}"; do
      [[ $p == "$old" ]] && break
      if [[ -d $p && -w $p && $p != /nix/* ]]; then bindir=$p; break; fi
    done
    for bin in node npm npx corepack; do ln -sf "$dir/bin/$bin" "$bindir/$bin"; done
    hash -r
    [[ $(node --version) == v${node_major}.* ]] || { echo "node $node_major installed in $dir but not first on PATH" >&2; exit 1; }
  fi
  echo "node $(node --version)"

  # 2. pnpm ---------------------------------------------------------------------------------
  corepack enable
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --reporter=silent
  echo "pnpm $(pnpm --version), dependencies installed"

  # 3. Postgres -----------------------------------------------------------------------------
  if ! ls /usr/lib/postgresql/*/bin/postgres > /dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql > /dev/null
  fi
  local pg_major
  pg_major=$(ls /usr/lib/postgresql | sort -n | tail -n 1)
  if ! pg_lsclusters -h | grep -q "^$pg_major main "; then
    pg_createcluster "$pg_major" main --port "$port" > /dev/null
  fi
  pg_ctlcluster "$pg_major" main start > /dev/null 2>&1 || true # already running is fine
  pg_isready -q -h 127.0.0.1 -p "$port"
  echo "postgres $pg_major ($(runuser -u postgres -- psql -tAc 'show server_version'))"

  # 4 + 5. Role, database and .env -----------------------------------------------------------
  local url=""
  if [[ -f .env ]]; then url=$(sed -n -E 's/^DATABASE_URL=(.*)$/\1/p' .env | tail -n 1); fi
  if [[ -n $url ]] && psql "$url" -qtAc 'select 1' > /dev/null 2>&1; then
    echo "DATABASE_URL in .env already connects; not changed."
  else
    local password
    password=$(openssl rand -hex 24) # hex: nothing to escape in SQL or the URL
    # The password goes over stdin (printf is a builtin), so it never shows in `ps` or output.
    printf "do \$\$ begin
              if not exists (select from pg_roles where rolname = '%s') then
                create role %s login;
              end if;
            end \$\$;
            alter role %s with login password '%s';\n" "$role" "$role" "$role" "$password" |
      runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 > /dev/null
    if ! runuser -u postgres -- psql -tAc "select 1 from pg_database where datname = '$db'" | grep -q 1; then
      runuser -u postgres -- createdb -O "$role" "$db"
    fi
    url="postgresql://$role:$password@127.0.0.1:$port/$db"
    touch .env && chmod 600 .env
    sed -i '/^DATABASE_URL=/d' .env
    printf 'DATABASE_URL=%s\n' "$url" >> .env
    psql "$url" -qtAc 'select 1' > /dev/null
    echo "Wrote DATABASE_URL to .env (role $role, database $db)."
  fi
)

if _sp_setup; then
  # Sourced: export DATABASE_URL into the caller's shell without echoing it.
  if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
    _sp_env="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env"
    export DATABASE_URL="$(sed -n -E 's/^DATABASE_URL=(.*)$/\1/p' "$_sp_env" | tail -n 1)"
    unset _sp_env
    echo "DATABASE_URL exported ($(printf %s "$DATABASE_URL" | wc -c) chars)."
  fi
else
  echo "cloud-setup failed" >&2
  [[ ${BASH_SOURCE[0]} != "$0" ]] && return 1 || exit 1
fi
unset -f _sp_setup

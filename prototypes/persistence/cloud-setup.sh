#!/usr/bin/env bash
# Cloud-session setup for the persistence spike (#7, extended by #15). Safe to run twice.
#   1. Node 24 if `node --version` isn't v24: the image's /opt/node24, else nodejs.org (checksum-verified)
#   2. corepack + pnpm install
#   3. uv 0.13.6 (from PyPI, in its own venv), Python 3.13 via uv, and the Locust project synced
#   4. Postgres 17 from the PGDG apt repo (apt.postgresql.org); if the network refuses it, Ubuntu's
#      own Postgres (16) as the fallback. No Docker, no Supabase CLI. Started on 127.0.0.1:5432.
#   5. a login role with a random password and its own database
#   6. DATABASE_URL written to the repo-root .env (gitignored), never printed
#
# Every network step runs under `timeout`, so a blocked host fails the step instead of hanging.
#
# Run:     prototypes/persistence/cloud-setup.sh
# Source:  . prototypes/persistence/cloud-setup.sh   (also exports DATABASE_URL into your shell)
# Env:     SP_PG_MAJOR=17 (the local Supabase stack's major, #19); SP_NET_TIMEOUT=60 (seconds per
#          download); SP_APT_TIMEOUT=600 (seconds per apt step).
# Needs root (cloud containers run as root). Prints only names and versions, never the URL.

_sp_setup() (
  set -euo pipefail
  local repo
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  cd "$repo"

  local node_major=24 uv_version=0.13.6 python_version=3.13 role=spike db=sunny_pastures port=5432
  local pg_want=${SP_PG_MAJOR:-17} net=${SP_NET_TIMEOUT:-60} apt_t=${SP_APT_TIMEOUT:-600}

  # Puts `name` → `target` in the first writable PATH directory that comes before the current
  # `name` (the image's /opt/node22/bin and ~/.local/bin/uv come early), so new shells find it first.
  # If nothing writable comes before it, the link replaces the current one in place.
  first_on_path() {
    local name=$1 target=$2 old p bindir=""
    old=$(dirname "$(command -v "$name" 2> /dev/null || echo /nonexistent/x)")
    IFS=: read -ra path_dirs <<< "$PATH"
    for p in "${path_dirs[@]}"; do
      if [[ $p == "$old" ]]; then [[ -w $p ]] && bindir=${bindir:-$p}; break; fi
      if [[ -z $bindir && -d $p && -w $p && $p != /nix/* ]]; then bindir=$p; fi
    done
    bindir=${bindir:-/usr/local/bin}
    ln -sf "$target" "$bindir/$name"
    hash -r
  }

  # 1. Node 24 ------------------------------------------------------------------------------
  if [[ $(node --version 2>/dev/null) != v${node_major}.* ]]; then
    local version dir
    if [[ $(/opt/node$node_major/bin/node --version 2> /dev/null) == v${node_major}.* ]]; then
      dir=/opt/node$node_major # the cloud image ships it; no download needed
    else
      version=$(timeout "$net" curl -fsS https://nodejs.org/dist/index.json |
        python3 -c "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v${node_major}.')))")
      dir=/opt/node-$version
      if [[ ! -x $dir/bin/node ]]; then
        local tmp file=node-$version-linux-x64.tar.xz
        tmp=$(mktemp -d)
        timeout 300 curl -fsS -o "$tmp/$file" "https://nodejs.org/dist/$version/$file"
        timeout "$net" curl -fsS -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$version/SHASUMS256.txt"
        (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
        mkdir -p "$dir"
        tar -xJf "$tmp/$file" -C "$dir" --strip-components=1
        rm -rf "$tmp"
      fi
    fi
    for bin in node npm npx corepack; do first_on_path "$bin" "$dir/bin/$bin"; done
    [[ $(node --version) == v${node_major}.* ]] || { echo "node $node_major installed in $dir but not first on PATH" >&2; exit 1; }
  fi
  echo "node $(node --version)"

  # 2. pnpm ---------------------------------------------------------------------------------
  corepack enable
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout "$net" pnpm --version > /dev/null # corepack fetches pnpm here
  timeout 600 pnpm install --frozen-lockfile --reporter=silent
  echo "pnpm $(pnpm --version), dependencies installed"

  # 3. uv, Python and Locust ----------------------------------------------------------------
  # The load project pins uv exactly (`required-version`), so the image's uv won't do. PyPI's
  # wheel goes into its own venv; nothing touches the system Python.
  local uv_dir=/opt/uv-$uv_version
  if [[ $("$uv_dir/bin/uv" --version 2> /dev/null) != "uv $uv_version"* ]]; then
    rm -rf "$uv_dir"
    timeout 120 python3 -m venv "$uv_dir"
    timeout 300 "$uv_dir/bin/pip" install -q --disable-pip-version-check "uv==$uv_version"
  fi
  [[ $(uv --version 2> /dev/null) == "uv $uv_version"* ]] || first_on_path uv "$uv_dir/bin/uv"
  [[ $(uv --version) == "uv $uv_version"* ]] || { echo "uv $uv_version installed in $uv_dir but not first on PATH" >&2; exit 1; }
  # The image sets UV_NATIVE_TLS (for the proxy's CA), which uv 0.13 renamed; same meaning, no warning.
  if [[ -n ${UV_NATIVE_TLS:-} ]]; then export UV_SYSTEM_CERTS=${UV_SYSTEM_CERTS:-$UV_NATIVE_TLS}; unset UV_NATIVE_TLS; fi
  timeout 300 uv python install --quiet "$python_version" # GitHub release assets; no-op if present
  local versions
  versions=$(cd prototypes/persistence/load && timeout 600 uv sync --locked --managed-python --quiet &&
    uv run --locked --managed-python python -c 'import locust, platform; print(platform.python_version(), locust.__version__)')
  echo "uv $(uv --version | cut -d' ' -f2), Python ${versions% *}, Locust ${versions#* }"

  # 4. Postgres -----------------------------------------------------------------------------
  # PGDG's signing key ships with Ubuntu's postgresql-common, so the only extra host is
  # apt.postgresql.org:443. If the network policy refuses it, keep Ubuntu's Postgres (16).
  export DEBIAN_FRONTEND=noninteractive
  local apt_updated=""
  apt_update() { [[ -n $apt_updated ]] || { timeout "$apt_t" apt-get update -qq; apt_updated=1; }; }
  if [[ ! -x /usr/lib/postgresql/$pg_want/bin/postgres ]]; then
    if [[ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg ]]; then
      apt_update
      timeout "$apt_t" apt-get install -y -qq postgresql-common > /dev/null
    fi
    local pgdg=/etc/apt/sources.list.d/pgdg.sources codename
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
    if timeout 20 curl -fsS -o /dev/null "https://apt.postgresql.org/pub/repos/apt/dists/$codename-pgdg/Release" 2> /dev/null; then
      if [[ ! -f $pgdg ]]; then
        printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: %s\n' \
          "$codename" /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg > "$pgdg"
        apt_updated=""
      fi
      apt_update
      timeout "$apt_t" apt-get install -y -qq "postgresql-$pg_want" > /dev/null
    else
      rm -f "$pgdg" # a source apt can't reach would fail every later apt-get update
      echo "WARNING: apt.postgresql.org:443 is unreachable (the environment's network policy must allow it);" \
        "falling back to Ubuntu's Postgres, which is not the local stack's major ($pg_want)." >&2
      if ! ls /usr/lib/postgresql/*/bin/postgres > /dev/null 2>&1; then
        apt_update
        timeout "$apt_t" apt-get install -y -qq postgresql > /dev/null
      fi
    fi
  fi
  local pg_major other
  pg_major=$(ls /usr/lib/postgresql | sort -n | tail -n 1)
  # One cluster serves the port: stop any other major's cluster that holds it (after an upgrade).
  while read -r other _ other_port _; do
    if [[ $other != "$pg_major" && $other_port == "$port" ]]; then
      pg_ctlcluster "$other" main stop > /dev/null 2>&1 || true
      echo manual > "/etc/postgresql/$other/main/start.conf"
      sed -i -E "s/^#?port = .*/port = $((port + other))/" "/etc/postgresql/$other/main/postgresql.conf"
    fi
  done < <(pg_lsclusters -h)
  if ! pg_lsclusters -h | grep -q "^$pg_major main "; then
    pg_createcluster "$pg_major" main --port "$port" > /dev/null
  fi
  # Installing a new major while an older one holds the port makes apt create its cluster on the
  # next free port (5433); move it to ours.
  local cur_port
  cur_port=$(pg_lsclusters -h | awk -v v="$pg_major" '$1 == v && $2 == "main" { print $3 }')
  if [[ $cur_port != "$port" ]]; then
    pg_ctlcluster "$pg_major" main stop > /dev/null 2>&1 || true
    sed -i -E "s/^#?port = .*/port = $port/" "/etc/postgresql/$pg_major/main/postgresql.conf"
  fi
  pg_ctlcluster "$pg_major" main start > /dev/null 2>&1 || true # already running is fine
  pg_isready -q -h 127.0.0.1 -p "$port"
  echo "postgres $pg_major ($(runuser -u postgres -- psql -p "$port" -tAc 'show server_version'))"

  # 5 + 6. Role, database and .env -----------------------------------------------------------
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
      runuser -u postgres -- psql -p "$port" -q -v ON_ERROR_STOP=1 > /dev/null
    if ! runuser -u postgres -- psql -p "$port" -tAc "select 1 from pg_database where datname = '$db'" | grep -q 1; then
      runuser -u postgres -- createdb -p "$port" -O "$role" "$db"
    fi
    url="postgresql://$role:$password@127.0.0.1:$port/$db"
    touch .env && chmod 600 .env
    sed -i '/^DATABASE_URL=/d' .env
    printf 'DATABASE_URL=%s\n' "$url" >> .env
    psql "$url" -qtAc 'select 1' > /dev/null
    echo "Wrote DATABASE_URL to .env (role $role, database $db)."
  fi
)

# Called on its own, not as an `if` condition: bash ignores `set -e` inside a condition, so a
# failing step would otherwise run on and write a .env that can't connect.
_sp_setup
_sp_rc=$?
if [[ $_sp_rc == 0 ]]; then
  # Sourced: export DATABASE_URL into the caller's shell without echoing it, and make sure the
  # shell finds the tools linked above.
  if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
    hash -r
    _sp_env="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env"
    export DATABASE_URL="$(sed -n -E 's/^DATABASE_URL=(.*)$/\1/p' "$_sp_env" | tail -n 1)"
    unset _sp_env
    echo "DATABASE_URL exported ($(printf %s "$DATABASE_URL" | wc -c) chars)."
  fi
else
  echo "cloud-setup failed" >&2
  [[ ${BASH_SOURCE[0]} != "$0" ]] && return 1 || exit 1
fi
unset -f _sp_setup; unset _sp_rc

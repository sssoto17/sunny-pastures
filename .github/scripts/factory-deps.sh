#!/usr/bin/env bash
# The factory's dependency broker (#635; ADR-0002, area 2, "What the scrub's sandbox protects, and
# the dependency broker"): how a factory run adds a package the issue names at an exact version.
# Claude's Bash runs in Claude Code's subprocess sandbox (the env scrub), which mounts the checkout's
# `pnpm-lock.yaml`, `package.json` and `node_modules/.bin` read-only, among other protected paths,
# and no project setting can lift that. The admin decided (23 Nov 2026) that a run may write exactly
# `node_modules` and `pnpm-lock.yaml` besides what it writes already, so the broker does that one
# write for it:
#
#   serve   factory.yml starts it with sudo, from the checkout, before the Claude step: it runs as
#           root outside Claude's sandbox, and everything it trusts is fixed before Claude can
#           change anything. Into FACTORY_DEPS_OUT (root-owned; Claude, as the runner user, can't
#           write it with Bash or the file tools) it copies the pinned pnpm (the standalone binary
#           for root package.json's packageManager, from Corepack's cache), the pnpm config
#           (pnpm-workspace.yaml, the root package.json, .npmrc), every workspace package's
#           package.json and pnpm-lock.yaml. Then it takes requests until FACTORY_DEPS_TTL seconds
#           (3600) pass. Each one is checked again; no workspace package.json may have changed its
#           dependencies since start-up except the names requested, and pnpm-lock.yaml must be the
#           copy or the broker's own last write, so no URL, git or file dependency, and no locked
#           entry that skips the checks, slips in.
#           Then, as FACTORY_DEPS_USER (the runner user) and for at most 600 s, it runs
#             pnpm --filter ./<dir> add --save-exact [--save-dev] --ignore-scripts --ignore-pnpmfile
#               --config.block-exotic-subdeps=true
#           inside a bubblewrap of its own: the whole filesystem read-only; the checkout and the
#           pnpm store writable; the protected paths below read-only again over the checkout, the
#           config as copied at start-up and an empty file for a missing one; no environment
#           carried in; its own /tmp and PID namespace. A lockfile with a tarball, git or directory
#           source, or a new link, is put back and refused. So the new writes are
#           `pnpm-lock.yaml` and `node_modules` (the root `.bin` included); a workspace package's
#           `package.json` was writable already. `minimumReleaseAge` holds, as the copied config
#           says, and no install script or pnpmfile runs.
#   add     Claude runs it in its sandbox: `add <dir> [--dev] <name@x.y.z>...`, where <dir> is a
#           workspace package (apps/web). It refuses anything but exact versions, hands the request
#           over, waits for the answer and prints pnpm's output.
#
# As root the broker runs only /usr/bin and /bin commands (PATH is reset on its first line) and the
# pnpm it copied, and it never opens a file Claude can change: every read and write in the checkout
# runs as FACTORY_DEPS_USER through setpriv. Requests come in through FACTORY_DEPS, which Claude can
# write; each is moved into FACTORY_DEPS_OUT before it is read (4096 bytes at most), and a link is
# refused. Nothing a request does stops the broker.
#
# Env: FACTORY_DEPS (default $GITHUB_WORKSPACE/../factory-out/deps, inside the hand-off folder
# Claude gets with --add-dir), FACTORY_DEPS_OUT (default
# /srv/factory-deps); serve: FACTORY_DEPS_USER (uid:gid that pnpm runs as; without it, the broker's
# own user), FACTORY_DEPS_STEP_PATH (the step's PATH, to find pnpm), COREPACK_HOME or HOME
# (Corepack's cache), FACTORY_DEPS_TTL (3600), FACTORY_DEPS_POLL (seconds between looks, 1),
# FACTORY_DEPS_BWRAP (/usr/bin/bwrap; tests only); add: FACTORY_DEPS_WAIT (660).
# Exit codes of add: pnpm's (0 added; 124 timed out), 2 refused, 3 no broker or no answer in time.
# Tests: .github/scripts/tests/factory-deps.test.mjs
set -euo pipefail
PATH=/usr/bin:/bin

# The checkout's paths the broker's pnpm never writes: the scrub's protected paths for the launch
# folder (Claude Code 2.1.332) less the two the admin opened, plus .git and pnpm-workspace.yaml.
PROTECTED_DIRS=(.git .github .claude scripts)
PROTECTED_FILES=(package.json pnpm-workspace.yaml .npmrc .yarnrc .yarnrc.yml bunfig.toml .gitmodules
  package-lock.json yarn.lock .env .env.local .env.development .env.development.local .env.test
  .env.test.local .env.production .env.production.local)
CONFIG=(pnpm-workspace.yaml package.json .npmrc)
SPEC='^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
# The package.json fields that decide what gets installed; jq keeps only these when it compares.
DEP_FIELDS='{dependencies, devDependencies, optionalDependencies, peerDependencies,
  peerDependenciesMeta, dependenciesMeta, bundleDependencies, bundledDependencies, overrides,
  resolutions, pnpm, packageManager}'
# Lockfile sources the registry didn't give: none anywhere in the file, and no new `link:` (main's
# lockfile links its own workspace packages).
EXOTIC='tarball:|type: git|directory:'

out=${FACTORY_DEPS_OUT:-/srv/factory-deps}
requests=${FACTORY_DEPS:-${GITHUB_WORKSPACE:-$PWD}/../factory-out/deps}

# Why a request is malformed, or nothing: a workspace folder, prod or dev, 1 to 20 exact versions.
check() {
  local dir=$1 kind=$2 spec
  shift 2
  [[ $dir =~ ^(apps|packages)/[a-z0-9][a-z0-9-]*$ ]] || { echo "not a workspace package folder: $(printf %q "$dir")"; return 1; }
  [[ $kind == prod || $kind == dev ]] || { echo "not prod or dev: $(printf %q "$kind")"; return 1; }
  (($# >= 1 && $# <= 20)) || { echo "name 1 to 20 packages"; return 1; }
  for spec; do
    [[ $spec =~ $SPEC ]] || { echo "not a package at an exact version: $(printf %q "$spec") (name@x.y.z)"; return 1; }
  done
}

# A command as FACTORY_DEPS_USER, never as root: every touch of the checkout goes through this.
as_user() {
  if [[ -n $run_uid ]]; then
    setpriv --reuid "$run_uid" --regid "$run_gid" --clear-groups -- "$@"
  else
    "$@"
  fi
}

# A checkout file's text, read as the user: a regular file only, empty when missing or not one.
user_read() { as_user timeout 10 sh -c '[ -f "$1" ] && [ ! -L "$1" ] && cat -- "$1" || :' sh "$1"; }

text_hash() { sha256sum | cut -d' ' -f1; }

# The dependency fields of a package.json text on stdin, less the names given, as one sorted line.
dep_fields() {
  jq -cS "$DEP_FIELDS"' | reduce $ARGS.positional[] as $n (.; del(.dependencies[$n],
    .devDependencies[$n], .optionalDependencies[$n], .peerDependencies[$n]))
    | with_entries(select(.value != null and .value != {}))' --args "$@" 2>/dev/null || echo unreadable
}

# The pinned pnpm: Corepack's standalone binary for packageManager, else the step's pnpm, whichever
# says that version. Copied, so nothing Claude changes later runs.
find_pnpm() {
  local want=$1 c
  for c in "${COREPACK_HOME:-${HOME:-/nonexistent}/.cache/node/corepack}/v1/pnpm/$want/pnpm-native" \
    "$(PATH=${FACTORY_DEPS_STEP_PATH:-} command -v pnpm 2>/dev/null | xargs -r readlink -f)"; do
    [[ -f $c ]] || continue
    command install -m 0555 "$c" "$out/bin/pnpm"
    # From / and as the user: pnpm writes packageManager's pin into a lockfile it finds.
    [[ $(cd / && as_user "$out/bin/pnpm" --version 2>/dev/null) == "$want" ]] && return 0
    rm -f "$out/bin/pnpm"
  done
  return 1
}

serve() {
  repo=$(pwd -P)
  run_uid="" run_gid=""
  if [[ -n ${FACTORY_DEPS_USER-} ]]; then IFS=: read -r run_uid run_gid <<<"$FACTORY_DEPS_USER"; fi
  bwrap_bin=${FACTORY_DEPS_BWRAP:-/usr/bin/bwrap}
  [[ ! -L $requests ]] || { echo "DEPS not serving: $requests is a link"; return 1; }
  mkdir -p "$out/bin" "$out/config" "$out/ws" "$requests"
  [[ -z $run_uid ]] || chown "$run_uid:$run_gid" "$requests"
  : >"$out/empty"
  local f p want
  for f in "${CONFIG[@]}"; do
    if [[ -f $repo/$f && ! -L $repo/$f ]]; then cp -- "$repo/$f" "$out/config/$f"; else : >"$out/config/$f"; fi
  done
  for p in "$repo"/apps/*/package.json "$repo"/packages/*/package.json; do
    [[ -f $p && ! -L $p ]] || continue
    f=${p#"$repo"/}
    mkdir -p "$out/ws/${f%/package.json}"
    cp -- "$p" "$out/ws/$f"
  done
  # The lockfile as main has it: pnpm must start from this, or from what the broker last wrote.
  if [[ -f $repo/pnpm-lock.yaml && ! -L $repo/pnpm-lock.yaml ]]; then cp -- "$repo/pnpm-lock.yaml" "$out/lock.trusted"; else : >"$out/lock.trusted"; fi
  chmod -R a-w "$out/config" "$out/ws" "$out/empty" "$out/lock.trusted"
  want=$(jq -r '.packageManager // "" | select(startswith("pnpm@")) | ltrimstr("pnpm@") | sub("\\+.*"; "")' \
    "$out/config/package.json" 2>/dev/null) || want=""
  pnpm_ok=true
  [[ -n $want ]] && find_pnpm "$want" || pnpm_ok=false
  store=""
  if $pnpm_ok; then
    store=$(as_user env -i HOME="${HOME:-/nonexistent}" "$out/bin/pnpm" store path \
      --config.manage-package-manager-versions=false 2>/dev/null) || store=""
  fi
  [[ -n $store ]] || pnpm_ok=false
  [[ -z $store ]] || as_user mkdir -p "$store"
  trap 'rm -f -- "$out/ready"' EXIT
  : >"$out/ready"
  echo "DEPS serving $repo with pnpm ${want:-none}: $($pnpm_ok && echo found || echo "not found, so every request is refused")"
  local end=$((SECONDS + ${FACTORY_DEPS_TTL:-3600})) req id
  while ((SECONDS < end)); do
    for req in "$requests"/req.*; do
      [[ -e $req || -L $req ]] || continue
      id=${req##*/req.}
      if [[ $id =~ ^[0-9A-Za-z-]{1,64}$ ]]; then handle "$req" "$id"; else rm -rf -- "$req" || true; fi
    done
    sleep "${FACTORY_DEPS_POLL:-1}"
  done
}

# One request: moved into $out first (where Claude can't swap it), read as one word per line.
handle() {
  local req=$1 id=$2 words=() st
  rm -rf -- "$out/req"
  mv -f -- "$req" "$out/req" 2>/dev/null || return 0
  if [[ -f $out/req && ! -L $out/req ]]; then
    mapfile -t -n 23 words < <(head -c 4096 "$out/req") || true
  fi
  rm -rf -- "$out/req"
  if run_request "${words[@]}" >"$out/res.$id.log" 2>&1; then st=0; else st=$?; fi
  echo "$st" >"$out/res.$id.tmp"
  mv -f -- "$out/res.$id.tmp" "$out/res.$id.status"
  echo "DEPS $id: $(printf '%s ' "${words[@]}" | tr -cd '[:alnum:] @/._~-' | cut -c1-600)-> exit $st"
}

# Every check, then pnpm in its bubblewrap, then the lockfile's sources.
run_request() {
  (($# >= 3)) || { echo "DEPS refused: expected <dir> <prod|dev> <name@x.y.z>..."; return 2; }
  local dir=$1 kind=$2 reason f p spec now names=()
  shift 2
  reason=$(check "$dir" "$kind" "$@") || { echo "DEPS refused: $reason"; return 2; }
  $pnpm_ok || { echo "DEPS refused: the broker found no pnpm binary of the version package.json pins"; return 2; }
  [[ $(as_user realpath -e -- "$repo/$dir/package.json" 2>/dev/null) == "$repo/$dir/package.json" ]] ||
    { echo "DEPS refused: $dir/package.json isn't a file in the checkout"; return 2; }
  # The copies are what pnpm reads; this only says early that the run changed one.
  for f in "${CONFIG[@]}"; do
    [[ $(user_read "$repo/$f" | text_hash) == "$(text_hash <"$out/config/$f")" ]] ||
      { echo "DEPS refused: $f changed since the run began; restore it (git checkout -- $f)"; return 2; }
  done
  # No workspace package.json may have gained or changed a dependency since start-up, other than
  # the names asked for here: pnpm would install it too, past every check above.
  for spec; do names+=("${spec%@*}"); done
  now=$(cd "$repo" && as_user sh -c 'ls -d apps/*/package.json packages/*/package.json 2>/dev/null' | sort) || true
  [[ $now == "$(cd "$out/ws" && ls -d apps/*/package.json packages/*/package.json 2>/dev/null | sort)" ]] ||
    { echo "DEPS refused: the workspace packages changed since the run began"; return 2; }
  for f in $now; do
    if [[ $f == "$dir/package.json" ]]; then
      [[ $(user_read "$repo/$f" | dep_fields "${names[@]}") == "$(dep_fields "${names[@]}" <"$out/ws/$f")" ]]
    else
      [[ $(user_read "$repo/$f" | dep_fields) == "$(dep_fields <"$out/ws/$f")" ]]
    fi || { echo "DEPS refused: $f changed its dependencies since the run began, beyond this request (git checkout -- $f)"; return 2; }
  done
  # A locked entry is reused without the release-age or exotic-source checks, so the lockfile
  # must be the one the broker trusts: main's, or the broker's own last write.
  [[ $(user_read "$repo/pnpm-lock.yaml" | text_hash) == "$(text_hash <"$out/lock.trusted")" ]] ||
    { echo "DEPS refused: pnpm-lock.yaml changed since the broker last wrote it; only the broker writes it (git checkout -- pnpm-lock.yaml)"; return 2; }
  local args=(--die-with-parent --new-session --clearenv --unshare-all --share-net
    --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind "$repo" "$repo")
  for p in "${PROTECTED_DIRS[@]}"; do
    [[ -d $repo/$p && ! -L $repo/$p ]] || { echo "DEPS refused: $p/ is missing from the checkout"; return 2; }
    args+=(--ro-bind "$repo/$p" "$repo/$p")
  done
  for p in "${PROTECTED_FILES[@]}"; do
    if [[ -f $out/config/$p ]]; then
      args+=(--ro-bind "$out/config/$p" "$repo/$p")
    elif [[ -e $repo/$p || -L $repo/$p ]]; then
      args+=(--ro-bind "$repo/$p" "$repo/$p")
    else
      args+=(--ro-bind "$out/empty" "$repo/$p")
    fi
  done
  args+=(--bind "$store" "$store" --setenv HOME /tmp/home --setenv PATH "$out/bin:/usr/bin:/bin"
    --setenv CI true --chdir "$repo")
  # Only a proxy's settings, where the runner has one (GitHub's hosted runners don't).
  for p in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy NODE_EXTRA_CA_CERTS; do
    [[ -z ${!p-} ]] || args+=(--setenv "$p" "${!p}")
  done
  local save=(--save-exact) st=0
  [[ $kind == prod ]] || save+=(--save-dev)
  rm -f -- "$out/package.before"
  user_read "$repo/$dir/package.json" >"$out/package.before"
  as_user timeout 600 "$bwrap_bin" "${args[@]}" -- "$out/bin/pnpm" --filter "./$dir" add "${save[@]}" \
    --ignore-scripts --ignore-pnpmfile --config.block-exotic-subdeps=true \
    --config.manage-package-manager-versions=false --store-dir "$store" -- "$@" || st=$?
  # A source the registry didn't give is refused, whatever pnpm made of it.
  if ((st == 0)) && { user_read "$repo/pnpm-lock.yaml" | grep -qE "$EXOTIC" ||
    comm -13 <(sort "$out/lock.trusted") <(user_read "$repo/pnpm-lock.yaml" | sort) | grep -q 'link:'; }; then
    as_user cp -- "$out/lock.trusted" "$repo/pnpm-lock.yaml"
    as_user cp -- "$out/package.before" "$repo/$dir/package.json"
    echo "DEPS refused: the lockfile gained a tarball, git, directory or link source; both files are put back"
    return 2
  fi
  if ((st == 0)); then
    chmod u+w "$out/ws/$dir/package.json"
    user_read "$repo/$dir/package.json" >"$out/ws/$dir/package.json"
    chmod a-w "$out/ws/$dir/package.json"
    rm -f -- "$out/lock.trusted"
    user_read "$repo/pnpm-lock.yaml" >"$out/lock.trusted"
    chmod a-w "$out/lock.trusted"
  fi
  return "$st"
}

add() {
  local dir=${1-} kind=prod reason id st waited=0
  (($#)) && shift
  if [[ ${1-} == --dev ]]; then kind=dev; shift; fi
  reason=$(check "$dir" "$kind" "$@") || { echo "DEPS refused: $reason"; return 2; }
  [[ -f $out/ready ]] || { echo "DEPS: no dependency broker is running ($out/ready is missing)"; return 3; }
  id="$(date +%s)-$$-$RANDOM"
  printf '%s\n' "$dir" "$kind" "$@" >"$requests/.tmp.$id"
  mv -f -- "$requests/.tmp.$id" "$requests/req.$id"
  while [[ ! -f $out/res.$id.status ]]; do
    ((waited < ${FACTORY_DEPS_WAIT:-660} * 10)) || { echo "DEPS: no answer from the broker in time"; return 3; }
    sleep 0.1
    waited=$((waited + 1))
  done
  cat "$out/res.$id.log"
  st=$(cat "$out/res.$id.status")
  return "$st"
}

main() {
  case ${1-} in
  # exit, not return: bash reads a script as it runs, so nothing after serve may be read again.
  serve) mkdir -p "$out"; serve >>"$out/serve.log" 2>&1; exit ;;
  add) shift; add "$@" ;;
  *) echo "usage: factory-deps.sh serve | add <dir> [--dev] <name@x.y.z>..." >&2; return 2 ;;
  esac
}

main "$@"
exit

#!/usr/bin/env bash
# The factory's dependency broker (#635; ADR-0002, area 2, "Dependencies in a factory run"): how a
# factory run adds a package the issue names at an exact version. Claude's Bash runs in Claude
# Code's subprocess sandbox (the env scrub), which mounts the checkout's `pnpm-lock.yaml`,
# `package.json` and `node_modules/.bin` read-only, among other protected paths, and no project
# setting can lift that. The admin decided (23 Nov 2026) that a run may write exactly
# `node_modules` and `pnpm-lock.yaml` besides what it writes already, so the broker does that one
# write for it:
#
#   serve   factory.yml starts it in the background, from the checkout, before the Claude step, so
#           it runs outside Claude's sandbox. It notes the hashes of the pnpm config
#           (pnpm-workspace.yaml, package.json, .npmrc), then takes requests from FACTORY_DEPS until
#           FACTORY_DEPS_TTL seconds (3600) pass. Each one is checked again, then runs
#             pnpm --filter ./<dir> add --save-exact [--save-dev] --ignore-scripts --ignore-pnpmfile
#           inside a bubblewrap of its own: the whole filesystem read-only, the checkout and the
#           pnpm store (and Corepack's cache) writable, every path below read-only again over the
#           checkout (an empty one in place of a missing file), no environment carried in, its own /tmp and PID namespace. So the new writes
#           are `pnpm-lock.yaml` and `node_modules` (the root `.bin` included); a workspace
#           package's `package.json` was writable already. pnpm-workspace.yaml must be unchanged,
#           so `minimumReleaseAge` holds, and no install script or pnpmfile runs.
#   add     Claude runs it in its sandbox: `add <dir> [--dev] <name@x.y.z>...`, where <dir> is a
#           workspace package (apps/web). It refuses anything but exact versions, hands the request
#           over, waits up to FACTORY_DEPS_WAIT seconds (600) and exits with pnpm's exit code after
#           printing its output; 2 is a refusal, 3 no broker.
#
# Requests go in FACTORY_DEPS (default $RUNNER_TEMP/factory-deps), which Claude can write; answers
# and the broker's own log in FACTORY_DEPS_OUT (default /srv/factory-deps), which factory.yml makes
# outside every folder Claude's sandbox can write, so the broker never writes through a link that
# Claude planted. A request is moved there before it is read, and a link is refused.
# Tests: .github/scripts/tests/factory-deps.test.mjs
set -euo pipefail

# The checkout's paths the broker's pnpm never writes: the scrub's protected paths for the launch
# folder less the two the admin opened, plus .git and pnpm-workspace.yaml.
PROTECTED_DIRS=(.git .github .claude scripts)
PROTECTED_FILES=(package.json pnpm-workspace.yaml .npmrc .yarnrc .yarnrc.yml bunfig.toml .gitmodules
  package-lock.json yarn.lock .env .env.local .env.development .env.development.local .env.test
  .env.test.local .env.production .env.production.local)
CONFIG=(pnpm-workspace.yaml package.json .npmrc)
SPEC='^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'

out=${FACTORY_DEPS_OUT:-/srv/factory-deps}
requests=${FACTORY_DEPS:-${RUNNER_TEMP:-/nonexistent}/factory-deps}

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

# A file's hash; a missing file and an empty one are the same (Claude Code creates the protected
# files it doesn't find, empty, when it starts, after the broker's snapshot).
sum() { if [[ -s $1 ]]; then sha256sum <"$1" | cut -d' ' -f1; else echo empty; fi; }

serve() {
  root=$(pwd -P)
  mkdir -p "$requests" "$out"
  store=$(pnpm store path)
  mkdir -p "$store"
  corepack=${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}
  path="$(dirname "$(command -v pnpm)"):$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin"
  declare -gA sums=()
  local f req id
  for f in "${CONFIG[@]}"; do sums[$f]=$(sum "$root/$f"); done
  : >"$out/empty"
  : >"$out/ready"
  echo "DEPS serving $root"
  local end=$((SECONDS + ${FACTORY_DEPS_TTL:-3600}))
  while ((SECONDS < end)); do
    for req in "$requests"/req.*; do
      [[ -e $req || -L $req ]] || continue
      id=${req##*/req.}
      if [[ $id =~ ^[0-9A-Za-z-]{1,64}$ ]]; then handle "$req" "$id"; else rm -f -- "$req"; fi
    done
    sleep "${FACTORY_DEPS_POLL:-1}"
  done
}

handle() {
  local req=$1 id=$2 words=() st
  mv -f -- "$req" "$out/req"
  if [[ -f $out/req && ! -L $out/req ]]; then
    read -r -a words < <(head -c 4096 "$out/req" | head -n1) || true
  fi
  rm -f -- "$out/req"
  if install "${words[@]}" >"$out/res.$id.log" 2>&1; then st=0; else st=$?; fi
  echo "$st" >"$out/res.$id.tmp"
  mv -f "$out/res.$id.tmp" "$out/res.$id.status"
  echo "DEPS $id: $(printf '%s ' "${words[@]:0:22}" | tr -cd '[:alnum:] @/._~-' | cut -c1-600)-> exit $st"
}

install() {
  (($# >= 3)) || { echo "DEPS refused: expected <dir> <prod|dev> <name@x.y.z>..."; return 2; }
  local dir=$1 kind=$2 reason f p
  shift 2
  reason=$(check "$dir" "$kind" "$@") || { echo "DEPS refused: $reason"; return 2; }
  [[ -f $root/$dir/package.json && ! -L $root/$dir && ! -L $root/$dir/package.json ]] ||
    { echo "DEPS refused: $dir/package.json isn't a file in the checkout"; return 2; }
  for f in "${CONFIG[@]}"; do
    [[ $(sum "$root/$f") == "${sums[$f]}" ]] ||
      { echo "DEPS refused: $f changed since the run began; restore it (git checkout -- $f)"; return 2; }
  done
  local args=(--die-with-parent --new-session --clearenv --unshare-all --share-net
    --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind "$root" "$root")
  # Each protected folder read-only (the checkout always has them); each protected file too, or,
  # where there is none, an empty read-only one, so none can be created.
  for p in "${PROTECTED_DIRS[@]}"; do
    [[ -d $root/$p && ! -L $root/$p ]] || { echo "DEPS refused: $p/ is missing from the checkout"; return 2; }
    args+=(--ro-bind "$root/$p" "$root/$p")
  done
  for p in "${PROTECTED_FILES[@]}"; do
    if [[ -e $root/$p || -L $root/$p ]]; then args+=(--ro-bind "$root/$p" "$root/$p"); else args+=(--ro-bind "$out/empty" "$root/$p"); fi
  done
  args+=(--bind "$store" "$store")
  [[ ! -d $corepack ]] || args+=(--bind "$corepack" "$corepack")
  args+=(--setenv HOME /tmp/home --setenv PATH "$path" --setenv COREPACK_HOME "$corepack"
    --setenv COREPACK_ENABLE_DOWNLOAD_PROMPT 0 --setenv CI true --chdir "$root")
  # Only a proxy's settings, where the runner has one (GitHub's hosted runners don't).
  for p in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy NODE_EXTRA_CA_CERTS; do
    [[ -z ${!p-} ]] || args+=(--setenv "$p" "${!p}")
  done
  local save=(--save-exact)
  [[ $kind == prod ]] || save+=(--save-dev)
  # The pnpm found at start-up runs, never one it would download for packageManager.
  bwrap "${args[@]}" -- pnpm --filter "./$dir" add "${save[@]}" --ignore-scripts --ignore-pnpmfile \
    --config.manage-package-manager-versions=false --store-dir "$store" -- "$@"
}

add() {
  local dir=${1-} kind=prod reason id st waited=0
  (($#)) && shift
  if [[ ${1-} == --dev ]]; then kind=dev; shift; fi
  reason=$(check "$dir" "$kind" "$@") || { echo "DEPS refused: $reason"; return 2; }
  [[ -f $out/ready ]] || { echo "DEPS: no dependency broker is running ($out/ready is missing)"; return 3; }
  id="$(date +%s)-$$-$RANDOM"
  printf '%s\n' "$dir $kind $*" >"$requests/.tmp.$id"
  mv -f "$requests/.tmp.$id" "$requests/req.$id"
  while [[ ! -f $out/res.$id.status ]]; do
    ((waited < ${FACTORY_DEPS_WAIT:-600} * 10)) || { echo "DEPS: no answer from the broker in time"; return 3; }
    sleep 0.1
    waited=$((waited + 1))
  done
  cat "$out/res.$id.log"
  st=$(cat "$out/res.$id.status")
  return "$st"
}

main() {
  case ${1-} in
  serve) mkdir -p "$out"; serve >>"$out/serve.log" 2>&1 ;;
  add) shift; add "$@" ;;
  *) echo "usage: factory-deps.sh serve | add <dir> [--dev] <name@x.y.z>..." >&2; return 2 ;;
  esac
}

main "$@"
exit

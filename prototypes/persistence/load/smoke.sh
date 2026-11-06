#!/usr/bin/env bash
# One load run against one store (#10): start the spike server with SPIKE_CLOCK=1, seed one farm per
# user, run Locust headless, read the storage report, stop the server. Writes into OUT:
#   server.csv           one row per response (Server-Timing numbers), from the server
#   locust.json          Locust's final stats, with response-time histograms (summarize.py reads it)
#   locust_*.csv         Locust's stats history, failures and exceptions. locust_stats.csv is the last
#                        periodic snapshot (Locust doesn't rewrite it at shutdown), so it can trail
#                        locust.json by about a second of requests.
#   seed.json, storage-before.json, storage-after.json
#   window.json          the measured window in epoch ms (after WARMUP_S), for cutting server.csv
# Usage: load/smoke.sh <STORE> [SNAPSHOT_N]
#   env: USERS=50 SPAWN_RATE=10 RUN_TIME=1m WARMUP_S=0 ACTIONS=1000 PORT=4010 OUT=load/results/<label>-<time>
#        STORE_SCHEMA (default store_<name>): the matrix runner (src/matrix.ts) gives each run its own.
#   RUN_TIME includes the warm-up: Locust's stats are reset WARMUP_S seconds in.
# Needs `uv sync --locked` in load/ and DATABASE_URL in the environment or the repo .env (never printed).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # prototypes/persistence

store=${1:?usage: load/smoke.sh <STORE> [SNAPSHOT_N]}; n=${2:-}
label=$store$n
users=${USERS:-50}; spawn=${SPAWN_RATE:-10}; run_time=${RUN_TIME:-1m}; actions=${ACTIONS:-1000}
warmup=${WARMUP_S:-0}
port=${PORT:-4010}; base=http://127.0.0.1:$port
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out=${OUT:-load/results/$label-$stamp}
prefix=$(echo "load-$label-$stamp" | tr 'A-Z' 'a-z')
mkdir -p "$out"; out=$(cd "$out" && pwd)

env_file=()
[[ -z ${DATABASE_URL:-} && -f ../../.env ]] && env_file=(--env-file=../../.env)
snapshot=()
[[ -n $n ]] && snapshot=(SNAPSHOT_N="$n")
env STORE="$store" "${snapshot[@]}" SPIKE_CLOCK=1 PORT="$port" TIMING_CSV="$out/server.csv" \
  node "${env_file[@]}" src/server.ts > "$out/server.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null || true' EXIT
for _ in $(seq 100); do curl -fs -o /dev/null "$base/spike/storage" && break; sleep 0.1; done

echo "== $label: seeding $users farms ($prefix-<i>, ~$actions actions each)"
start=$(date +%s)
curl -fsS -X POST "$base/spike/seed" -d "{\"prefix\":\"$prefix\",\"players\":$users,\"actions\":$actions}" > "$out/seed.json"
echo "   seeded in $(( $(date +%s) - start )) s"
curl -fsS "$base/spike/storage" > "$out/storage-before.json"

echo "== $label: Locust, $users users, $run_time (the first ${warmup} s are warm-up)"
(cd load && FARM_PREFIX=$prefix WARMUP_S=$warmup WINDOW_FILE=$out/window.json uv run --locked locust -f locustfile.py --headless --only-summary \
  -u "$users" -r "$spawn" -t "$run_time" --host "$base" --csv "$out/locust" --json-file "$out/locust") || rc=$?
# Locust exits 1 when any request failed: that is a result, not a harness error.
if (( ${rc:-0} > 1 )) || [[ ! -s $out/locust.json ]]; then echo "locust failed (exit ${rc:-0})" >&2; exit 1; fi

curl -fsS "$base/spike/storage" > "$out/storage-after.json"
echo "== $label: results in $out"

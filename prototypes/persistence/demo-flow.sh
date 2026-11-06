#!/usr/bin/env bash
# The #5 curl flow, unchanged, against one store variant; then the stateAt demo.
# Usage: prototypes/persistence/demo-flow.sh <STORE> [SNAPSHOT_N]   (PORT=4007; DATABASE_URL from the repo .env, never printed)
# Takes about 2 min of real time per run (the wheat timer).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
store=$1; n=${2:-}
label=$store$n; farm=demo-7-$(echo "$label" | tr A-Z a-z)-$(date +%H%M%S)
B=localhost:4007
start() {
  if [[ -n $n ]]; then STORE=$store SNAPSHOT_N=$n PORT=4007 node --env-file=../../.env src/server.ts & else STORE=$store PORT=4007 node --env-file=../../.env src/server.ts & fi
  pid=$!
  for _ in $(seq 50); do curl -s -o /dev/null $B/farms/x && return; sleep 0.1; done
}
stop() { kill $pid; wait $pid 2>/dev/null; }
get() { echo "\$ curl -s $B/farms/$farm"; curl -s $B/farms/$farm; echo; }
post() { echo "\$ curl -s -X POST $B/farms/$farm/actions -d '$1'"; curl -s -w ' [%{http_code}]' -X POST $B/farms/$farm/actions -d "$1"; echo; }
at() { echo "\$ curl -s $B/farms/$farm/at/$1    # $2"; curl -s -w ' [%{http_code}]' $B/farms/$farm/at/$1; echo; }
ms() { date +%s%3N; }

echo "=== store $label, farm $farm"
start
get
t_before=$(ms); echo "# $(date +%T) plant"
post '{"action":{"type":"plant","plot":0},"expectedSeq":0,"idempotencyKey":"plant-1"}'
t_planted=$(ms)
echo "# harvest too early: refused, no seq used"
post '{"action":{"type":"harvest","plot":0},"expectedSeq":1,"idempotencyKey":"harvest-early"}'
sleep 125
echo "# $(date +%T), after 2 min: GET advances in memory and writes nothing"
get
t_ripe=$(ms)
post '{"action":{"type":"harvest","plot":0},"expectedSeq":1,"idempotencyKey":"harvest-1"}'
echo "# before restart"; get
stop; echo "# server stopped: $(curl -s -o /dev/null -w '%{http_code}' $B/farms/$farm || true) (000 = connection refused), started again"
start
echo "# after restart: same seq and hash"; get
echo "# resend harvest-1: the plot is empty now; the first answer comes back"
post '{"action":{"type":"harvest","plot":0},"expectedSeq":1,"idempotencyKey":"harvest-1"}'
echo "# resend plant-1"
post '{"action":{"type":"plant","plot":0},"expectedSeq":0,"idempotencyKey":"plant-1"}'
echo "# resends wrote nothing"; get
echo "## stateAt"
at $((t_before - 1)) "just before the plant: the new farm (compare the first GET's hash)"
at $((t_planted + 60000)) "1 min after the plant: growing, no wheat"
at $t_ripe "ripe, before the harvest: ready, no wheat (compare the 2-min GET's hash)"
at $(ms) "now: the current farm (compare the last GET's hash)"
stop

#!/usr/bin/env bash
# One load run (#388; ADR-0001, "Method"), inside the load devcontainer (ADR-0009), from the repo
# root, after `pnpm db:start` and `pnpm --dir apps/web build`:
#   tools/load/run.sh <label> <users> <run time> [stress]
#   e.g. tools/load/run.sh r1-u200 200 6m        tools/load/run.sh stress-u200 200 3m stress
#   tools/load/run.sh concurrency <pairs> -- concurrency     the harvest-and-harvest pairs instead
# The run time includes the 1 min warm-up (WARMUP_S, default 60). Each run starts from an empty
# database (`pnpm db:reset`), as each spike run had a schema of its own; then `next start`,
# sign-ups (prepare.py), seeding (seed.mjs), Locust headless, the lost-update check and a count of
# the server's errors. Writes into docs/load/m3/<label>/ (committed):
#   locust.json        Locust's final stats with histograms, measured window only
#   window.json        the measured window, epoch ms
#   server_timing.csv  the Server-Timing histograms, measured window only (results.py)
#   verify.json        seed.mjs verify: lost updates, gaps, unanswered commits (whole run)
#   errors.json        the server log's UNSAFE_TRANSACTION errors and error lines (whole run)
#   concurrency.json   the pairs' statuses and collisions (concurrency mode, instead of the first 3)
# and the raw request log and tokens into $LOAD_WORK/<label>/, outside the repo. Prints no secret.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

label=${1:?usage: run.sh <label> <users> <run time> [stress]}
users=${2:?users}
run_time=${3:?run time}
mode=${4:-}
warmup=${WARMUP_S:-60}
port=${PORT:-3100}
base=http://127.0.0.1:$port
out=docs/load/m3/$label
work=${LOAD_WORK:-$HOME/load-work}/$label
# The venv lives outside the repo, so `eslint .` doesn't read the packages' own JS.
export UV_PROJECT_ENVIRONMENT=${UV_PROJECT_ENVIRONMENT:-$HOME/.cache/sunny-pastures-load/venv}
uv=(uv run --locked --project "$PWD/tools/load")
mkdir -p "$out" "$work"

active=$((users * 4 / 5))
returners=$((users - active))
visits=10
no_wait=0
if [[ $mode == stress ]]; then
	visits=2
	no_wait=1
fi

echo "== $label: reset the database"
pnpm --silent db:reset >/dev/null
pnpm --silent db:env >/dev/null

echo "== $label: next start on $base"
(
	set -a
	. ./.env
	set +a
	# Keep-alive past the longest client wait (30 s), as the spike's server did (ADR-0001, "Method"):
	# with Node's 5 s default the server closes a connection a waiting player then reuses.
	NEXT_TELEMETRY_DISABLED=1 exec pnpm --dir apps/web exec next start --port "$port" \
		--hostname 127.0.0.1 --keepAliveTimeout 65000
) >"$work/server.log" 2>&1 &
server=$!
trap 'pkill -P $server 2>/dev/null; kill $server 2>/dev/null; wait $server 2>/dev/null || true' EXIT
for _ in $(seq 120); do curl -fs -o /dev/null "$base/api/health" && break; sleep 0.5; done
curl -fs -o /dev/null "$base/api/health"

if [[ $mode == concurrency ]]; then
	echo "== $label: sign up and seed $users pair farms, then fire the pairs"
	"${uv[@]}" python tools/load/prepare.py "$work" --pairs "$users"
	node tools/load/seed.mjs seed "$work/plan.json"
	(cd tools/load && "${uv[@]}" python concurrency.py "$work" "$base" "$OLDPWD/$out")
else
	echo "== $label: sign up $active active and $((returners * visits)) returning players, then seed"
	"${uv[@]}" python tools/load/prepare.py "$work" --active "$active" --returning $((returners * visits))
	node tools/load/seed.mjs seed "$work/plan.json"

	echo "== $label: Locust, $users users, $run_time (the first $warmup s are warm-up)"
	rc=0
	PLAYERS=$work/players.json RETURNERS=$returners REQUEST_LOG=$work/requests.csv WINDOW_FILE=$out/window.json \
		WARMUP_S=$warmup NO_WAIT=$no_wait "${uv[@]}" locust -f tools/load/locustfile.py --headless \
		--only-summary -u "$users" -r 10 -t "$run_time" --host "$base" --json-file "$out/locust" || rc=$?
	# Locust exits 1 when any request failed: a result, not a harness error.
	if ((rc > 1)) || [[ ! -s $out/locust.json ]]; then
		echo "locust failed (exit $rc)" >&2
		exit 1
	fi
fi

echo "== $label: checks"
node tools/load/seed.mjs verify "$work/plan.json" "$work/requests.csv" >"$out/verify.json" || true
cat "$out/verify.json"
unsafe=$(grep -c UNSAFE_TRANSACTION "$work/server.log" || true)
errors=$(grep -c -i -E '^\s*(Error|error:)' "$work/server.log" || true)
printf '{"unsafeTransaction":%d,"errorLines":%d}\n' "$unsafe" "$errors" | tee "$out/errors.json"
if [[ $mode != concurrency ]]; then
	"${uv[@]}" python tools/load/results.py run "$out" "$work/requests.csv"
fi
# The repo's Prettier check covers JSON, result files included.
pnpm --silent exec prettier --write --log-level warn "$out"/*.json
echo "== $label: done"

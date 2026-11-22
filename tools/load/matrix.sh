#!/usr/bin/env bash
# The whole M3 load run (#388; ADR-0001, "Method"), resumable: every run whose results are already
# in docs/load/m3/<label>/ is skipped. Inside the load devcontainer, from the repo root, after
# `pnpm db:start` and `pnpm --dir apps/web build`:
#   tools/load/matrix.sh
# Order as in the spike: three rounds of 50 and 200 players (1 min warm-up + 5 min measured), then
# the stress run (200 players, no wait, 1 min warm-up + 2 min measured), then the 1,000
# harvest-and-harvest pairs. machine.json records where it ran.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
out=docs/load/m3
mkdir -p "$out"

if [[ ! -f $out/machine.json ]]; then
	export UV_PROJECT_ENVIRONMENT=${UV_PROJECT_ENVIRONMENT:-$HOME/.cache/sunny-pastures-load/venv}
	project=$(sed -n -E 's/^project_id = "([^"]+)"/\1/p' supabase/config.toml)
	postgres=$(docker exec "supabase_db_$project" postgres --version)
	locust=$(uv run --locked --project tools/load locust --version 2>/dev/null | cut -d' ' -f1-2)
	cat >"$out/machine.json" <<JSON
{
	"cpu": "$(sed -n 's/^model name\s*: //p' /proc/cpuinfo | head -n 1)",
	"vcpus": $(nproc),
	"memGiB": $(awk '/MemTotal/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo),
	"kernel": "$(uname -r)",
	"container": "$(. /etc/os-release && echo "$PRETTY_NAME")",
	"docker": "$(docker version --format '{{.Server.Version}}')",
	"postgres": "$postgres (supabase_db container)",
	"node": "$(node --version)",
	"python": "$(uv run --locked --project tools/load python --version)",
	"uv": "$(uv --version)",
	"locust": "$locust",
	"recordedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
	pnpm --silent exec prettier --write --log-level warn "$out/machine.json"
fi

# A run is done once its last output is written: the histograms, or the concurrency counts.
done_run() { [[ -f $out/$1/errors.json && ( -f $out/$1/offline_return.csv || -f $out/$1/concurrency.json ) ]]; }
for round in 1 2 3; do
	for users in 50 200; do
		done_run "r$round-u$users" || tools/load/run.sh "r$round-u$users" "$users" 6m
	done
done
done_run stress-u200 || tools/load/run.sh stress-u200 200 3m stress
done_run concurrency || tools/load/run.sh concurrency 1000 -- concurrency
echo "matrix: every run done"

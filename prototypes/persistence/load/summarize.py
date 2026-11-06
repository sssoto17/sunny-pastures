"""Summarises one or more run folders from smoke.sh (stdlib only).

    uv run python summarize.py ../../../docs/spikes/persistence/smoke/A ../../../docs/spikes/persistence/smoke/B25

Prints, per run: Locust's requests, failures, p50 and p95 per request name, and the server's
Server-Timing breakdown (load, sim, commit, total; p50 and p95 in ms) per route and status.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile, so the number is one that was measured."""
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * p // 100))  # ceil(n * p / 100)
    return ordered[int(rank) - 1]


def histogram_percentile(hist: dict[int, int], p: float) -> int:
    """Nearest-rank percentile over Locust's histogram {rounded ms: count}."""
    total = sum(hist.values())
    rank = max(1, -(-total * p // 100))
    seen = 0
    for ms in sorted(hist):
        seen += hist[ms]
        if seen >= rank:
            return ms
    raise ValueError("empty histogram")


def locust(run: Path) -> None:
    """From locust.json: Locust's final stats (its CSV is a periodic snapshot that can trail)."""
    entries = json.loads((run / "locust.json").read_text())
    print("| Request | Requests | Failures | p50 (ms) | p95 (ms) |\n|---|---:|---:|---:|---:|")
    merged: dict[int, int] = defaultdict(int)
    for e in sorted(entries, key=lambda e: e["name"]):
        hist = {int(ms): n for ms, n in e["response_times"].items()}
        for ms, n in hist.items():
            merged[ms] += n
        print(f"| {e['name']} | {e['num_requests']} | {e['num_failures']} "
              f"| {histogram_percentile(hist, 50)} | {histogram_percentile(hist, 95)} |")
    requests = sum(e["num_requests"] for e in entries)
    failures = sum(e["num_failures"] for e in entries)
    print(f"| **All** | {requests} | {failures} | {histogram_percentile(merged, 50)} | {histogram_percentile(merged, 95)} |")


def server(run: Path) -> None:
    groups: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    with open(run / "server.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row["route"] in ("seed", "storage"):
                continue  # harness calls, not the measured traffic
            key = (f"{row['method']} {row['route']}", row["status"])
            for col in ("loadMs", "simMs", "commitMs", "totalMs"):
                groups[key][col].append(float(row[col]))
    print("| Route | Status | n | load p50/p95 | sim p50/p95 | commit p50/p95 | total p50/p95 |")
    print("|---|---|---:|---:|---:|---:|---:|")
    for (route, status), cols in sorted(groups.items()):
        cells = [f"{percentile(v, 50):.2f} / {percentile(v, 95):.2f}" for v in cols.values()]
        print(f"| {route} | {status} | {len(cols['totalMs'])} | {' | '.join(cells)} |")


def storage(run: Path) -> None:
    before = json.loads((run / "storage-before.json").read_text())
    after = json.loads((run / "storage-after.json").read_text())
    print(f"Storage ({after['schema']}): {before['bytes']:,} → {after['bytes']:,} bytes; rows "
          + ", ".join(f"{t} {before['tables'].get(t, {}).get('rows', 0):,} → {v['rows']:,}"
                      for t, v in after["tables"].items()))


for arg in sys.argv[1:]:
    run = Path(arg)
    print(f"\n### {run.name}\n")
    locust(run)
    print()
    server(run)
    print()
    storage(run)

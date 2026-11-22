"""The M3 load run's numbers (#388), with the definitions of ADR-0001's Method and MUST-13.8-13.10.

    uv run --locked python results.py run <run dir> <requests.csv>   one run's server_timing.csv
    uv run --locked python results.py report [docs/load/m3]          results.csv and the tables

`run` cuts a run's request log to its measured window (window.json) and writes the Server-Timing
phases as histograms at 0.1 ms: one row per (request name, status, tail99, phase, ms) with a count.
`tail99` marks requests whose farm had a 99-action replay tail: the seq the server loaded, mod 100
(B100), is 99, rebuilt from the seeded seq plus the accepted actions as each response reports them.

`report` pools runs as MUST-13.10 says: Locust's histograms of the three normal runs per player
count (client time, which decides MUST-13.8), the server's phases over the same runs, and the
worst case (MUST-13.9) over every normal run. The stress run is reported on its own, not judged.
Percentiles are nearest-rank, so each is a time that was measured.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

PHASES = ("load", "sim", "commit", "total")
Hist = dict[float, int]


def percentile(hist: Hist, p: float) -> float | None:
    total = sum(hist.values())
    if total == 0:
        return None
    rank = max(1, -(-total * p // 100))
    seen = 0
    for ms in sorted(hist):
        seen += hist[ms]
        if seen >= rank:
            return ms
    raise AssertionError("unreachable")


def merge(into: Hist, hist: Hist) -> None:
    for ms, n in hist.items():
        into[ms] = into.get(ms, 0) + n


def run(out: Path, requests_csv: Path) -> None:
    window = json.loads((out / "window.json").read_text())
    start, end = window["measuredFrom"], window["measuredTo"]
    counts: dict[tuple, int] = defaultdict(int)
    with open(requests_csv, newline="") as f:
        for row in csv.DictReader(f):
            if not start <= int(row["t"]) <= end:
                continue
            tail99 = int(row["seq"]) % 100 == 99
            for phase in PHASES:
                if row[phase]:
                    counts[(row["name"], row["status"], tail99, phase, round(float(row[phase]), 1))] += 1
    with open(out / "server_timing.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "status", "tail99", "phase", "ms", "count"])
        for key in sorted(counts):
            w.writerow([*key, counts[key]])


def locust_hist(run_dir: Path, method: str) -> tuple[Hist, int, int, float]:
    """Pooled client histogram of `method` requests: (hist, requests, failures, seconds)."""
    hist: Hist = {}
    requests = failures = 0
    seconds = 0.0
    for e in json.loads((run_dir / "locust.json").read_text()):
        if method and e["method"] != method:
            continue
        merge(hist, {float(ms): n for ms, n in e["response_times"].items()})
        requests += e["num_requests"]
        failures += e["num_failures"]
        seconds = max(seconds, e["last_request_timestamp"] - e["start_time"])
    return hist, requests, failures, seconds


def server_hist(run_dir: Path, phase: str, *, post_ok: bool = False, tail99: bool = False) -> Hist:
    hist: Hist = {}
    with open(run_dir / "server_timing.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row["phase"] != phase:
                continue
            if post_ok and not (row["name"].startswith("POST") and row["status"] == "200"):
                continue
            if tail99 and row["tail99"] != "True":
                continue
            merge(hist, {float(row["ms"]): int(row["count"])})
    return hist


def summarise(runs: list[Path]) -> dict:
    post: Hist = {}
    every: Hist = {}
    ret: Hist = {}
    phases = {p: {} for p in PHASES}
    tail: Hist = {}
    requests = failures = 0
    seconds = 0.0
    lost = gaps = unsafe = 0
    for r in runs:
        merge(post, locust_hist(r, "POST")[0])
        h, n, fails, s = locust_hist(r, "")
        merge(every, h)
        requests, failures, seconds = requests + n, failures + fails, seconds + s
        for e in json.loads((r / "locust.json").read_text()):
            if e["name"].endswith("[return]"):
                merge(ret, {float(ms): c for ms, c in e["response_times"].items()})
        for p in PHASES:
            merge(phases[p], server_hist(r, p, post_ok=True))
        merge(tail, server_hist(r, "load", tail99=True))
        verify = json.loads((r / "verify.json").read_text())
        lost, gaps = lost + verify["lostUpdates"], gaps + verify["gaps"] + verify["mismatched"]
        unsafe += json.loads((r / "errors.json").read_text())["unsafeTransaction"]
    return {
        "runs": len(runs),
        "requests": requests,
        "failures": failures,
        "rps": round(requests / seconds, 1) if seconds else None,
        "post_n": sum(post.values()),
        "post_p50": percentile(post, 50),
        "post_p95": percentile(post, 95),
        "post_p99": percentile(post, 99),
        "all_p95": percentile(every, 95),
        "return_p95": percentile(ret, 95),
        "return_n": sum(ret.values()),
        **{f"server_{p}_p50": percentile(phases[p], 50) for p in PHASES},
        **{f"server_{p}_p95": percentile(phases[p], 95) for p in PHASES},
        "tail99_load_p95": percentile(tail, 95),
        "tail99_n": sum(tail.values()),
        "lost_updates": lost,
        "gaps": gaps,
        "unsafe_transaction": unsafe,
    }


def report(root: Path) -> None:
    groups = {
        "u50 (3 runs)": sorted(root.glob("r?-u50")),
        "u200 (3 runs)": sorted(root.glob("r?-u200")),
        "every normal run": sorted(root.glob("r?-u*")),
        "stress-u200": [root / "stress-u200"],
    }
    groups.update({d.name: [d] for d in sorted(root.glob("r?-u*"))})
    rows = [{"group": name, **summarise(runs)} for name, runs in groups.items() if runs and runs[0].exists()]
    with open(root / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    for row in rows:
        print(json.dumps(row))


if __name__ == "__main__":
    if sys.argv[1:2] == ["run"]:
        run(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1:2] == ["report"]:
        report(Path(sys.argv[2] if len(sys.argv) > 2 else "docs/load/m3"))
    else:
        raise SystemExit(__doc__)

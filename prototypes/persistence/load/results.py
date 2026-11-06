"""ADR-0001's results from the load matrix (#11). Stdlib only.

    uv run --locked python results.py [matrix folder] [out folder]

Defaults: ../../../docs/spikes/persistence/matrix in, ../../../docs/spikes/persistence out. Writes
results.csv (one row per configuration with done.json) and chart.svg (p95 action latency per
store at 50 and 200 players), and prints the Results table, the decision rule applied step by
step and the stress runs as Markdown.

Definitions (proposed for ADR-0001's Method; the ADR doesn't fix them):

- **Action latency** is Locust's response time for POST /farms/:id/actions (active and returning
  players together), measured window only. Client-side, which is what the same-machine rule in
  the Method protects. Per store × player count, the three runs' histograms are pooled.
- **Worst-case load** (B100) is the server's `load` time (Server-Timing) of every measured request
  that loaded a farm with a 99-action tail: snapshot at seq 100k, farm at seq 100k + 99. The tail
  isn't logged, so it is rebuilt: each farm's seq is its seeded seq plus the accepted actions
  before the request (one Locust user per farm, no gifts, so nothing else writes it). The
  rebuilt final seqs are checked against the log's row count. A POST's `load` also holds the
  idempotency lookup, so it slightly overstates the read and replay; that errs against B.
- **Offline return** is Locust's GET /farms/:id [return]: the read 8 hours of server time later.
- **Bytes per player-hour** is the schema's growth from just before Locust starts to just after
  it stops (pg_total_relation_size: indexes, TOAST and not-yet-vacuumed space included), divided
  by players and by the run's real hours (warm-up + measured).
- **Lost updates** are accepted actions (200s) minus rows written: the log's new rows for B,
  new processed keys for A.
- **Replay cost** (ADR-0001 step 4, B25 and B100): an ordinary least-squares line through `load`
  time against tail (seq mod N, rebuilt as for the worst case) over every measured read and action
  of the six normal runs (both player counts pooled). The slope is µs per tail action: reading the
  action rows from Postgres as well as applying them, so an upper bound on the sim's own cost. The
  projection is intercept + 10 × slope × (N − 1): the worst-case load if each replayed action cost
  10× as much (the full sim). B1's tail is always 0, so it has no slope.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
STORES = ["A", "B1", "B25", "B100"]
SNAPSHOT_N = {"A": None, "B1": 1, "B25": 25, "B100": 100}


# --- percentiles ------------------------------------------------------------------------------

def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile, so the number is one that was measured."""
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * p // 100))
    return ordered[int(rank) - 1]


def hist_percentile(hist: dict[int, int], p: float) -> int:
    """Nearest-rank percentile over Locust's histogram {rounded ms: count}."""
    total = sum(hist.values())
    rank = max(1, -(-total * p // 100))
    seen = 0
    for ms in sorted(hist):
        seen += hist[ms]
        if seen >= rank:
            return ms
    raise ValueError("empty histogram")


def merge(*hists: dict[int, int]) -> dict[int, int]:
    out: dict[int, int] = defaultdict(int)
    for h in hists:
        for ms, n in h.items():
            out[ms] += n
    return dict(out)


# --- the tail each request loaded -------------------------------------------------------------

def tails(rows: list[dict], seeded: dict[str, int], n: int) -> tuple[list[tuple[dict, int]], dict[str, int]]:
    """Each farm request with the replay tail its load saw (seq before the request mod n), and
    every farm's seq at the end. `rows` are server.csv rows in the order they were written."""
    seq = dict(seeded)
    out: list[tuple[dict, int]] = []
    for row in rows:
        if row["route"] not in ("read", "action"):
            continue
        farm = row["farm"]
        out.append((row, seq[farm] % n))
        if row["route"] == "action" and row["status"] == "200":
            seq[farm] += 1
    return out, seq


# --- replay cost (ADR-0001 step 4) ------------------------------------------------------------

@dataclass(frozen=True)
class Fit:
    """`load` ≈ intercept + slope × tail, from ordinary least squares."""

    slope_us: float
    intercept_ms: float
    n: int

    def projected_ms(self, snapshot_n: int) -> float:
        """The worst-case load (tail N − 1) if each replayed action cost 10× as much."""
        return self.intercept_ms + 10 * (self.slope_us / 1000) * (snapshot_n - 1)


def fit_replay(samples: list[tuple[int, float]]) -> Fit:
    """OLS of load ms against tail; the slope comes back in µs per action."""
    n = len(samples)
    mx = sum(t for t, _ in samples) / n
    my = sum(ms for _, ms in samples) / n
    sxx = sum((t - mx) ** 2 for t, _ in samples)
    if sxx == 0:
        raise ValueError("every sample has the same tail: no slope to fit")
    slope = sum((t - mx) * (ms - my) for t, ms in samples) / sxx
    return Fit(slope_us=slope * 1000, intercept_ms=my - slope * mx, n=n)


def replay_samples(rows: list[dict], seeded: dict[str, int], n: int, start: int, end: float) -> list[tuple[str, int, float]]:
    """(route, tail, load ms) for every accepted read and action in the measured window."""
    with_tails, _ = tails(rows, seeded, n)
    return [
        (r["route"], tail, float(r["loadMs"]))
        for r, tail in with_tails
        if r["status"] == "200" and start <= int(r["t"]) <= end
    ]


# --- one configuration ------------------------------------------------------------------------

@dataclass
class Config:
    id: str
    kind: str
    store: str
    users: int
    run: int
    warmup_s: int
    measure_s: int
    hists: dict[str, dict[int, int]]  # action, read, return_read, all
    requests: int
    failures: int
    server_action_ms: list[float]
    retries: int
    status: dict[str, int]
    worst_load_ms: list[float] = field(default_factory=list)  # B100: tail 99
    bytes_before: int = 0
    bytes_after: int = 0
    accepted: int = 0
    written: int = 0
    seq_check: str = ""
    replay: list[tuple[str, int, float]] = field(default_factory=list)  # B25, B100: (route, tail, load ms)

    @property
    def bytes_per_player_hour(self) -> float:
        hours = (self.warmup_s + self.measure_s) / 3600
        return (self.bytes_after - self.bytes_before) / self.users / hours

    @property
    def reads(self) -> int:
        return sum(self.hists["read"].values())

    @property
    def writes(self) -> int:
        return sum(self.hists["action"].values())


def load_config(folder: Path) -> Config:
    done = json.loads((folder / "done.json").read_text())
    entries = json.loads((folder / "locust.json").read_text())
    hists: dict[str, dict[int, int]] = {"action": {}, "read": {}, "return_read": {}, "all": {}}
    requests = failures = 0
    for e in entries:
        h = {int(ms): c for ms, c in e["response_times"].items()}
        requests += e["num_requests"]
        failures += e["num_failures"]
        hists["all"] = merge(hists["all"], h)
        if e["name"].startswith("POST /farms/:id/actions"):
            hists["action"] = merge(hists["action"], h)
        elif e["name"].startswith("GET /farms/:id"):
            hists["read"] = merge(hists["read"], h)
            if e["name"].endswith("[return]"):
                hists["return_read"] = merge(hists["return_read"], h)

    window = json.loads((folder / "window.json").read_text())
    start, end = window["measuredFrom"], window["measuredTo"]
    with open(folder / "server.csv", newline="") as f:
        rows = list(csv.DictReader(f))
    farm_rows = [r for r in rows if r["route"] in ("read", "action")]
    measured = [r for r in farm_rows if start <= int(r["t"]) <= end]

    status: dict[str, int] = defaultdict(int)
    for r in measured:
        status[r["status"]] += 1
    seeded = {f["farm"]: f["seq"] for f in json.loads((folder / "seed.json").read_text())["farms"]}
    before = json.loads((folder / "storage-before.json").read_text())
    after = json.loads((folder / "storage-after.json").read_text())

    store = done["store"]
    c = Config(
        id=done["id"], kind=done.get("kind", "normal"), store=store, users=done["users"], run=done["run"],
        warmup_s=done["warmupS"], measure_s=done["measureS"], hists=hists, requests=requests, failures=failures,
        server_action_ms=[float(r["totalMs"]) for r in measured if r["route"] == "action" and r["status"] == "200"],
        retries=sum(int(r["retries"] or 0) for r in measured),
        status=dict(status), bytes_before=before["bytes"], bytes_after=after["bytes"],
    )

    # Accepted actions over the whole run (warm-up too) against rows written.
    c.accepted = sum(1 for r in farm_rows if r["route"] == "action" and r["status"] == "200")
    table = "processed_keys" if store == "A" else "actions"
    c.written = after["tables"][table]["rows"] - before["tables"][table]["rows"]

    n = SNAPSHOT_N[store]
    if n:
        with_tails, final = tails(rows, seeded, n)
        log_rows = after["tables"]["actions"]["rows"]
        c.seq_check = "ok" if sum(final.values()) == log_rows else f"rebuilt {sum(final.values())} ≠ log {log_rows}"
        if n in (25, 100):
            c.replay = replay_samples(rows, seeded, n, start, end)
        if n == 100:
            c.worst_load_ms = [
                float(r["loadMs"]) for r, tail in with_tails
                if tail == 99 and r["status"] == "200" and start <= int(r["t"]) <= end
            ]
    return c


# --- aggregation and the decision rule --------------------------------------------------------

def fmt(x: float, digits: int = 0) -> str:
    return f"{x:,.{digits}f}"


def group(configs: list[Config], store: str, users: int) -> list[Config]:
    return [c for c in configs if c.kind == "normal" and c.store == store and c.users == users]


def pooled(cs: list[Config], key: str) -> dict[int, int]:
    return merge(*(c.hists[key] for c in cs)) if cs else {}


def p(h: dict[int, int], q: float) -> int | None:
    return hist_percentile(h, q) if h else None


def write_csv(configs: list[Config], path: Path) -> None:
    cols = [
        "id", "kind", "store", "users", "run", "warmup_s", "measure_s",
        "requests", "failures", "reads", "writes", "read_share",
        "action_p50_ms", "action_p95_ms", "action_p99_ms",
        "read_p50_ms", "read_p95_ms", "return_read_p50_ms", "return_read_p95_ms",
        "server_action_p50_ms", "server_action_p95_ms",
        "worst_load_n", "worst_load_p95_ms",
        "retries", "status_422", "status_503", "status_5xx_other", "accepted", "rows_written", "lost_updates",
        "seq_rebuild", "bytes_before", "bytes_after", "bytes_per_player_hour",
    ]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for c in configs:
            s5 = sum(v for k, v in c.status.items() if k.startswith("5") and k != "503")
            w.writerow([
                c.id, c.kind, c.store, c.users, c.run, c.warmup_s, c.measure_s,
                c.requests, c.failures, c.reads, c.writes, f"{c.reads / max(1, c.reads + c.writes):.4f}",
                p(c.hists["action"], 50), p(c.hists["action"], 95), p(c.hists["action"], 99),
                p(c.hists["read"], 50), p(c.hists["read"], 95),
                p(c.hists["return_read"], 50), p(c.hists["return_read"], 95),
                f"{percentile(c.server_action_ms, 50):.3f}", f"{percentile(c.server_action_ms, 95):.3f}",
                len(c.worst_load_ms) if c.store == "B100" else "",
                f"{percentile(c.worst_load_ms, 95):.3f}" if c.worst_load_ms else "",
                c.retries, c.status.get("422", 0), c.status.get("503", 0), s5,
                c.accepted, c.written, c.accepted - c.written,
                c.seq_check, c.bytes_before, c.bytes_after, f"{c.bytes_per_player_hour:.0f}",
            ])


def results_table(configs: list[Config]) -> str:
    present = [s for s in STORES if any(c.store == s and c.kind == "normal" for c in configs)]
    head = "| | " + " | ".join(present) + " |\n|---|" + "---|" * len(present) + "\n"
    lines = []

    def row(label: str, cell) -> None:
        lines.append(f"| {label} | " + " | ".join(cell(s) for s in present) + " |")

    row("Gate (hash equivalence)", lambda s: "pass")
    for u in (50, 200):
        def lat(s: str, u: int = u) -> str:
            cs = group(configs, s, u)
            h = pooled(cs, "action")
            if not h:
                return "–"
            runs = sorted(p(c.hists["action"], 95) for c in cs)
            spread = f" (runs {runs[0]}–{runs[-1]})" if len(runs) > 1 else ""
            return f"{p(h, 50)} / {p(h, 95)}{spread}"
        row(f"p50 / p95 at {u} players (ms)", lat)

    def worst(s: str) -> str:
        if s != "B100":
            return "n/a"
        ms = [x for c in configs if c.kind == "normal" and c.store == "B100" for x in c.worst_load_ms]
        return f"{percentile(ms, 95):.2f} (n {len(ms)})" if ms else "–"
    row("Worst-case load p95 (ms)", worst)

    def offline(s: str) -> str:
        parts = []
        for u in (50, 200):
            h = pooled(group(configs, s, u), "return_read")
            parts.append(str(p(h, 95)) if h else "–")
        return " / ".join(parts) + " (50 / 200)"
    row("Offline return p95 (ms)", offline)

    def lost(s: str) -> str:
        cs = [c for c in configs if c.kind == "normal" and c.store == s]
        return f"{sum(c.accepted - c.written for c in cs)} / {sum(c.retries for c in cs)} / {sum(c.status.get('503', 0) for c in cs)}"
    row("Lost updates / retries / 503s", lost)

    def bph(s: str) -> str:
        parts = []
        for u in (50, 200):
            cs = group(configs, s, u)
            parts.append(fmt(sum(c.bytes_per_player_hour for c in cs) / len(cs)) if cs else "–")
        return " / ".join(parts) + " (50 / 200)"
    row("Bytes per player-hour", bph)

    def share(s: str) -> str:
        cs = [c for c in configs if c.kind == "normal" and c.store == s]
        r, w = sum(c.reads for c in cs), sum(c.writes for c in cs)
        return f"{100 * r / max(1, r + w):.1f}% / {100 * w / max(1, r + w):.1f}%"
    row("Read / write share", share)
    row("`stateAt` possible", lambda s: "no" if s == "A" else "yes")

    def replay(s: str) -> str:
        if s == "A":
            return "n/a (no replay)"
        if s == "B1":
            return "n/a (tail always 0)"
        fits = replay_fits(configs, s)
        if not fits:
            return "–"
        pooled_fit = fits["pooled"]
        return (f"{pooled_fit.slope_us:.1f} µs (reads {fits['read'].slope_us:.1f}, actions {fits['action'].slope_us:.1f}); "
                f"×10: {pooled_fit.projected_ms(SNAPSHOT_N[s]):.2f} ms")
    row("Replay cost (µs per action; ×10 projection)", replay)
    return head + "\n".join(lines)


def replay_fits(configs: list[Config], store: str) -> dict[str, Fit]:
    """The store's replay fits over its normal runs (both player counts): read, action, pooled."""
    samples = [x for c in configs if c.kind == "normal" and c.store == store for x in c.replay]
    if not samples:
        return {}
    fits = {"pooled": fit_replay([(t, ms) for _, t, ms in samples])}
    for route in ("read", "action"):
        fits[route] = fit_replay([(t, ms) for r, t, ms in samples if r == route])
    return fits


def replay_table(configs: list[Config]) -> str:
    lines = ["| Store | Requests | Slope (µs per action) | Intercept (ms) | ×10 worst case: intercept + 10 × slope × (N − 1) (ms) |",
             "|---|---|---:|---:|---:|"]
    for s in ("B25", "B100"):
        fits = replay_fits(configs, s)
        for route in ("read", "action", "pooled"):
            if route not in fits:
                continue
            f = fits[route]
            label = {"read": "reads", "action": "actions", "pooled": "**pooled**"}[route]
            lines.append(f"| {s} | {label} (n {f.n:,}) | {f.slope_us:.2f} | {f.intercept_ms:.3f} "
                         f"| {f.projected_ms(SNAPSHOT_N[s]):.2f} |")
    lines.append("| B1 | n/a: its tail is always 0, so there is no slope | | | |")
    return "\n".join(lines)


def decision(configs: list[Config]) -> str:
    out = []
    a = pooled(group(configs, "A", 200), "action")
    if not a:
        return "A at 200 players is missing: the rule can't be applied yet."
    a95 = p(a, 95)
    limit = max(2 * a95, a95 + 20)
    out.append(f"1. **Gate:** passed for every store (`gate.md`; rerun in this session on Postgres 17 before the matrix).")
    out.append(f"2. **B wins unless** a B variant fails a condition. A's p95 at 200 players is {a95} ms, so the latency limit is "
               f"max(2 × {a95}, {a95} + 20) = **{limit} ms**.")
    passing = []
    for s in ("B1", "B25", "B100"):
        h = pooled(group(configs, s, 200), "action")
        if not h:
            out.append(f"   - {s}: no runs at 200 players.")
            continue
        b95 = p(h, 95)
        fails = []
        if b95 > limit:
            fails.append(f"p95 {b95} ms > {limit} ms")
        if s == "B100":
            ms = [x for c in configs if c.kind == "normal" and c.store == "B100" for x in c.worst_load_ms]
            w95 = percentile(ms, 95) if ms else None
            if w95 is None:
                fails.append("no worst-case loads measured")
            elif w95 > 50:
                fails.append(f"worst-case load p95 {w95:.2f} ms > 50 ms")
            wtxt = f"; worst-case load p95 {w95:.2f} ms ≤ 50 ms" if w95 is not None and w95 <= 50 else ""
        else:
            wtxt = ""
        if fails:
            out.append(f"   - {s}: **fails** ({'; '.join(fails)}).")
        else:
            out.append(f"   - {s}: passes (p95 {b95} ms ≤ {limit} ms{wtxt}).")
            passing.append((s, b95))
    if not passing:
        out.append("3. No B variant passes, so **A wins**.")
        return "\n".join(out)
    best = min(b for _, b in passing)
    close = [(s, b) for s, b in passing if b - best <= 5]
    out.append("3. **Among passing variants**, p95 at 200 players: " + ", ".join(f"{s} {b} ms" for s, b in passing) + ".")
    if len(close) == 1:
        winner = close[0][0]
        out.append(f"   {winner} is lowest and no other variant is within 5 ms, so **{winner} wins**.")
    else:
        def bph(s: str) -> float:
            cs = group(configs, s, 200)
            return sum(c.bytes_per_player_hour for c in cs) / len(cs)
        ranked = sorted(close, key=lambda sb: bph(sb[0]))
        winner = ranked[0][0]
        out.append("   Within 5 ms of the lowest: " + ", ".join(s for s, _ in close)
                   + ". The tie-break is bytes per player-hour (at 200 players): "
                   + ", ".join(f"{s} {fmt(bph(s))}" for s, _ in ranked) + f", so **{winner} wins**.")
    return "\n".join(out)


def stress_table(configs: list[Config]) -> str:
    cs = [c for c in configs if c.kind == "stress"]
    if not cs:
        return "_No stress runs yet._"
    lines = ["| Store | Requests (/s) | Failures | Reads / writes | Action p50 / p95 / p99 (ms) | Read p95 (ms) "
             "| Server action p95 (ms) | Retries / 503s | Lost updates |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for c in sorted(cs, key=lambda c: STORES.index(c.store)):
        h = c.hists["action"]
        lines.append(
            f"| {c.store} | {c.requests:,} ({c.requests / c.measure_s:,.0f}) | {c.failures} | {c.reads:,} / {c.writes:,} "
            f"| {p(h, 50)} / {p(h, 95)} / {p(h, 99)} | {p(c.hists['read'], 95)} "
            f"| {percentile(c.server_action_ms, 95):.2f} | {c.retries} / {c.status.get('503', 0)} | {c.accepted - c.written} |")
    return "\n".join(lines)


def chart(configs: list[Config], path: Path) -> None:
    """Grouped bars: pooled p95 action latency per store, at 50 and 200 players; dots per run."""
    w, h, left, bottom, top = 720, 400, 64, 56, 48
    data = {(s, u): group(configs, s, u) for s in STORES for u in (50, 200)}
    values = [p(pooled(cs, "action"), 95) for cs in data.values() if cs]
    runs = [p(c.hists["action"], 95) for cs in data.values() for c in cs]
    ymax = max(values + runs + [1]) * 1.15
    plot_h = h - bottom - top
    y = lambda v: top + plot_h * (1 - v / ymax)
    colors = {50: "#4c8bf5", 200: "#e8710a"}
    slot = (w - left - 24) / len(STORES)
    bar = slot * 0.3
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
           'font-family="system-ui, sans-serif" font-size="13">',
           f'<rect width="{w}" height="{h}" fill="#fff"/>',
           f'<text x="{left}" y="24" font-size="15" font-weight="600">p95 action latency by store (Locust, measured window, 3 runs pooled)</text>']
    step = 1 if ymax < 10 else 2 if ymax < 20 else 5 if ymax < 50 else 10 if ymax < 100 else 25
    v = 0
    while v <= ymax:
        svg.append(f'<line x1="{left}" x2="{w - 24}" y1="{y(v):.1f}" y2="{y(v):.1f}" stroke="#e5e5e5"/>')
        svg.append(f'<text x="{left - 8}" y="{y(v) + 4:.1f}" text-anchor="end" fill="#555">{v}</text>')
        v += step
    svg.append(f'<text x="16" y="{top + plot_h / 2}" transform="rotate(-90 16 {top + plot_h / 2})" text-anchor="middle" fill="#555">ms</text>')
    for i, s in enumerate(STORES):
        cx = left + slot * (i + 0.5)
        for j, u in enumerate((50, 200)):
            cs = data[(s, u)]
            if not cs:
                continue
            val = p(pooled(cs, "action"), 95)
            x = cx + (j - 1) * bar - 2 + j * 4
            svg.append(f'<rect x="{x:.1f}" y="{y(val):.1f}" width="{bar:.1f}" height="{top + plot_h - y(val):.1f}" fill="{colors[u]}"/>')
            svg.append(f'<text x="{x + bar / 2:.1f}" y="{y(val) - 6:.1f}" text-anchor="middle">{val}</text>')
            for k, c in enumerate(cs):
                rv = p(c.hists["action"], 95)
                svg.append(f'<circle cx="{x + bar * (k + 1) / (len(cs) + 1):.1f}" cy="{y(rv):.1f}" r="3" fill="#222" fill-opacity="0.6"/>')
        svg.append(f'<text x="{cx:.1f}" y="{h - bottom + 22}" text-anchor="middle" font-weight="600">{s}</text>')
    lx = w - 250
    for j, u in enumerate((50, 200)):
        svg.append(f'<rect x="{lx + j * 100}" y="{h - 22}" width="12" height="12" fill="{colors[u]}"/>')
        svg.append(f'<text x="{lx + j * 100 + 18}" y="{h - 12}">{u} players</text>')
    svg.append(f'<circle cx="{left + 6}" cy="{h - 16}" r="3" fill="#222" fill-opacity="0.6"/>'
               f'<text x="{left + 14}" y="{h - 12}">one run</text>')
    svg.append("</svg>")
    path.write_text("\n".join(svg) + "\n")


def main(argv: list[str]) -> None:
    matrix = Path(argv[1]) if len(argv) > 1 else REPO / "docs/spikes/persistence/matrix"
    out = Path(argv[2]) if len(argv) > 2 else REPO / "docs/spikes/persistence"
    folders = sorted(d for d in matrix.iterdir() if d.is_dir() and (d / "done.json").exists())
    configs = [load_config(d) for d in folders]
    order = {s: i for i, s in enumerate(STORES)}
    configs.sort(key=lambda c: (c.kind != "normal", c.run, order[c.store], c.users))
    write_csv(configs, out / "results.csv")
    chart(configs, out / "chart.svg")
    bad = [c.id for c in configs if c.seq_check not in ("", "ok")]
    print(f"{len(configs)} configurations: {', '.join(c.id for c in configs)}\n")
    if bad:
        print(f"WARNING: the rebuilt seqs don't match the log in {', '.join(bad)}\n")
    print("## Results\n")
    print(results_table(configs))
    print("\n## Decision rule\n")
    print(decision(configs))
    print("\n## Replay cost (ADR-0001 step 4)\n")
    print(replay_table(configs))
    print("\n## Stress runs\n")
    print(stress_table(configs))


if __name__ == "__main__":
    main(sys.argv)

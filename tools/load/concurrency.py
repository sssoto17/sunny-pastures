"""M3's stand-in for MUST-13.5 (#388; ADR-0007, "Load and concurrency"): two harvests on one farm
at the same moment, once per pair farm in the plan (1,000 by default), ported from the spike's
gift-and-harvest script. The gift version is MUST-13.5 itself, in M6.

    uv run --locked python concurrency.py <work dir> <base url> <out dir>

Each pair farm has wheat ripe on plots 1 and 2 (prepare.py --pairs, seed.mjs). Two kept-alive
connections each send one harvest with `expectedSeq: 2`, released by one event, so they reach the
server together; the loser of the race conflicts and must commit on its retry (MUST-13.3). The
requests go to <work dir>/requests.csv in the Locust log's columns, for seed.mjs's lost-update
check; <out dir>/concurrency.json gets the counts: statuses, collisions (an answer with a retry),
and rebased answers.
"""

from gevent import monkey

monkey.patch_all()
# Every import below comes after the patch, as gevent requires.

import csv
import json
import sys
import time
import uuid
from collections import Counter
from pathlib import Path

import gevent
import requests
from gevent.event import Event

from locustfile import LOG_COLUMNS, read_timing


def harvest(session: requests.Session, base: str, player: dict, plot: int, go: Event) -> list:
    key = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {player['token']}", "Idempotency-Key": key}
    body = {"action": {"type": "harvest", "plot": plot}, "expectedSeq": 2}
    go.wait()
    started = time.perf_counter()
    res = session.post(f"{base}/api/farm/actions", json=body, headers=headers, timeout=30)
    client_ms = round((time.perf_counter() - started) * 1000, 2)
    answer = res.json().get("answer") if res.status_code == 200 else None
    timing = read_timing(res.headers.get("Server-Timing"))
    return [
        int(time.time() * 1000), "POST /api/farm/actions [pair]", "POST", res.status_code, client_ms,
        *(timing.get(p, "") for p in ("load", "sim", "commit", "total")), 2, player["farmId"], key,
        answer["seq"] if answer else "", answer["retries"] if answer else "",
    ], answer


def main() -> None:
    work, base, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    players = [p for p in json.loads((work / "players.json").read_text()) if p["kind"] == "pair"]
    sessions = [requests.Session(), requests.Session()]
    statuses: Counter = Counter()
    collisions = rebased = 0
    with open(work / "requests.csv", "w", newline="") as f:
        log = csv.writer(f)
        log.writerow(LOG_COLUMNS)
        for player in players:
            go = Event()
            pair = [gevent.spawn(harvest, sessions[i], base, player, i, go) for i in (0, 1)]
            gevent.sleep(0)  # both greenlets wait on the event before it is set
            go.set()
            gevent.joinall(pair, raise_error=True)
            answers = []
            for g in pair:
                row, answer = g.value
                log.writerow(row)
                statuses[row[3]] += 1
                answers.append(answer)
            collisions += any(a and a["retries"] > 0 for a in answers)
            rebased += sum(bool(a and a["rebased"]) for a in answers)
    result = {"pairs": len(players), "statuses": dict(statuses), "collisions": collisions, "rebased": rebased}
    (out / "concurrency.json").write_text(json.dumps(result) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()

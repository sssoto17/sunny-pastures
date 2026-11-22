"""The M3 load profile (#388), ported from the persistence spike's (ADR-0001, "Method").

Each Locust user plays real anonymous players that prepare.py signed up and seed.mjs seeded,
read from PLAYERS (players.json, whose tokens are never printed). Two kinds of player, 4:1:

- ActivePlayer (80%): one farm, a tap every 2-8 s. LOOK_SHARE (15%) of its taps are a look at the
  farm (`GET /api/farm`) whatever else it could do; the rest are an action its view of the farm
  allows (plant, harvest, deliver), or a look if there is nothing to do yet.
- ReturningPlayer (20%): each visit takes the next unused returning farm, whose last action was
  8 hours ago (seeded backdated: the API has no clock header), reads it (the offline return,
  "GET /api/farm [return]"), makes 2-5 actions 2-8 s apart, then is away 10-30 s. Its first farm
  is set aside for it; the rest come from a shared pool, and once that is used up it revisits its
  last farm ("[revisit]", no longer an 8-hour return).

The view is the farm the server last sent: a GET's farm is the state after the last action, not
advanced (ADR-0007, section 3), so a growing plot past its readyAt counts as ripe, and a POST's
farm is the one committed.

Stress: NO_WAIT=1 takes every wait out. Warm-up: WARMUP_S resets Locust's stats that many seconds
in, and WINDOW_FILE gets the measured window in epoch ms, which results.py cuts the request log to.

REQUEST_LOG gets one CSV row per game request: the response's Server-Timing phases, the seq the
server loaded (so the replay tail is seq mod 100, B100), and an accepted action's farm, key and
answered seq for seed.mjs's lost-update check.
"""

from __future__ import annotations

import csv
import json
import os
import random
import time
import uuid
from dataclasses import dataclass

import gevent
from locust import HttpUser, between, constant, events, task

#: M3's content written out (sliceContent): wheat costs 2 coins, a harvest yields at most 3, the
#: silo holds 50.
SEED_PRICE = 2
MAX_YIELD = 3
SILO_CAPACITY = 50
#: Harvest only this long after readyAt, so the client's and server's clocks can't disagree.
RIPE_MARGIN_MS = 500
LOOK_SHARE = 0.15
PHASES = ("load", "sim", "commit", "total")

NO_WAIT = os.environ.get("NO_WAIT") == "1"
WARMUP_S = float(os.environ.get("WARMUP_S", "0"))
WINDOW_FILE = os.environ.get("WINDOW_FILE")
LOG_COLUMNS = ["t", "name", "method", "status", "clientMs", *PHASES, "seq", "farm", "key", "answerSeq", "retries"]


def _read_players() -> dict[str, list[dict]]:
    path = os.environ.get("PLAYERS")
    players = json.loads(open(path).read()) if path else []
    return {kind: [p for p in players if p["kind"] == kind] for kind in ("active", "returning")}


_players = _read_players()
_active = iter(_players["active"])
#: Each returning player's first farm is set aside (RETURNERS: how many returning players run), so a
#: player spawned after fast ones drained the shared rest (the stress run) still has one.
_returners = int(os.environ.get("RETURNERS", "0"))
_firsts = iter(_players["returning"][:_returners])
_returning = iter(_players["returning"][_returners:])
_window: dict = {"warmupS": WARMUP_S}
_log_file = open(os.environ["REQUEST_LOG"], "w", newline="") if os.environ.get("REQUEST_LOG") else None
_log = csv.writer(_log_file) if _log_file else None
if _log:
    _log.writerow(LOG_COLUMNS)


@dataclass
class Farm:
    """The farm as the server last sent it: `{ seq, at, state, rulesVersion }`."""

    seq: int
    state: dict

    def ripe(self, plot: dict, now: int) -> bool:
        return plot["status"] == "ready" or (
            plot["status"] == "growing" and plot["readyAt"] + RIPE_MARGIN_MS <= now
        )

    def have(self, good: str) -> int:
        return self.state["silo"].get(good, 0) + self.state["barn"].get(good, 0)


def _plant(farm: Farm, now: int) -> dict | None:
    empty = [i for i, p in enumerate(farm.state["plots"]) if p["status"] == "empty"]
    if not empty or farm.state["coins"] < SEED_PRICE:
        return None
    return {"type": "plant", "plot": random.choice(empty), "crop": "wheat"}


def _harvest(farm: Farm, now: int) -> dict | None:
    if sum(farm.state["silo"].values()) + MAX_YIELD > SILO_CAPACITY:
        return None
    ripe = [i for i, p in enumerate(farm.state["plots"]) if farm.ripe(p, now)]
    return {"type": "harvest", "plot": random.choice(ripe)} if ripe else None


def _deliver(farm: Farm, now: int) -> dict | None:
    slots = [
        i
        for i, slot in enumerate(farm.state["board"])
        if slot["status"] == "open" and all(farm.have(g["good"]) >= g["amount"] for g in slot["order"]["goods"])
    ]
    return {"type": "deliver", "slot": random.choice(slots)} if slots else None


MOVES = [_plant, _harvest, _deliver]


def choose_tap(farm: Farm, now: int, rng: random.Random, look_share: float = LOOK_SHARE) -> dict | None:
    """One tap: None is a look (a GET); otherwise the action of the first move, in random order,
    that the farm allows. A `look_share` of taps are looks whatever the farm allows."""
    if rng.random() < look_share:
        return None
    for move in rng.sample(MOVES, len(MOVES)):
        action = move(farm, now)
        if action is not None:
            return action
    return None


def waiting(low: float, high: float):
    return constant(0) if NO_WAIT else between(low, high)


def read_timing(header: str | None) -> dict[str, str]:
    """`load;dur=1.2, total;dur=3.4` → {"load": "1.2", "total": "3.4"}."""
    out = {}
    for metric in (header or "").split(","):
        name, _, rest = metric.strip().partition(";")
        if rest.startswith("dur="):
            out[name] = rest[4:]
    return out


_rng = random.Random()


class Player(HttpUser):
    abstract = True
    kind = "player"
    look_share = 0.0

    def take_next(self) -> bool:
        """The next unused returning farm, if any is left; False keeps the current one."""
        fresh = next(_returning, None)
        if fresh is not None:
            self.take(fresh)
        return fresh is not None

    def take(self, player: dict) -> None:
        self.player = player
        self.auth = {"Authorization": f"Bearer {player['token']}"}
        self.farm = Farm(seq=0, state={})

    def record(self, res, name: str, method: str, seq: int, key: str = "", answer: dict | None = None) -> None:
        if _log is None:
            return
        timing = read_timing(res.headers.get("Server-Timing"))
        _log.writerow([
            int(time.time() * 1000), name, method, res.status_code, round(res.request_meta["response_time"], 2),
            *(timing.get(p, "") for p in PHASES), seq, self.player["farmId"], key,
            answer["seq"] if answer else "", answer["retries"] if answer else "",
        ])

    def read_farm(self, label: str) -> None:
        name = f"GET /api/farm [{label}]"
        with self.client.get("/api/farm", headers=self.auth, name=name, catch_response=True) as res:
            if res.status_code != 200:
                res.failure(f"{res.status_code}: {res.text[:200]}")
                self.record(res, name, "GET", self.farm.seq)
                return
            farm = res.json()["farm"]
            self.farm = Farm(seq=farm["seq"], state=farm["state"])
            self.record(res, name, "GET", self.farm.seq)

    def tap(self) -> None:
        action = choose_tap(self.farm, int(time.time() * 1000), _rng, self.look_share)
        if action is None:
            return self.read_farm(self.kind)
        self.act(action)

    def act(self, action: dict) -> None:
        key = str(uuid.uuid4())
        name = f"POST /api/farm/actions [{self.kind}]"
        headers = {**self.auth, "Idempotency-Key": key}
        body = {"action": action, "expectedSeq": self.farm.seq}
        loaded = self.farm.seq
        with self.client.post("/api/farm/actions", json=body, headers=headers, name=name, catch_response=True) as res:
            if res.status_code == 200:
                answered = res.json()
                answer, farm = answered["answer"], answered["farm"]
                self.record(res, name, "POST", answer["seq"] - 1, key, answer)
                self.farm = Farm(seq=farm["seq"], state=farm["state"])
                if answer["rebased"]:
                    res.failure("rebased: another client acted on this farm")  # one user per farm
                return
            res.failure(f"{res.status_code}: {res.text[:200]}")
            self.record(res, name, "POST", loaded, key)
        self.read_farm(self.kind)  # refused or failed: the view is wrong, so look again


class ActivePlayer(Player):
    weight = 4
    kind = "active"
    look_share = LOOK_SHARE
    wait_time = waiting(2, 8)

    def on_start(self) -> None:
        self.take(next(_active))
        self.read_farm(self.kind)

    @task
    def play(self) -> None:
        self.tap()


class ReturningPlayer(Player):
    weight = 1
    kind = "return"
    wait_time = waiting(10, 30)

    def on_start(self) -> None:
        self.take(next(_firsts))
        self.first = True

    @task
    def visit(self) -> None:
        fresh = self.first or self.take_next()
        self.first = False
        self.read_farm("return" if fresh else "revisit")
        for i in range(random.randint(2, 5)):
            if i and not NO_WAIT:
                gevent.sleep(random.uniform(2, 8))
            self.tap()


def _write_window() -> None:
    if WINDOW_FILE:
        with open(WINDOW_FILE, "w") as f:
            json.dump(_window, f)


@events.test_start.add_listener
def _start_warmup(environment, **_kwargs) -> None:
    def end_warmup() -> None:
        if WARMUP_S > 0:
            gevent.sleep(WARMUP_S)
            environment.stats.reset_all()
        _window["measuredFrom"] = int(time.time() * 1000)
        _write_window()

    gevent.spawn(end_warmup)


@events.test_stop.add_listener
def _end_window(environment, **_kwargs) -> None:
    _window["measuredTo"] = int(time.time() * 1000)
    _write_window()
    if _log_file:
        _log_file.flush()


"""Load profile for the persistence spike (#10, ADR-0001 "Method").

Each Locust user plays one seeded farm, `<FARM_PREFIX>-<i>`, in spawn order; seed as many farms as
users first (smoke.sh does). Two kinds of player, weighted 4:1:

- ActivePlayer (80%): taps every 2-8 s. A tap is an action the player's own view of the farm
  allows; if every plot is still growing, the tap is a look at the farm (a GET) instead.
- ReturningPlayer (20%): comes back after 8 hours of server time (X-Spike-Clock-Offset grows by
  8 h on every return and never shrinks), GETs the farm (the offline return), makes a few
  actions 2-8 s apart, then is away again for a short real-time while.

Moves are a registry: each one picks an action from the player's view and updates the view after
the server accepts it. Until #8 the server accepts only plant and harvest; to add bake, collect
or gifts, write their move and name it in SPIKE_ACTIONS (e.g. SPIKE_ACTIONS=plant,harvest,bake).

Request names (Locust's CSV rows): "<verb> <route> [active|return]", so the offline return read is
its own row ("GET /farms/:id [return]").
"""

from __future__ import annotations

import itertools
import os
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

import gevent
from locust import HttpUser, between, events, task

GROW_MS = 2 * 60_000
HOUR_MS = 60 * 60_000
RETURN_AFTER_MS = 8 * HOUR_MS
#: Harvest only this long after the plot should be ripe, so client/server clock jitter can't 422.
RIPE_MARGIN_MS = 500

FARM_PREFIX = os.environ.get("FARM_PREFIX", "load")
ENABLED_MOVES = [m.strip() for m in os.environ.get("SPIKE_ACTIONS", "plant,harvest").split(",") if m.strip()]

_farm_ids = itertools.count()


@dataclass
class FarmView:
    """What a player knows about their farm: the last GET, plus their own accepted actions."""

    seq: int = 0
    plots: list[dict] = field(default_factory=list)
    wheat: int = 0
    bread: int = 0
    bakery: list[dict] = field(default_factory=list)

    @classmethod
    def from_read(cls, body: dict) -> "FarmView":
        s = body["state"]
        return cls(seq=body["seq"], plots=s["plots"], wheat=s["wheat"], bread=s["bread"], bakery=s["bakery"])

    def ripe(self, plot: dict, now: int) -> bool:
        return plot["status"] == "ready" or (
            plot["status"] == "growing" and plot["readyAt"] + RIPE_MARGIN_MS <= now
        )


@dataclass(frozen=True)
class Move:
    """`choose` returns an action the view allows at `now`, or None; `accepted` updates the view."""

    choose: Callable[[FarmView, int], dict | None]
    accepted: Callable[[FarmView, dict, int], None]


def _choose_plant(view: FarmView, now: int) -> dict | None:
    empty = [i for i, p in enumerate(view.plots) if p["status"] == "empty"]
    return {"type": "plant", "plot": random.choice(empty)} if empty else None


def _planted(view: FarmView, action: dict, now: int) -> None:
    # The server stamps the plant at its own time, which can only be at or after `now`.
    view.plots[action["plot"]] = {"status": "growing", "readyAt": now + GROW_MS}


def _choose_harvest(view: FarmView, now: int) -> dict | None:
    ripe = [i for i, p in enumerate(view.plots) if view.ripe(p, now)]
    return {"type": "harvest", "plot": random.choice(ripe)} if ripe else None


def _harvested(view: FarmView, action: dict, now: int) -> None:
    view.plots[action["plot"]] = {"status": "empty"}
    view.wheat += 2  # the seeded bonus is unknown to the player; a GET corrects it


MOVES: dict[str, Move] = {
    "plant": Move(_choose_plant, _planted),
    "harvest": Move(_choose_harvest, _harvested),
}

unknown = [m for m in ENABLED_MOVES if m not in MOVES]
if unknown:
    raise SystemExit(f"SPIKE_ACTIONS names moves with no implementation: {', '.join(unknown)}")


class Player(HttpUser):
    abstract = True
    #: Which row of Locust's stats this player's requests land in.
    kind = "player"

    def on_start(self) -> None:
        self.farm = f"{FARM_PREFIX}-{next(_farm_ids)}"
        self.offset_ms = 0
        self.view = FarmView()
        self.read_farm()

    def server_now(self) -> int:
        """The server's time for this player: the same machine's clock plus this player's offset."""
        return int(time.time() * 1000) + self.offset_ms

    def headers(self) -> dict:
        return {"X-Spike-Clock-Offset": str(self.offset_ms)}

    def read_farm(self) -> None:
        with self.client.get(
            f"/farms/{self.farm}", headers=self.headers(), name=f"GET /farms/:id [{self.kind}]", catch_response=True
        ) as res:
            if res.status_code != 200:
                res.failure(f"{res.status_code}: {res.error or res.text[:200]}")
                return
            self.view = FarmView.from_read(res.json())

    def tap(self) -> None:
        """One action the view allows, or a look at the farm if nothing can be done yet."""
        now = self.server_now()
        moves = [MOVES[m] for m in ENABLED_MOVES]
        random.shuffle(moves)
        for move in moves:
            action = move.choose(self.view, now)
            if action is not None:
                return self.act(move, action, now)
        self.read_farm()

    def act(self, move: Move, action: dict, now: int) -> None:
        body = {"action": action, "expectedSeq": self.view.seq, "idempotencyKey": str(uuid.uuid4())}
        with self.client.post(
            f"/farms/{self.farm}/actions",
            json=body,
            headers=self.headers(),
            name=f"POST /farms/:id/actions [{self.kind}]",
            catch_response=True,
        ) as res:
            if res.status_code == 200:
                answer = res.json()
                self.view.seq = answer["seq"]
                move.accepted(self.view, action, now)
                if answer["rebased"]:
                    res.failure("rebased: another client acted on this farm")  # one user per farm
                return
            res.failure(f"{res.status_code}: {res.error or res.text[:200]}")
        # Refused or failed: the view is wrong, so look again.
        self.read_farm()


class ActivePlayer(Player):
    weight = 4
    kind = "active"
    wait_time = between(2, 8)

    @task
    def play(self) -> None:
        self.tap()


class ReturningPlayer(Player):
    weight = 1
    kind = "return"
    #: Real seconds away between visits; on the server's clock each absence is 8 hours.
    wait_time = between(10, 30)
    actions_per_visit = (2, 5)

    @task
    def visit(self) -> None:
        self.offset_ms += RETURN_AFTER_MS
        self.read_farm()  # the offline return: everything that grew while away
        for i in range(random.randint(*self.actions_per_visit)):
            if i:
                gevent.sleep(random.uniform(2, 8))
            self.tap()


@events.init.add_listener
def _describe(environment, **_kwargs) -> None:
    print(f"farms {FARM_PREFIX}-<i>; moves: {', '.join(ENABLED_MOVES)}")

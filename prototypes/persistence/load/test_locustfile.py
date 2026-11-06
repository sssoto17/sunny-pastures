"""The load mix's tap choice (#11): a fixed share of an active player's taps are looks (a GET of
their farm) whatever else they could do, and a tap with nothing to do is a look as well.

    cd prototypes/persistence/load && uv run --locked python -m unittest -v
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import unittest

from locustfile import LOOK_SHARE, MOVES, FarmView, choose_tap

NOW = 10 * 60_000


def busy_farm() -> FarmView:
    """Every move is possible: an empty plot, a ripe plot, wheat for a loaf, a loaf ready."""
    return FarmView(
        seq=1000,
        plots=[{"status": "empty"}, {"status": "ready"}],
        wheat=9,
        bread=0,
        bakery=[{"readyAt": 0}],
    )


def idle_farm() -> FarmView:
    """Nothing to do: every plot is still growing, no wheat, an empty bakery."""
    return FarmView(seq=1000, plots=[{"status": "growing", "readyAt": NOW + 60_000}] * 6)


class TapChoice(unittest.TestCase):
    def test_the_look_share_is_fifteen_percent(self) -> None:
        self.assertEqual(LOOK_SHARE, 0.15)

    def test_a_fixed_share_of_taps_on_a_busy_farm_are_looks(self) -> None:
        rng = random.Random(11)
        taps = 20_000
        looks = sum(choose_tap(busy_farm(), NOW, list(MOVES.values()), rng) is None for _ in range(taps))
        # Binomial(20,000, 0.15): sd ≈ 50 taps (0.25 points); 1 point either side is 4 sd.
        self.assertAlmostEqual(looks / taps, 0.15, delta=0.01)

    def test_a_tap_that_is_not_a_look_is_an_action_the_view_allows(self) -> None:
        rng = random.Random(7)
        chosen = [choose_tap(busy_farm(), NOW, list(MOVES.values()), rng) for _ in range(2_000)]
        kinds = {action["type"] for c in chosen if c is not None for action in [c[1]]}
        self.assertEqual(kinds, {"plant", "harvest", "bake", "collect"})

    def test_a_tap_with_nothing_to_do_is_always_a_look(self) -> None:
        rng = random.Random(3)
        for _ in range(1_000):
            self.assertIsNone(choose_tap(idle_farm(), NOW, list(MOVES.values()), rng))

    def test_without_a_look_share_a_busy_farm_always_acts(self) -> None:
        # Returning players' taps after the offline-return read keep the old behaviour.
        rng = random.Random(5)
        for _ in range(1_000):
            self.assertIsNotNone(choose_tap(busy_farm(), NOW, list(MOVES.values()), rng, look_share=0))


def waits(no_wait: str | None) -> list[float]:
    """Wait times the player classes draw, in a fresh interpreter so the env is read at import."""
    env = {k: v for k, v in os.environ.items() if k != "SPIKE_NO_WAIT"}
    if no_wait is not None:
        env["SPIKE_NO_WAIT"] = no_wait
    probe = (
        "import json, locustfile as l\n"
        "w = [l.ActivePlayer.wait_time(None) for _ in range(200)]"
        " + [l.ReturningPlayer.wait_time(None) for _ in range(200)]"
        " + [l.between_taps() for _ in range(200)]\n"
        "print(json.dumps(w))"
    )
    out = subprocess.run([sys.executable, "-c", probe], env=env, capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


class StressWaits(unittest.TestCase):
    def test_players_wait_between_taps_by_default(self) -> None:
        self.assertGreaterEqual(min(waits(None)), 2)

    def test_the_stress_run_has_no_wait_time_at_all(self) -> None:
        self.assertEqual(set(waits("1")), {0})


if __name__ == "__main__":
    unittest.main()

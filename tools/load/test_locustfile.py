"""The load profile's tap choice and Server-Timing parsing (#388), as the spike tested its own.

    uv run --locked python -m unittest -v
"""

from __future__ import annotations

import random
import unittest

from locustfile import LOOK_SHARE, Farm, choose_tap, read_timing

NOW = 10 * 60_000


def busy_farm() -> Farm:
    """Every move is possible: an empty plot, a ripe plot, wheat for the open order, coins."""
    return Farm(
        seq=1000,
        state={
            "coins": 20,
            "silo": {"wheat": 4},
            "barn": {},
            "plots": [{"status": "empty"}, {"status": "growing", "crop": "wheat", "readyAt": 0}],
            "board": [{"status": "open", "order": {"goods": [{"good": "wheat", "amount": 3}]}}],
        },
    )


def idle_farm() -> Farm:
    """Nothing to do: every plot still growing, an order it can't fill, a slot waiting to refill."""
    return Farm(
        seq=1000,
        state={
            "coins": 0,
            "silo": {},
            "barn": {},
            "plots": [{"status": "growing", "crop": "wheat", "readyAt": NOW + 60_000}] * 6,
            "board": [
                {"status": "open", "order": {"goods": [{"good": "egg", "amount": 1}]}},
                {"status": "empty", "refillAt": NOW + 1},
            ],
        },
    )


class TapChoice(unittest.TestCase):
    def test_a_fixed_share_of_taps_on_a_busy_farm_are_looks(self) -> None:
        rng = random.Random(11)
        taps = 20_000
        looks = sum(choose_tap(busy_farm(), NOW, rng) is None for _ in range(taps))
        # Binomial(20,000, 0.15): sd ≈ 50 taps (0.25 points); 1 point either side is 4 sd.
        self.assertAlmostEqual(looks / taps, LOOK_SHARE, delta=0.01)

    def test_a_tap_that_is_not_a_look_is_an_action_the_farm_allows(self) -> None:
        rng = random.Random(7)
        chosen = [choose_tap(busy_farm(), NOW, rng) for _ in range(2_000)]
        actions = [a for a in chosen if a is not None]
        self.assertEqual(
            {a["type"] for a in actions}, {"plant", "harvest", "deliver"}
        )
        self.assertTrue(all(a.get("plot") in (None, 0) for a in actions if a["type"] == "plant"))
        self.assertTrue(all(a.get("plot") == 1 for a in actions if a["type"] == "harvest"))

    def test_with_nothing_to_do_every_tap_is_a_look(self) -> None:
        rng = random.Random(3)
        self.assertTrue(all(choose_tap(idle_farm(), NOW, rng, look_share=0) is None for _ in range(200)))

    def test_a_plot_is_ripe_only_past_its_margin(self) -> None:
        farm = busy_farm()
        growing = {"status": "growing", "crop": "wheat", "readyAt": NOW}
        self.assertFalse(farm.ripe(growing, NOW + 499))
        self.assertTrue(farm.ripe(growing, NOW + 500))

    def test_a_full_silo_stops_harvests(self) -> None:
        farm = busy_farm()
        farm.state["silo"] = {"wheat": 48}
        farm.state["board"] = []
        farm.state["coins"] = 0
        rng = random.Random(5)
        self.assertTrue(all(choose_tap(farm, NOW, rng, look_share=0) is None for _ in range(200)))


class ServerTiming(unittest.TestCase):
    def test_reads_each_phase_duration(self) -> None:
        header = "load;dur=1.25, sim;dur=0.3, commit;dur=2, total;dur=4.1"
        self.assertEqual(read_timing(header), {"load": "1.25", "sim": "0.3", "commit": "2", "total": "4.1"})

    def test_a_missing_header_reads_as_no_phases(self) -> None:
        self.assertEqual(read_timing(None), {})


if __name__ == "__main__":
    unittest.main()

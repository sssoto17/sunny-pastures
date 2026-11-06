"""The worst-case load's tail reconstruction (#11): which tail each request's load replayed."""

from __future__ import annotations

import unittest

from results import fit_replay, hist_percentile, replay_samples, tails


def row(route: str, farm: str, status: str = "200") -> dict:
    return {"route": route, "farm": farm, "status": status}


class Tails(unittest.TestCase):
    def test_each_request_sees_the_seeded_seq_plus_the_accepted_actions_before_it(self) -> None:
        rows = [
            {"route": "seed", "farm": "", "status": "200"},
            row("read", "f"),            # seq 198: tail 98
            row("action", "f"),          # loads 198 (tail 98), commits 199
            row("action", "f", "422"),   # loads 199 (tail 99), refused: nothing written
            row("read", "f"),            # 199: tail 99
            row("action", "f"),          # loads 199 (tail 99), commits 200 (a snapshot)
            row("read", "f"),            # 200: tail 0
            row("action", "g"),          # another farm: 5 → tail 5
        ]
        seen, final = tails(rows, {"f": 198, "g": 5}, 100)
        self.assertEqual([t for _, t in seen], [98, 98, 99, 99, 99, 0, 5])
        self.assertEqual(final, {"f": 200, "g": 6})

    def test_nearest_rank_percentile_over_a_histogram(self) -> None:
        # 100 requests: 94 at 5 ms, 6 at 40 ms: the 95th is 40.
        self.assertEqual(hist_percentile({5: 94, 40: 6}, 95), 40)
        self.assertEqual(hist_percentile({5: 95, 40: 5}, 95), 5)


class ReplayCost(unittest.TestCase):
    """ADR-0001 step 4: replay cost in µs per action, and the load if each cost 10× as much."""

    def test_a_known_slope_and_intercept_come_back_from_the_fit(self) -> None:
        # load = 1.5 ms + 4 µs per tail action, tails 0..99, twice over.
        samples = [(tail, 1.5 + 0.004 * tail) for tail in range(100)] * 2
        fit = fit_replay(samples)
        self.assertEqual(fit.n, 200)
        self.assertAlmostEqual(fit.slope_us, 4.0, places=9)
        self.assertAlmostEqual(fit.intercept_ms, 1.5, places=9)
        # The worst case (tail N − 1) if each replayed action cost 10×: 1.5 + 10 × 0.004 × 99.
        self.assertAlmostEqual(fit.projected_ms(100), 5.46, places=9)
        self.assertAlmostEqual(fit.projected_ms(25), 1.5 + 10 * 0.004 * 24, places=9)

    def test_noise_around_the_line_averages_out(self) -> None:
        # Symmetric ±0.2 ms noise on every tail leaves the least-squares line where it was.
        samples = [(t, 2.0 + 0.003 * t + d) for t in range(25) for d in (-0.2, 0.2)]
        fit = fit_replay(samples)
        self.assertAlmostEqual(fit.slope_us, 3.0, places=9)
        self.assertAlmostEqual(fit.intercept_ms, 2.0, places=9)

    def test_samples_are_measured_reads_and_actions_with_their_rebuilt_tail(self) -> None:
        # Farm f seeded at seq 23 with N = 25: a read at 23, an action loading 23 (→ 24), a read at
        # 24, an action loading 24 (→ 25, a snapshot), a read at 25 (tail 0). The first read is
        # in the warm-up and is left out; the harness route never counts.
        rows = [
            {"t": "5", "route": "read", "farm": "f", "status": "200", "loadMs": "9.9"},
            {"t": "10", "route": "action", "farm": "f", "status": "200", "loadMs": "1.2"},
            {"t": "11", "route": "storage", "farm": "", "status": "200", "loadMs": "0.5"},
            {"t": "12", "route": "read", "farm": "f", "status": "200", "loadMs": "1.3"},
            {"t": "13", "route": "action", "farm": "f", "status": "200", "loadMs": "1.4"},
            {"t": "14", "route": "read", "farm": "f", "status": "200", "loadMs": "1.0"},
        ]
        got = replay_samples(rows, {"f": 23}, 25, start=10, end=20)
        self.assertEqual(got, [("action", 23, 1.2), ("read", 24, 1.3), ("action", 24, 1.4), ("read", 0, 1.0)])

    def test_the_fit_needs_more_than_one_tail(self) -> None:
        # B1's tail is always 0: there is no slope to fit.
        with self.assertRaises(ValueError):
            fit_replay([(0, 1.0), (0, 1.2)])


if __name__ == "__main__":
    unittest.main()

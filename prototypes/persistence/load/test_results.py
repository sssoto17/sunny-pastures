"""The worst-case load's tail reconstruction (#11): which tail each request's load replayed."""

from __future__ import annotations

import unittest

from results import hist_percentile, tails


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


if __name__ == "__main__":
    unittest.main()

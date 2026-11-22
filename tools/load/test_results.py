"""results.py's percentile and its cut of a run's request log (#388).

    uv run --locked python -m unittest -v
"""

from __future__ import annotations

import csv
import json
import tempfile
import unittest
from pathlib import Path

from results import percentile, run

COLUMNS = ["t", "name", "method", "status", "clientMs", "load", "sim", "commit", "total", "seq", "farm"]


class Percentile(unittest.TestCase):
    def test_is_nearest_rank(self) -> None:
        hist = {float(ms): 1 for ms in range(1, 101)}
        self.assertEqual(percentile(hist, 95), 95.0)
        self.assertEqual(percentile(hist, 50), 50.0)
        self.assertEqual(percentile({7.0: 1}, 95), 7.0)

    def test_weights_by_count(self) -> None:
        self.assertEqual(percentile({1.0: 94, 9.0: 6}, 95), 9.0)
        self.assertEqual(percentile({1.0: 95, 9.0: 5}, 95), 1.0)

    def test_an_empty_histogram_has_none(self) -> None:
        self.assertIsNone(percentile({}, 95))


class Run(unittest.TestCase):
    def test_keeps_the_window_marks_the_tail_and_finds_each_offline_return(self) -> None:
        rows = [
            [50, "GET /api/farm [return]", "GET", 200, 9, "1.0", "", "", "2.0", 1099, "a"],  # warm-up
            [150, "GET /api/farm [return]", "GET", 200, 7, "3.04", "", "", "4.0", 1099, "a"],
            [160, "GET /api/farm [return]", "GET", 200, 5, "1.0", "", "", "2.0", 1050, "b"],
            [170, "POST /api/farm/actions [return]", "POST", 200, 8, "2.0", "0.2", "3.0", "6.0", 1050, "b"],
            [999, "GET /api/farm [active]", "GET", 200, 4, "1.0", "", "", "2.0", 1000, "c"],  # after it
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "window.json").write_text(json.dumps({"measuredFrom": 100, "measuredTo": 500}))
            with open(out / "requests.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(COLUMNS)
                w.writerows(rows)
            run(out, out / "requests.csv")
            timing = list(csv.DictReader(open(out / "server_timing.csv")))
            offline = list(csv.DictReader(open(out / "offline_return.csv")))

        loads = [(r["tail99"], r["ms"], r["count"]) for r in timing if r["phase"] == "load"]
        self.assertEqual(sorted(loads), [("False", "1.0", "1"), ("False", "2.0", "1"), ("True", "3.0", "1")])
        # Farm a's first read was in the warm-up, so its read in the window is no offline return.
        self.assertEqual(offline, [{"ms": "5", "count": "1"}])


if __name__ == "__main__":
    unittest.main()

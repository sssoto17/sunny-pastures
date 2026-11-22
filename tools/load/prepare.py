"""Signs up one run's players and writes the plan seed.mjs seeds (#388).

    uv run --locked python prepare.py <work dir> --active 40 --returning 100
    uv run --locked python prepare.py <work dir> --pairs 1000

Each player is a real anonymous sign-up on the local stack's Auth (`POST /auth/v1/signup` with the
publishable key, as the acceptance tests sign up), so its farm id is its user id. Writes into the
work dir, which must be outside the repo:

- players.json: each player's farm id, kind and access token. Tokens are secrets: the file is
  readable by its owner only, and nothing prints one.
- plan.json: farm ids, kinds, seeded actions and end times only; seed.mjs reads it.

Seeding as the spike did (ADR-0001, "Method"): the i-th history farm gets 1,000 + (i * 37) mod 100
actions, so replay tails spread across 0 to 99 and some requests meet the 99-action tail
(MUST-13.9). An active player's history ends a minute ago; a returning player's 8 hours ago, the
backdating that stands in for the spike's clock header. A pair farm (concurrency.py) gets two wheat
plots planted 10 minutes ago, ripe now.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

HOUR_MS = 3_600_000
RETURN_AFTER_MS = 8 * HOUR_MS
REPO = Path(__file__).resolve().parents[2]


def read_env(name: str) -> str:
    """A variable from the environment, else from the repo's .env (`pnpm db:env`). Never printed."""
    value = os.environ.get(name)
    if not value and (REPO / ".env").exists():
        for line in (REPO / ".env").read_text().splitlines():
            key, _, rest = line.partition("=")
            if key == name:
                value = rest.strip().strip('"')
    if not value:
        raise SystemExit(f"{name} isn't set: run pnpm db:env first.")
    return value


def sign_up(url: str, key: str) -> tuple[str, str]:
    """One anonymous player: (user id, access token). An error names the status only."""
    res = requests.post(f"{url}/auth/v1/signup", json={}, headers={"apikey": key}, timeout=30)
    if res.status_code != 200:
        raise SystemExit(f"anonymous sign-up failed with status {res.status_code}")
    body = res.json()
    return body["user"]["id"], body["access_token"]


def seeded_actions(i: int) -> int:
    return 1_000 + (i * 37) % 100


def build(kinds: list[str], now_ms: int) -> list[dict]:
    """The plan's farms, ids to be filled in: kind, seeded actions and the last action's time."""
    farms = []
    for i, kind in enumerate(kinds):
        if kind == "pair":
            farms.append({"kind": "pair", "actions": 2, "endAt": now_ms - 10 * 60_000})
        else:
            back = RETURN_AFTER_MS if kind == "returning" else 60_000
            farms.append({"kind": "history", "actions": seeded_actions(i), "endAt": now_ms - back})
    return farms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("work", type=Path)
    parser.add_argument("--active", type=int, default=0)
    parser.add_argument("--returning", type=int, default=0)
    parser.add_argument("--pairs", type=int, default=0)
    args = parser.parse_args()
    work: Path = args.work.resolve()
    if work.is_relative_to(REPO):
        raise SystemExit("the work dir holds tokens: put it outside the repo")
    work.mkdir(parents=True, exist_ok=True)

    url, key = read_env("SUPABASE_URL"), read_env("SUPABASE_PUBLISHABLE_KEY")
    kinds = ["active"] * args.active + ["returning"] * args.returning + ["pair"] * args.pairs
    started = time.time()
    with ThreadPoolExecutor(max_workers=16) as pool:
        players = list(pool.map(lambda _: sign_up(url, key), kinds))
    farms = build(kinds, int(time.time() * 1000))
    for farm, (user_id, _token) in zip(farms, players):
        farm["farmId"] = user_id

    secret = work / "players.json"
    fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump([{"farmId": fid, "kind": k, "token": tok} for (fid, tok), k in zip(players, kinds)], f)
    (work / "plan.json").write_text(json.dumps({"farms": farms}))
    print(f"signed up {len(kinds)} players in {time.time() - started:.1f} s")


if __name__ == "__main__":
    main()

# MoSCoW prioritisation

What Sunny Pastures will and won't deliver by the hand-in on 5 January 2027. Priorities follow the
problem statement: the effort goes into the deterministic simulation, offline progress and cheat
resistance; the UI stays functional.

Each item has a stable ID so requirements, issues and the report can refer to it. The detailed
requirement specification (acceptance criteria per item) comes out of the requirements grill and
lands in `SPEC.md`; this file only ranks the scope.

Last changed: 2026-11-05.

## Must have

The game is not a valid answer to the research question without these.

**Gameplay**

| ID      | Item                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| MUST-01 | Crops: wheat, corn and strawberries (plant, grow over time, harvest)                    |
| MUST-02 | Animals: chickens and cows (feed, produce over time, collect)                           |
| MUST-03 | Production facilities with timed queues: feed mill, bakery, dairy                       |
| MUST-04 | NPC order board: deliver goods for coins and XP                                         |
| MUST-05 | Economy and progression: coins, XP and levels that unlock content                       |
| MUST-06 | Upgrades for fields and facilities                                                      |
| MUST-07 | Offline progress: the farm keeps producing while the player is away                     |
| MUST-08 | Gifting: send goods to another player                                                   |
| MUST-09 | Play without a sign-up form (Supabase anonymous sign-in)                               |

**System qualities**

| ID      | Item                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| MUST-10 | One deterministic simulation (`packages/sim`) shared by client and server               |
| MUST-11 | Server authority: server time and server-side validation of every action                |
| MUST-12 | Optimistic client prediction, reconciled with the server's result                       |
| MUST-13 | Persistence that survives concurrent actions and retries (sequence numbers, idempotency keys) |
| MUST-14 | Property tests for the simulation (time-splitting invariance, replay equals prediction) |
| MUST-15 | Protected black-box acceptance tests that agent PRs can't modify                       |
| MUST-16 | Cheat-attack tests mapped to the threat model and OWASP Top 10                          |
| MUST-17 | CI running the checks on every PR; deployed on Vercel with Supabase Postgres            |

**Evaluation**

| ID      | Item                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| MUST-18 | Two playtests: a think-aloud test of the vertical slice, then an offline-return test   |
| MUST-19 | System metrics: latency, rollbacks between prediction and server, unlock curves         |

## Should have

Clearly valuable; dropped only if the Musts are at risk.

| ID        | Item                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| SHOULD-01 | Read-only visits to another player's farm                                            |
| SHOULD-02 | Free game assets instead of placeholder UI, with licences tracked in `CREDITS.md`    |
| SHOULD-03 | Load tests with Locust, analysed in `tools/analysis`                                 |

## Could have

Only if there's time after the Musts and Shoulds, and only if they still serve the research question.

| ID       | Item                                                                                       |
| -------- | ------------------------------------------------------------------------------------------ |
| COULD-01 | Trading between players                                                                    |
| COULD-02 | Real-time updates (Supabase Realtime): live notifications, live visits                     |
| COULD-03 | Skill mini-games that earn time-skip currency, server-verifiable by seed and input replay  |
| COULD-04 | An event-store library in place of the hand-built action log                               |
| COULD-05 | Admin dashboard for monitoring and feature flags ([#1](https://github.com/sssoto17/sunny-pastures/issues/1)) |

## Won't have (this time)

Consciously out of scope for this project. Candidates for the report's Perspective chapter.

| ID      | Item                                                                                     |
| ------- | ---------------------------------------------------------------------------------------- |
| WONT-01 | A native mobile app (it could reuse `packages/sim` later)                                |
| WONT-02 | A canvas or game-engine renderer: the UI is DOM-based React                               |
| WONT-03 | Custom artwork                                                                           |
| WONT-04 | Company or client context: the project refers to the game only                           |
| WONT-05 | Reusing Revenge of the Assassin (the 1st-semester JS browser game) beyond a brief mention |
| WONT-06 | A sync engine such as Zero (Rocicorp) in place of the hand-built prediction, action log and reconciliation |

## Notes on tools considered

Kept here so the report's technology chapter can cite the reasoning.

- **Zero (WONT-06).** Its custom mutators run the same code optimistically on the client and
  authoritatively on the server, then rebase: the closest existing answer to sub-questions 2 and 3.
  Adopting it would outsource the contribution the report argues for. It syncs rows rather than
  simulating time, so offline progress would still be ours to build. It also needs a long-running
  `zero-cache` server and Postgres logical replication, which doesn't fit Vercel + Supabase on a
  small budget. Cite it as related work and in Perspective.
- **Phaser (or another game engine).** A game engine covers rendering, a frame loop, input,
  physics and assets. This project's engine is the simulation (`packages/sim`), which Phaser
  doesn't provide, and an idle game needs no frame loop: state is a function of time. The UI is
  DOM-based (WONT-02). If a drawn farm map is ever wanted, PixiJS inside a React component is the
  lighter option.
- **Vercel Workflow SDK (not a game dependency; candidate for the software factory).** Durable
  functions: `"use workflow"` / `"use step"`, saved and retried steps, `sleep()` that costs nothing
  while waiting, and hooks that pause until something external resumes them. Internally each run
  is an append-only event log replayed through a deterministic function: the same idea as the
  action log and the sim, so it belongs in related work next to Temporal. For game time it would
  be the server-tick model that lazy `advance()` avoids; durable timers are worth discussing as the
  push-based alternative in sub-question 2, not building. Possible later uses: "production ready"
  notifications, if notifications enter scope, and orchestrating the software factory
  (issue → agent PR → CI → approval hook → merge), which is the strongest fit.

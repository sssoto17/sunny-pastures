# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Adults who like calm idle and farm games. They drop in for a few minutes on a phone or a laptop
between other things, set the farm working, and leave it to run. They play one farm in one browser,
with no sign-up form (Supabase anonymous sign-in).

Secondary audiences: the participants of the two playtests (a think-aloud test of the vertical
slice, then an offline-return test) and the examiners of the bachelor project the game is built for.

## Product Purpose

Sunny Pastures is a cosy farm and bakery idle game in the browser. At the start everything is
manual: the player plants, feeds, bakes and collects. Upgrades gradually automate the farm, so more
of it keeps producing while the player is away. That gradual automation is the gameplay.

Success: a player returns after time away, sees at a glance what the farm made, collects it and sets
the next things going, without feeling rushed or punished for having been gone.

## Positioning

Calm, no-pressure play: a board game on a kitchen table. Nothing punishes the player for being away
or for being slow. There are no timers that fail them, and coming back opens the farm, not a pop-up:
attention cues on the map show what is ready.

## Operating Context

- Short sessions, repeated over days: check in, collect, queue the next jobs, leave.
- The return after time away is a core moment (MUST-07); the away summary sits behind a banner, not
  in the player's way.
- Played on phone and desktop browsers, in either orientation; no native app (WONT-01).

## Capabilities and Constraints

- The M4 slice: wheat → chicken feed → eggs → cookies, an NPC order board that pays coins and XP,
  and the return after time away. The full scope is `docs/requirements/moscow.md`; the checkable
  criteria are `docs/requirements/spec.md`.
- Progression: crops, animals, production facilities with timed queues, coins, XP and Levels that
  unlock content, and upgrades that automate the farm.
- One deterministic simulation (`packages/sim`) runs on client and server. The server owns time and
  validates every action; the client predicts and reconciles. Offline progress is computed when the
  player returns, so it is exact and can't be cheated.
- No playing without a connection: actions are not queued offline (WONT-07).
- Game numbers (grow times, prices, yields, XP) live in content data, not in copy or design.
- Terms: `GLOSSARY.md` is the source for game words (Level, Clover, Farmhand, order board, and the
  rest). Use them as defined.

## Brand Commitments

- **Name:** Sunny Pastures.
- **No monetisation:** no real money, ads, energy limits or pressure loops. Skipping a wait costs
  Clovers, a rare currency earned in play only (SHOULD-06).
- **Licensed art only:** LeviArt's Isometric Cartoon Farm and Cartoon Farm Items Pack, with the
  files kept out of git and licences tracked in `CREDITS.md`. A person draws every final pixel; AI
  is used only for ideas and reference. No custom artwork (WONT-03).
- **Game-only framing:** the product refers to the game only, with no company or client context
  (WONT-04).

## Evidence on Hand

- The bought LeviArt packs (kept outside the repository).
- No testimonials, player numbers, reviews or press exist. The playtests have not run yet: do not
  invent results or quotes from them.

## Product Principles

1. Time away is never punished: what the player comes back to is waiting for them, not lost.
2. The map tells the player what needs them; the interface does not interrupt them.
3. Automation is the reward: each upgrade should make the farm visibly need the player a little
   less.
4. Calm over urgency: no pressure loops, countdown alarms or nagging.

## Accessibility & Inclusion

ADR-0010, section 2: WCAG 2.2 AA for the interface (the HUD, buttons, popovers, dialogs, the order
board and all text). The map scene follows the Game Accessibility Guidelines' basic tier: no time
pressure, alternative inputs for pan and zoom, and no information by colour alone. Ambient map
animation runs by default and is stilled under `prefers-reduced-motion`. No orientation lock.

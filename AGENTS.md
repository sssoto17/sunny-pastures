# Sunny Pastures

A cosy farm and bakery idle game for the browser, built as a solo EK PBA Webudvikling bachelor
project (Nov 2026 to Jan 2027). The research question: how can the game's progression be modelled
as one deterministic simulation that runs on both client and server, so progress continues offline
and stays consistent and cheat-resistant, and how does that affect the player experience?

## Layout

Folders appear at the milestone that needs them; don't create them ahead of time.

- `packages/sim/`: the game rules as pure TypeScript with zero runtime dependencies: state types,
  content as data, `apply(state, action, at)` and `advance(state, to)`. No I/O, no `Date.now()`,
  no `Math.random()`: time arrives as an argument and randomness comes from a seed in the state.
- `apps/web/`: the Next.js app: UI, game API and persistence. `src/server/` is server-only.
- `tests/acceptance/`: black-box tests over HTTP. Agent PRs must not modify them.
- `tools/load/`, `tools/analysis/`: Python, used only for Locust load tests and data analysis.
- `docs/`: `adr/`, `agents/`, `diagrams/`, `plans/`, `retros/`, `spikes/`.

## Rules

- pnpm is the package manager (version pinned in `package.json` via Corepack). Don't use npm or
  yarn for this repo.
- Ask before adding a dependency, and pin exact versions. `minimumReleaseAge` in
  `pnpm-workspace.yaml` refuses releases younger than 7 days; don't lower it. Don't allow a
  dependency's install scripts without asking.
- A new package under `packages/` needs a second consumer, a boundary that must be enforced, or a
  separate toolchain. Otherwise the code lives in `apps/web`.
- When designing a module, name the design pattern(s) it uses and the alternatives considered, and
  record them in its ADR.
- Never commit secrets: read them from env vars and keep placeholders in `.env.example`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `sssoto17/sunny-pastures`, each in a milestone and on the Sunny Pastures Project. See `docs/agents/issue-tracker.md`.

### Triage labels

Work is manual by default; automated work carries `factory:` labels. Labels: `triage`, `ready`, `factory:ready`, and `blocked:decision` / `blocked:external` / `blocked:owner` for why an issue can't move yet. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

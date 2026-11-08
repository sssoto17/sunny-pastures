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
  The rules take content as a value (`createSim(content)`) and never import it as constants; the
  state is plain JSON data; design in ADR-0003.
- `apps/web/`: the Next.js app: UI, game API and persistence. `src/server/` is server-only.
- `tests/acceptance/`: black-box tests over HTTP. Agent PRs must not modify them.
- `tools/load/`, `tools/analysis/`: Python, used only for Locust load tests and data analysis.
- `docs/`: `adr/`, `agents/`, `diagrams/`, `plans/`, `requirements/` (MoSCoW in `moscow.md`,
  the requirement specification in `spec.md`), `retros/`, `spikes/`.

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
- Never print secret values, and never hand the admin a command that does. The admin pastes
  terminal output back into sessions, so every command you run or suggest must hide keys, tokens,
  passwords and credentials in URLs: silence the output, mask the values or list only the names.
  For the local stack, use `pnpm db:start` / `db:status` / `db:env`, never a bare `supabase start`
  or `supabase status`.
- Read `CONSTRAINTS.md` before writing code. Do not weaken it to make a change pass.
- Before running commands, read `docs/agents/sandbox.md`. It lists the sandbox pitfalls:
  `supabase`, localhost services and `.git` writes have to run outside the sandbox.
- Parallel sessions never share a branch. The main folder stays on `main` and belongs to the
  coordinating session. Any session that changes files or needs another branch works in its own
  git worktree under `.claude/worktrees/`, named `<N>-<slug>` after its issue (use the worktree
  tool before the first edit). Never `git checkout` or `git switch` in the main folder. A
  `PreToolUse` hook (`.claude/hooks/block-branch-switch.sh`) enforces this: in the main folder it
  denies branch switches and a top-level `cd` into a worktree.
- Check before you state. Verify a claim about the board, the repo or the tools (an issue's
  blockers, a skill's name, what a doc or rule requires) with a command first, not from memory.
  Review a results PR against every step of the rule or criteria it reports on.
- A mistake that happens twice is a missing safeguard: mechanical mistakes become checks (lint
  rule, Fallow boundary, test, CI step), judgement calls become standards (this file or
  `CONSTRAINTS.md`). The weekly retro looks for them; see `docs/diagrams/workflow.md`,
  "Self-improving loops".

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `sssoto17/sunny-pastures`, each in a milestone and on the Sunny Pastures Project with a Priority (P0–P3). Ready means the admin has chosen to focus on it now; only the admin moves an issue there, and only when it meets the definition of ready. Agents create issues in Backlog. See `docs/agents/issue-tracker.md`.

### Triage labels

Every issue carries one type (`feature`, `bug`, `spike`, `design`, `chore`, `idea`) and one `area:*` label, or `triage` until it's evaluated; PRs carry only the areas they touch. Readiness is the Project Status, and manual work carries no label. `factory:ready` is the only label that says an issue can be worked without the admin; `blocked:*` says why an issue can't move yet. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

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
- Before writing TypeScript in `packages/` or `apps/`, read `docs/agents/code-style.md`: the
  module layout and the conventions no config checks (ADR-0005).
- Before running commands, read `docs/agents/sandbox.md`. It lists the sandbox pitfalls:
  `supabase` and localhost services have to run outside the sandbox. Most git commands run
  inside it; the exceptions are under "Git inside the sandbox" and "When git does need the host".
- Parallel sessions never share a branch. The main folder stays on `main` and belongs to the
  coordinating session. Any session that changes files or needs another branch works in its own
  git worktree under `.claude/worktrees/`, named `<N>-<slug>` after its issue (use the worktree
  tool before the first edit). Never `git checkout` or `git switch` in the main folder. A
  `PreToolUse` hook (`.claude/hooks/block-branch-switch.sh`) enforces this: in the main folder it
  denies branch switches and a top-level `cd` into a worktree.
- The coordinating session (the main folder) briefs, dispatches reviewers, relays and keeps the
  board (`.claude/skills/today/SKILL.md`, "After the agenda: coordinator mode"). Work that crops
  up becomes a brief in `.scratch/` for a lane, not an edit. After each
  completed task it gives a short status: today's agenda, what's done, what's left in order. A
  session that finishes an issue asks "close #N?" in the same report. A `PreToolUse` hook
  (`.claude/hooks/block-coordinator-work.sh`) backs this up: in the main folder it denies the
  file tools and the common shell writes (redirects, `sed -i`, `cp`, `mv`, `rm` and the like) on
  repo files outside `.scratch/` and `.remember/`, commits and opening PRs; filing issues stays
  allowed. It can't catch every write, so the standard above is what holds. Both hooks skip
  remote sessions (`CLAUDE_CODE_REMOTE=true` or `GITHUB_ACTIONS=true`: cloud sessions, routines,
  factory and reviewer jobs), which have no main folder.
- Check before you state. Verify a claim about the board, the repo or the tools (an issue's
  blockers, a skill's name, what a doc or rule requires) with a command first, not from memory.
  Review a results PR against every step of the rule or criteria it reports on.
- A mistake that happens twice is a missing safeguard: mechanical mistakes become checks (lint
  rule, Fallow boundary, test, CI step), judgement calls become standards (this file or
  `CONSTRAINTS.md`). The weekly retro looks for them; see `docs/diagrams/workflow.md`,
  "Self-improving loops".
- Every review follows `REVIEW.md`, read from `origin/main`: a reviewer the coordinator
  dispatches, a lane's own review when `/implement` reaches `code-review` (a self-review), and
  the CI reviewer App. Its mechanism (approvals, `review:admin`, merges) is ADR-0002 (area 2).
  Agents never merge a PR, never turn on auto-merge by hand, never bypass a ruleset and never
  remove `review:admin`. When a PR meets a row of
  `CONSTRAINTS.md`, "Admin review (escalation and split size)", add the label as you open it:
  `gh pr create --label review:admin`. The admin merges admin-review PRs in the UI. The permission
  rules in `.claude/settings.json` (PR #52) ask before `gh pr merge`, `gh ruleset` and removing
  `review:admin`, and deny `gh pr merge --admin`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `sssoto17/sunny-pastures`, each in a milestone and on the Sunny Pastures Project with a Priority (P0–P3). Ready means the admin has chosen to focus on it now; only the admin moves an issue there, and only when it meets the definition of ready. Agents create issues in Backlog. See `docs/agents/issue-tracker.md`.

### Triage labels

Every issue carries one type (`feature`, `bug`, `spike`, `design`, `chore`, `idea`) and one `area:*` label, or `triage` until it's evaluated; PRs carry only the areas they touch, plus `review:admin` when they need the admin. Readiness is the Project Status, and manual work carries no label. `factory:ready` is the only label that says an issue can be worked without the admin; `blocked:*` says why an issue can't move yet. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

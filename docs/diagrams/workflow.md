# Workflow

How work moves from an idea to merged code, and which skill runs at each step. Addy Osmani's
skills own the gates (constraints, spec, plan, review, ship). Matt Pocock's skills own the design
depth and the tracker loop (grilling, domain language, deep modules, tickets, implementation,
retros). Each job has exactly one owning skill.

Last changed: 2026-11-07 (real skill names instead of command aliases, #34; Stage 0: everything
below is started by hand).

Every name below is a skill in `.claude/skills/`, except `remember:remember`, which comes from the
`remember` plugin. `/clear` and `/compact` are built-in commands, and `/today` is a planned command
(see **Automation stages**).

## The loops

```mermaid
flowchart TB
  subgraph M["Milestone loop: every 1–2 weeks"]
    direction TB
    G["grill-with-docs<br/>+ domain-modeling, codebase-design<br/>→ GLOSSARY.md, ADRs"]
    Q{"Settled in<br/>conversation?"}
    P["prototype<br/>branch prototype/‹name›"]
    R["research<br/>background agent → cited .md"]
    S["spec-driven-development<br/>→ docs/requirements/spec.md"]
    PL["planning-and-task-breakdown<br/>→ docs/plans/NN-‹slug›.md"]
    T["to-tickets → GitHub issues<br/>milestone · Week · Track · Mode · Size"]
    G --> Q
    Q -- "needs a runnable answer" --> P
    P -- "what it taught" --> G
    Q -- "needs facts" --> R
    R -- "findings" --> G
    Q -- "yes" --> S --> PL --> T
    Q -. "spike or small chunk" .-> T
  end

  subgraph D["Daily loop"]
    direction TB
    AM["Morning: read the handoff + This week board<br/>pick ≤ 3 outcomes"]
    F["Factory items: launch first"]
    B["Manual items: brief → fresh session"]
    I["implement #N<br/>drives tdd + code-review"]
    PR["Pull request"]
    MR{"You review<br/>and merge"}
    PM["Evening: update the board<br/>light retro · remember:remember handoff"]
    AM --> F
    AM --> B
    F --> PR
    B --> I --> PR --> MR --> PM
  end

  subgraph W["Weekly: last project day"]
    direction TB
    ICA["improve-codebase-architecture<br/>→ deepening candidates"]
    RT["retro → docs/retros/YYYY-MM-DD.md"]
  end

  subgraph GATE["Milestone gate: slice 29 Nov · freeze 20 Dec · hand-in 5 Jan"]
    direction TB
    RV["code-review-and-quality + security-and-hardening<br/>test-driven-development + browser-testing-with-devtools:<br/>browser smoke test"]
    SH{"shipping-and-launch<br/>go or no-go"}
    RV --> SH
  end

  T -- "tickets on the board" --> AM
  PM -- "next day" --> AM
  PM -- "end of week" --> ICA
  ICA -- "the candidate you pick" --> G
  ICA --> RT
  RT -. "environment fixes" .-> D
  PM -- "milestone done" --> RV
  SH -- "go: playtest or hand-in" --> G
  SH -- "no-go: fix tickets" --> AM

  classDef decide fill:#e3ab4b33,stroke:#b0731a,stroke-width:2px
  class Q,MR,SH decide
```

Gold diamonds are your decisions. Every PR is merged by you, factory PRs included.

## When to use what

| When | Skill | Produces | You decide |
|---|---|---|---|
| Once, week 1 | `setup-matt-pocock-skills` (done) | `docs/agents/*.md` | tracker settings |
| | Addy `constraint-driven-development` (done, #34) | `CONSTRAINTS.md` | the quality bar |
| Start of a milestone | `grill-with-docs` (+ `domain-modeling`, `codebase-design`) | `GLOSSARY.md`, ADRs (pattern + alternatives) | every design decision |
| ↳ needs a runnable answer | `prototype` | `prototype/<name>` branch, never merged | what it taught |
| ↳ needs facts | `research` (background) | cited `.md` | nothing: it feeds the grill |
| | Addy `spec-driven-development` | `docs/requirements/spec.md` (living, doubles as the requirements chapter) | edit and approve |
| | Addy `planning-and-task-breakdown` | `docs/plans/NN-<slug>.md`, frozen once published | approve the plan |
| | `to-tickets` | GitHub issues with native blocking edges, on the Project | nothing: it publishes |
| Daily, per ticket | `implement #N` in a fresh session (drives `tdd`, `code-review`) | PR | review and merge |
| ↳ high stakes: sim determinism, authority, RLS | Addy `doubt-driven-development` | adversarial review | |
| ↳ framework APIs: Next, Drizzle, Supabase | Addy `source-driven-development` | docs-verified code | |
| ↳ module or API shape | Addy `api-and-interface-design` + `codebase-design` | interface sketch | the interface |
| ↳ something broke | `diagnosing-bugs` | regression test + fix | |
| ↳ only the admin can do it | `wizard` | setup script; issue gets `blocked:admin` until done | |
| Weekly | `improve-codebase-architecture` | deepening candidates | which one to pick |
| | `retro` (see **Weekly retro convention**) | `docs/retros/YYYY-MM-DD.md`, new checks and standards | which fixes to adopt |
| Milestone gate | Addy `code-review-and-quality` + `security-and-hardening`, `test-driven-development` + `browser-testing-with-devtools`, `shipping-and-launch` | go/no-go with rollback plan | go or no-go |
| After playtests | `triage` | feedback turned into ready issues | what's worth doing |
| End of day | `remember:remember` (plugin) | handoff with the top 3 next | |

Not used, because another skill owns the job: Addy `interview-me` and `idea-refine`
(`grill-with-docs`), Matt `to-spec` (`spec-driven-development`), Addy `incremental-implementation` (`implement`), Addy
`documentation-and-adrs` (`domain-modeling`). `wayfinder` stays in reserve for an effort too foggy
for one grill.

## Self-improving loops

The project should get harder to break over time. A mistake that happens twice is a missing
safeguard. Matt's rule decides the kind of safeguard: **mechanical mistakes become checks**
(a lint rule, a Fallow boundary, a test, a CI step), **judgement calls become standards** (a line
in `AGENTS.md` or `CONSTRAINTS.md`, a coding standard `code-review` enforces). Add the safeguard
as early as possible: the cheapest moment is the first repeat.

| Loop | Output of | Feeds |
|---|---|---|
| Complexity and coupling | Fallow hotspots, duplication, cycles | weekly `improve-codebase-architecture` candidates |
| Property failures | fast-check's shrunk counterexample | a named regression test kept next to the property |
| Repeated review findings | `code-review` flagging the same kind of issue twice | a check or a standard, via `retro` |
| Playtests | tester feedback | `triage` → `ready` issues; the next grill may reopen a MoSCoW item |
| Load tests | Locust latency and storage numbers | response-time limits in `docs/requirements/spec.md`, so later runs check against measured numbers |
| Repeated manual steps | daily routine, noted in retros | the next automation stage (`/today`, factory) |

**Weekly retro convention.** Besides "what went well and what didn't", every weekly `retro` asks:

1. Which mistakes or review findings happened more than once? Turn each into a check or a
   standard, and record which one in the retro file.
2. Which manual steps did I repeat? Note each one with its count toward the 3-repetition rule.
3. Which tool output isn't feeding anything yet? Propose the loop that would use it.

Each answer becomes an issue or a direct change in the same week, never only a note.

## Daily routine (Stage 0)

Morning, about 10 minutes:

1. Read the handoff the session starts with.
2. Open the **This week** board. Pick at most 3 outcomes (usually 1 design and 1–2 build) and
   move them to **Ready**. Ready is your focus; everything else stays in Backlog.
3. Launch Factory items first, so agents work while you design.
4. For each Manual item, write a brief and open a fresh session in the repo:

   ```
   Work in a worktree named <N>-<slug>.
   Work on #N: <one-line goal>.
   Read first: <files, ADRs, links>.
   Decided: <settled points, with links>.
   Start with: <skill>.
   Report back: <PR link, check output, open questions>.
   ```

During the day, at each phase boundary choose, in this order: continue · subagent · `/clear` ·
`/compact` · `handoff` (only for a new directory, harness or mid-phase side task).

**Parallel sessions.** One folder can only have one branch checked out, so two sessions in the
same folder change each other's files underneath them. The main folder stays on `main` for the
coordinating session; every work session gets its own git worktree under `.claude/worktrees/`
(the session's worktree tool creates one on a new branch from `origin/main`).

- Each worktree needs its own `pnpm install` once the repo has dependencies. The pnpm store is
  shared, so it's fast.
- The local Supabase stack is one per machine and shared by every worktree.
- `.git` writes (worktrees, commits, pushes) run outside the sandbox.

Evening, about 10 minutes:

1. Update the board: statuses, `blocked:*` labels with their reason.
2. A light `retro` if you built something. Note any step you repeated by hand.
3. Remove the worktrees whose PRs have merged: check `git worktree list`, then
   `git worktree remove .claude/worktrees/<name>`.
4. `remember:remember` handoff with the top 3 next.

## Automation stages

| Stage | When | What runs |
|---|---|---|
| 0 | now | Everything above, by hand. Note repeated steps in each retro. |
| 1 | ~week 2 | Read-only `/today`: handoff + this week's board → brief, agenda, a brief per Manual item, a prompt per Factory item. |
| 2 | ~week 3 | Billetto-style gather script, background review agents, action batch, check every ~75 min, `/today wrap`. |

Automate a step only after doing it by hand 3 times with the same result.

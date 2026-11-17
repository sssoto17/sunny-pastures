# Labels

Labels on issues and PRs in this repo: what each means, when to use it, and how the skills'
canonical triage roles map onto them. Decided in #18.

Labels carry what a Project field can't: they show on PRs and in `gh` queries. Anything already a
Project field (Status, Track, Mode, Size, Priority, Week) stays a field and never becomes a label.

## Naming and colours

- A **type** is a bare label with its own colour.
- Every other label is `prefix:value`, and all labels with one prefix share one colour.
- No new prefix without the admin.

<!-- prettier-ignore -->
| Label | Colour |
|---|---|
| `feature` | `#0E8A16` |
| `bug` | `#D73A4A` |
| `spike` | `#006B75` |
| `design` | `#D4C5F9` |
| `chore` | `#BFDADC` |
| `idea` | `#F9D0C4` |
| `area:*` | `#1D76DB` |
| `triage` | `#FBCA04` |
| `blocked:*` | `#B60205` |
| `factory:*` | `#D93F0B` |
| `wayfinder:*` | `#5319E7` |
| `review:*` | `#C5DEF5` |

## Types

Every issue carries **exactly one type** label, set when it's filed, and the GitHub native issue
type in the last column (`issue-tracker.md`, **Issue fields**). The scripts read the mapping from
`scripts/lib/issue-types.sh`, which must match this table, and each issue form sets the same native
type with its `type:` key (#254; `.github/scripts/tests/issue-forms.test.mjs` checks the forms); it
was set by the admin on 15 Nov 2026 (#266). PRs carry no type label: the Conventional Commit prefix
in the PR title is the type (see **Pull requests**).

<!-- prettier-ignore -->
| Label | Use for | Native type |
|---|---|---|
| `feature` | New behaviour for the player, the admin or the API | Feature |
| `bug` | Something that worked, or was specified, behaves wrongly | Bug |
| `spike` | Throwaway work that answers a question with measurements or a prototype; its result lands in an ADR or doc | Chore |
| `design` | Work whose output is decisions: a grill, an ADR, glossary terms, the spec. It blocks the issues that depend on it through a native dependency | Design |
| `chore` | Upkeep with no new behaviour: tooling, config, hooks, dependencies, and docs-only work | Chore |
| `idea` | Wanted but not shaped enough to build. Parked until picked up | Chore |

**`idea`** never moves to Ready. To work it, either a `design` issue that blocks it fleshes it out,
or it's retyped (`feature`, `chore`…) once its body meets definition-of-ready rules 2–5. `design` is
different: it's worked now and produces the decisions.

## Areas

Every issue carries **exactly one area**, set when it's filed: the layer the work lands in. A PR
carries **one area per area its changed files touch**, so you can see at a glance what it changes.
Set them by hand (a labeler is an automation candidate below).

<!-- prettier-ignore -->
| Label | Paths |
|---|---|
| `area:ui` | `apps/web/` outside `src/server/`: pages, components, client state |
| `area:api` | `apps/web/src/server/`, route handlers |
| `area:sim` | `packages/sim/` |
| `area:db` | `supabase/`, the Drizzle schema, migrations, RLS |
| `area:ci-cd` | `.github/`, deploy config, root config (`package.json`, `pnpm-workspace.yaml`, lockfile…) |
| `area:tools` | All dev tooling: `tools/` (`load/`, `analysis/`), `scripts/`, `.claude/` (hooks, skills, agents, settings), `.agents/` (vendored skills) |
| `area:docs` | `docs/`, `GLOSSARY.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` |

- `tests/acceptance/` and `prototypes/<name>/` take the area of what they test or prototype (a
  persistence store prototype is `area:db`).
- An issue takes the area its work serves, not where its notes end up: a grill takes the area it
  designs, an environment for the load matrix is `area:tools`. Docs-only work is `area:docs`.
- There is no security or ops area: that work takes the layer it touches.

## Triage

<!-- prettier-ignore -->
| Label in mattpocock/skills | Label in our tracker | Meaning |
| -------------------------- | -------------------- | ------- |
| `needs-triage`             | `triage`             | Needs evaluation before it can be worked |
| `needs-info`               | a `blocked:*` label  | Can't move until the reason named below clears |
| `ready-for-agent`          | `factory:ready`      | Fully specified; the factory may pick it up without the admin |
| `ready-for-human`          | no label             | The default. Readiness is the Project **Status** `Ready` (see `issue-tracker.md`, **Status rules**) |
| `wontfix`                  | no label             | Close with `gh issue close <n> --reason "not planned" --comment "<why>"` |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the label string from
this table. A role with no label means: remove `triage` if present and set the Status the role
implies.

This is a solo project: every issue is written by the owner, so there's no reporter to wait on and
nothing to reject by label. Work is manual by default and carries no label for it.

**`triage`** marks an issue missing its native type, Priority, Size or Week. Who sets those, and
what adds and removes the label, is `issue-tracker.md`, **Issue fields**.

## Blocked

A `blocked:*` label says why an issue can't be worked, or can't be queued for the factory, yet.
Remove it when the reason clears. An issue may carry more than one.

<!-- prettier-ignore -->
| Label | Use when |
|---|---|
| `blocked:decision` | A quick call by the admin, answerable in a comment, is still open. A decision that needs real design work is a `design` issue that blocks this one instead |
| `blocked:external` | It waits on something outside the project: a service, a person, upstream |
| `blocked:admin` | Only the admin can do it: config, secrets, protected files, dashboards |

An issue blocked by another issue uses GitHub's native issue dependencies (see `issue-tracker.md`,
**Blocking**), not a label.

**A new `blocked:*` label must be added to the Project's Blocked view by hand.** The view lists the
labels by name (`label:blocked:decision,blocked:external,blocked:admin`), because a `blocked:*`
wildcard wasn't confirmed to work (ADR-0002, area 5, "Views"). Add the label to this table and to
the view's filter together.

## Factory and reserved prefixes

- **`factory:ready`** is the only label that says an issue can be worked without the admin in the
  loop; when you apply it, also set the issue's Project **Mode** to `Factory`. The Mode field
  (Manual / Factory) is the top-level split; `factory:*` labels scope factory work further.
- **`factory:*`**: more states arrive with the factory itself (e.g. `factory:changes`). They're
  designed with the factory, not created ahead of time.
- **`wayfinder:*`**: `wayfinder:map` and `wayfinder:<type>` (`research`, `prototype`, `grilling`,
  `task`), created by `/wayfinder` when a map is charted (see `issue-tracker.md`, **Wayfinding
  operations**). Not created ahead of time.

## Pull requests

A PR carries area labels (see **Areas**), plus `review:admin` when it needs the admin.
`review:admin` says a PR needs the admin's approval. When a PR gets it is set by the escalation
criteria in `CONSTRAINTS.md` ("Admin review"). Code-owned PRs carry it too, so the label is the one
queue of PRs waiting for the admin. Any agent may add it, and so may the reviewer bot. The bot never
approves a PR that carries it, and only the admin removes it (ADR-0002, area 2). Added 7 Nov by the
admin; widened to code-owned PRs in #47.

A PR's type is its title's Conventional Commit prefix, which is also the squash-commit message:

<!-- prettier-ignore -->
| Issue type | PR title prefix |
|---|---|
| `feature` | `feat:` |
| `bug` | `fix:` |
| `chore` | `chore:`, or `docs:` for docs-only work |
| `design` | `docs:` (its decisions land as docs) |
| `spike` | `spike:` (spike PRs often don't merge) |

`idea` and `triage` issues don't get PRs.

## Automation candidates

Nothing here is automated yet. Per the 3-repetition rule (`docs/diagrams/workflow.md`), a step is
automated after it's been done by hand 3 times with the same result. Each candidate's count is the
number of times it has been done by hand; the weekly retro updates the counts and files an issue
when one reaches 3.

<!-- prettier-ignore -->
| Candidate | What it would do | By hand so far |
|---|---|---|
| Path labeler | A GitHub Action that sets a PR's `area:*` labels from the path table above | 1 |
| PR-title check | A CI check that a PR title uses one of the prefixes above | 0 |
| Mode ↔ `factory:ready` sync | Keep the Project's Mode field and the `factory:ready` label in step | 0 |

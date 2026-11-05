# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## Project board and milestones

Every issue belongs to the **Sunny Pastures** Project (user project `3`, owner `sssoto17`) and to one repo milestone (`M1 Persistence spike` … `M9 Hand-in`; list them with `gh api repos/sssoto17/sunny-pastures/milestones --jq '.[].title'`).

- **Create with a milestone**: `gh issue create --milestone "<milestone title>" ...`
- **Add to the Project**: `gh project item-add 3 --owner sssoto17 --url <issue-url> --format json --jq .id` returns the item id.
- **Set a field**: `gh project item-edit --project-id PVT_kwHOCI1msM4BqXYM --id <item-id> --field-id <field-id> --single-select-option-id <option-id>` (or `--iteration-id <id>` for Week).

| Field  | Field id                         | Options (name = option id)                                                                 |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------ |
| Status | `PVTSSF_lAHOCI1msM4BqXYMzhou1Sw` | Backlog=`97a20eba` Ready=`eb23e874` In progress=`03b81b61` In review=`e763de54` Done=`04fb4a2b` |
| Track  | `PVTSSF_lAHOCI1msM4BqXYMzhou1gg` | Build=`60e95dc9` Design=`df832856` Report=`d064f0c0` Infra=`3200c1d7` Evaluation=`145afb58` |
| Mode   | `PVTSSF_lAHOCI1msM4BqXYMzhou1g0` | Manual=`ca9bd7b8` Factory=`f92520e5`                                                       |
| Size   | `PVTSSF_lAHOCI1msM4BqXYMzhou1g4` | S=`7a7f9f73` M=`e0e2efb6` L=`c7dede81`                                                     |
| Priority | `PVTSSF_lAHOCI1msM4BqXYMzhowjRE` | P0=`598fd74b` P1=`ad39d061` P2=`a38a49d8` P3=`cad16246`                                  |
| Week   | `PVTIF_lAHOCI1msM4BqXYMzhou1aQ`  | iteration ids: `gh api graphql -f query='{node(id:"PVTIF_lAHOCI1msM4BqXYMzhou1aQ"){... on ProjectV2IterationField{configuration{iterations{id title startDate}}}}}'` |

When a skill publishes tickets, give each one a milestone, add it to the Project, and set Track, Mode, Size, Priority and Week. Mode is `Manual` unless the ticket carries `factory:ready`. Status is `Backlog` unless the ticket meets every Ready criterion below.

## Priority

Priority orders work inside a milestone; MoSCoW (`docs/requirements/moscow.md`) decides scope. They are separate: a Could can be P0 for the week it's being built.

| Priority | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| P0       | Blocks the current milestone or the critical path: do it first       |
| P1       | Needed for the current milestone                                     |
| P2       | Wanted this milestone; slips if P0 or P1 work needs the time         |
| P3       | Whenever there is slack                                              |

## Status rules

**Backlog → Ready** only when every one of these holds (the definition of ready):

1. **Fields set**: milestone, Track, Mode, Size, Priority and Week.
2. **Checkable outcome**: the body states the goal and a "Done when" list that a reviewer can verify (a test, a command, a file, a number).
3. **Fits one session**: Size is S or M. An L is split into smaller issues first.
4. **Unblocked**: no `blocked:*` label, and every native blocker is closed.
5. **No open decision**: the decisions it rests on are recorded (ADR, `GLOSSARY.md`, `SPEC.md`) and linked. If working it would mean making a new design decision, it gets `blocked:decision` or a grill instead.

**`factory:ready`** additionally requires all of:

- no step needs the admin (no secrets, dashboards or manual setup);
- it doesn't touch protected paths: `tests/acceptance/`, `.github/`, config files, `AGENTS.md`, `CONSTRAINTS.md`;
- every "Done when" item is verified by CI alone.

**The other moves:**

| Move                     | When                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Ready → In progress      | Someone starts it: the admin is assigned (manual), or the factory claims it (factory). A branch exists. |
| In progress → In review  | A PR is open with `Closes #N` and its checks are green.                                   |
| In review → Done         | The admin merged the PR (the issue closes, and the Project moves it).                     |
| Any → Backlog            | It turns out not ready: add the `blocked:*` label that says why, or split it.            |

A skill may create an issue directly in `Ready` only when it meets every Ready criterion; otherwise it starts in `Backlog` and the admin promotes it.

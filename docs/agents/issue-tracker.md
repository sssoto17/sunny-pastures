# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations. In a
cloud lane, `gh issue`, `gh pr` and `gh project` fail (they use GraphQL, which the cloud proxy
refuses): use `gh api` over REST there. `docs/agents/github-rest.md` lists the equivalents, and the
scripts below already use them.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line
  bodies. The coordinating session files through `scripts/new-issue.sh` instead: labels, native
  issue type, milestone, parent and Project fields in one checked command (`--help`; tests:
  `bash scripts/new-issue.test.sh`). Whoever files an issue sets its four fields as **Issue fields**
  below says.
- **Read an issue**:
  `gh api repos/sssoto17/sunny-pastures/issues/<number> --jq '{number, title, body, labels: [.labels[].name]}'`,
  and its comments with
  `gh api repos/sssoto17/sunny-pastures/issues/<number>/comments --jq '.[].body'` (REST, so it works
  in a cloud lane too).
- **List issues**:
  `gh api --paginate "repos/sssoto17/sunny-pastures/issues?state=open&per_page=100" --jq '.[] | select(has("pull_request") | not) | {number, title, labels: [.labels[].name]}'`
  with `labels=<a,b>` and `state=` in the query to filter (REST lists PRs too, hence the select).
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or
  `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`:
  `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`
  (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of
  the child body.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Checkboxes

Use a checkbox only for an item someone will tick; write yes/no facts as plain lines. An unticked
box reads as work still waiting, so a box that means "doesn't apply" when left empty misleads the
reader. The admin's rule of 12 Nov (#214), for issue and PR bodies alike.

- **Items to tick:** an issue's "Acceptance criteria" (every issue template) and a PR's "How it was
  verified". A lane ticks its own PR's boxes as it meets them.
- **Who ticks an issue's criteria:** the coordinator, from the reviewer's "Criteria confirmed" list
  (`REVIEW.md`, "Report"), before giving the admin the verdict. It ticks each criterion the reviewer
  confirmed, and only those. A criterion the reviewer left unverified stays unticked, and the relay
  to the admin names it with the reviewer's reason. On a split, only the closing part's review ticks
  criteria.
- **Plain lines:** facts such as the PR template's Review section, `Admin review: no` or
  `Admin review: yes (rows: Code-owned path)`, and `Code-owned paths: none` or
  `Code-owned paths: .github/… (admin asked in #N)`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature
requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr`
equivalents:

- **Read a PR**:
  `gh api repos/sssoto17/sunny-pastures/pulls/<number> --jq '{number, title, body, state, head: .head.ref}'`,
  its comments with `gh api repos/sssoto17/sunny-pastures/issues/<number>/comments --jq '.[].body'`,
  and the diff with
  `gh api repos/sssoto17/sunny-pastures/pulls/<number> -H 'Accept: application/vnd.github.diff'`
  (REST, so it works in a cloud lane too).
- **List external PRs for triage**:
  `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`,
  `gh pr close`.
- **Answer a review finding** with `gh pr comment`, never a review (`gh pr review`) or a reply on
  the review thread (REVIEW.md, Conduct; #497). The hook `block-thread-resolve.sh` refuses both.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with
`gh api repos/sssoto17/sunny-pastures/issues/42 --jq 'has("pull_request")'`, which answers for both.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
  `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a
  sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map
  body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>`
  (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving
  dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation.
  Add an edge with
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`,
  where `<blocker-db-id>` is the blocker's numeric **database id**
  (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub
  reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where
  dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the
  child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children
  (`gh api repos/sssoto17/sunny-pastures/issues/<map>/sub_issues --jq '.[] | select(.state == "open")'`,
  or the issues its task list names), drop any with an open blocker
  (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an
  assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a
  context pointer (gist + link) to the map's Decisions-so-far.

## Project board and milestones

Every issue belongs to the **Sunny Pastures** Project (user project `3`, owner `sssoto17`) and to
one repo milestone (`M1 Persistence spike` … `M9 Hand-in`; list them with
`gh api repos/sssoto17/sunny-pastures/milestones --jq '.[].title'`).

- **Create with a milestone**: `gh issue create --milestone "<milestone title>" ...`
- **Add to the Project and set its fields**: one command, with names, not ids:

  ```bash
  scripts/issue-fields.sh 47 --type Chore --track Infra --mode Manual --size S --priority P2 --week "Wk 2"
  ```

  It adds the issue to the Project if it's missing, sets each field you name, then reads the item
  back, prints the fields and exits 1 if one doesn't show the value it set. Every flag is optional.
  It looks the field and option ids up from GitHub on each run. An unknown name (`--size XL`) fails
  with the valid names before anything is written. `scripts/issue-fields.sh --help` lists the rest.
  Don't set fields with hand-written `gh project item-add` / `item-edit` loops: on 7 Nov one
  silently left 5 of #47's fields unset under zsh. Tests: `bash scripts/issue-fields.test.sh` (needs
  zsh).

  - **Status**: a new item, or one with no Status, gets `Backlog`. A Status already set is left
    alone unless you pass `--status`, so fixing a field never undoes the admin's move to Ready.
    `--status Backlog` moves an issue back, as the **Any → Backlog** move in **Status rules**
    allows. Decided by the admin on 7 Nov (#56).
  - **Admin-only values are refused**: `--status Ready` (see **Status rules**) and `--mode Factory`
    (it goes with `factory:ready`, see `triage-labels.md`).
  - **`--from` makes a guarded move** (#417), the form the board workflow uses (**Status rules**):
    `--status "In review" --from "Ready,In progress"` sets Status alone, and only when the issue is
    on the Project and its Status is now one of the `--from` names. Otherwise it changes nothing,
    says why and exits 0. It never adds the issue to the Project, never removes `triage`, takes no
    other field, and refuses Backlog in `--from`, so it never moves an issue out of Backlog.
  - **`PROJECT_GH_TOKEN`**, when set, is the token for the Project's calls only; the issue's calls
    keep `gh`'s own. The board workflow keeps its Project token off the repo's endpoints that way.
  - **`--type`** sets GitHub's native issue type (Chore, Bug, Feature, Design) on the issue itself.
    Once the type, Priority, Size and Week are all set, the script removes `triage` and its
    `Triage:` line says so (see **Issue fields**).
  - **In a cloud lane** the Project can't be reached (the proxy refuses it with a 403): the script
    sets `--type`, skips the Project, prints the command that finishes it from a local session, and
    exits 4. `scripts/new-issue.sh` files the issue all the same and exits 4 too.

The GraphQL node ids, for reading raw `gh project` output (the scripts don't use this table; the
REST Projects API numbers its fields instead: `gh api users/sssoto17/projectsV2/3/fields`):

<!-- prettier-ignore -->
| Field  | Field id                         | Options (name = option id)                                                                 |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------ |
| Status | `PVTSSF_lAHOCI1msM4BqXYMzhou1Sw` | Backlog=`97a20eba` Ready=`eb23e874` In progress=`03b81b61` In review=`e763de54` Done=`04fb4a2b` |
| Track  | `PVTSSF_lAHOCI1msM4BqXYMzhou1gg` | Build=`60e95dc9` Design=`df832856` Report=`d064f0c0` Infra=`3200c1d7` Evaluation=`145afb58` |
| Mode   | `PVTSSF_lAHOCI1msM4BqXYMzhou1g0` | Manual=`ca9bd7b8` Factory=`f92520e5`                                                       |
| Size   | `PVTSSF_lAHOCI1msM4BqXYMzhou1g4` | S=`7a7f9f73` M=`e0e2efb6` L=`c7dede81`                                                     |
| Priority | `PVTSSF_lAHOCI1msM4BqXYMzhowjRE` | P0=`598fd74b` P1=`ad39d061` P2=`a38a49d8` P3=`cad16246`                                  |
| Week   | `PVTIF_lAHOCI1msM4BqXYMzhou1aQ`  | iteration ids: `gh api users/sssoto17/projectsV2/3/fields --jq '.[] \| select(.name == "Week") \| .configuration.iterations[] \| [.id, .title.raw, .start_date] \| @tsv'` |

When a skill publishes tickets, make each one a sub-issue of its workstream parent (see
**Grouping**), give it a milestone, add it to the Project and set the native type, Track, Mode,
Size, Priority and Week (all with `scripts/issue-fields.sh`), and add one type and one area label
(see `triage-labels.md`). The type, Size, Priority and Week are the skill's proposal (see **Issue
fields**). Mode is `Manual` unless the ticket carries `factory:ready`. Status is always `Backlog`:
only the admin moves an issue to `Ready` (see **Status rules**).

## Issue fields

Every issue carries four values: GitHub's native **issue type**, and the Project's **Priority**,
**Size** and **Week**. The admin's rule of 12 Nov (#158); the other docs point here.

- **The filer proposes, the admin confirms.** The agent that files an issue sets all four when
  filing; they're its proposal. The issue lands in Backlog, and the admin confirms or changes them
  when moving it to Ready, which only the admin does (**Status rules**).
- **`triage` while one is missing.** An issue missing any of the four carries `triage` until all
  four are set. `scripts/new-issue.sh` adds it when one isn't given, and `scripts/issue-fields.sh`
  removes it once all four are set.
- **The native type follows the type label**, and the label stays: `feature` → Feature, `bug` → Bug,
  `design` → Design, and `spike`, `chore`, `idea` → Chore (the repo offers Chore, Bug, Feature and
  Design; the admin's mapping of 15 Nov, #266). The mapping is the Types table in
  `triage-labels.md`, and the scripts share it in `scripts/lib/issue-types.sh`. The issue forms set
  the same type with `type:` (#254), so an issue filed in the web UI gets it too. `new-issue.sh` and
  `backfill-issue-types.sh` stop with a message naming the difference when the repo's types and that
  mapping disagree, so a rename is caught on the next run. `scripts/backfill-issue-types.sh` sets
  the type on open issues whose type doesn't follow their label (none, or another type), from that
  label: a dry run by default, `--apply` to write (`--help`; tests:
  `bash scripts/backfill-issue-types.test.sh`). The admin runs it.
- **No exceptions**: a workstream parent carries all four too (**Grouping**).
- **`scripts/missing-fields.sh`** lists the open issues that break this rule: a field missing (and
  whether `triage` is on), or `triage` on an issue whose fields are set. It exits 0 when there are
  none, 1 when it lists some, 2 on bad arguments, 3 when GitHub can't be read, and 4 when GitHub
  refuses the Project (a cloud lane): then it lists only the issues missing a type and names the
  checks it skipped. It is read-only (`--help`; tests: `bash scripts/missing-fields.test.sh`).

## Workstreams

A **workstream** is one goal, worked as a set of tickets under a parent issue. It may span
milestones. Every workstream starts with the same kickoff.

### Grouping

Every issue sits under a workstream parent (the admin's rule of 7 Nov, recorded in #55; written here
by #76). The milestone still gives each ticket its due date; the parent groups tickets by goal.

- **The parent** is an issue named for the workstream's goal, with no milestone prefix (for example
  #72 "Sim properties", #58 "CI/CD pipeline"). It's in a milestone and on the Project with Track and
  Mode set, carries the four fields every issue does (**Issue fields**), and has one type and one
  area label. Its body states the goal and an "Acceptance criteria" list, and links the ADRs and PRs
  it rests on.
- **It may span milestones**: its tickets keep their own milestones (#58 sits in M4 and has tickets
  in M2, M3 and M4).
- **Its tickets are its sub-issues** (see **Make an issue a sub-issue of a parent**). A new ticket
  goes under the parent of the goal it serves. If no workstream fits, frame a new parent first
  (**Kickoff** step 1), or ask the admin which one it belongs to.
- **An issue found without a parent gets one**, whenever it's found, however long it's been
  published. `scripts/orphan-issues.sh` lists the open issues with none; `/today` stage 1 (#78) is
  to run it.
- A parent is never worked directly. It closes when its last sub-issue closes.

Three kinds of issue have no parent: top-level parents themselves, `idea` issues (parked until
picked up; they get a parent when retyped) and the Retro inbox (#55), which collects notes for every
workstream. A **top-level parent** is an issue with no parent and at least one sub-issue, open or
closed, that isn't a `wayfinder:map`: a map has sub-issues too, but it sits under its workstream's
parent (**Kickoff** step 2), so a parentless map is listed. A parent just framed (**Kickoff**
step 1) shows in the orphan list until its first ticket is added (step 4).

`scripts/orphan-issues.sh` prints one `#<number>`, tab, title line per issue without a parent, and
exits 0 when there are none, 1 when it lists some, 2 on bad arguments and 3 when GitHub can't be
read. It's read-only. `scripts/orphan-issues.sh --help` gives the exact exclusions. Tests:
`bash scripts/orphan-issues.test.sh`.

### Kickoff

Before any ticket exists, a workstream goes through design and idea refinement, in this order:

1. **Frame it.** Create the parent issue with the goal and the known constraints. It doesn't have to
   be complete yet.
2. **Grill it.** Pick by scope:
   - `/grill-with-docs` when the open decisions fit in one session. It resolves them and writes
     `GLOSSARY.md` terms and ADRs as they settle.
   - `/wayfinder` when they don't: the workstream is too big or too foggy for one session. The
     wayfinder map is a sub-issue of the workstream's parent, so its decision tickets stay apart
     from the build tickets. Each decision ticket can run its own `/grill-with-docs`.
3. **Set up context.** Run `/context-engineering` to decide what a fresh session needs to work any
   ticket: the ADRs, glossary terms and code areas to read first. The result goes into the parent as
   a short **Context** section. Rules files such as `AGENTS.md` change only when the workstream
   opens a new area of the repo (for example `packages/sim` in M2 or `apps/web` in M3), and only
   with the admin's approval.
4. **Ticket it.** Run `/to-tickets` from the grill's outcome. The tickets become sub-issues of the
   parent.

## Priority

Priority orders work inside a milestone; MoSCoW (`docs/requirements/moscow.md`) decides scope. They
are separate: a Could can be P0 for the week it's being built.

<!-- prettier-ignore -->
| Priority | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| P0       | Blocks the current milestone or the critical path: do it first       |
| P1       | Needed for the current milestone                                     |
| P2       | Wanted this milestone; slips if P0 or P1 work needs the time         |
| P3       | Whenever there is slack                                              |

## Status rules

**Ready means "chosen for now".** The Ready column holds only what the admin has decided to focus on
at the moment; Backlog holds everything else, including issues that could be worked but aren't
wanted yet. Keep Ready short: roughly what fits the next one or two project days. Only the admin
moves an issue to Ready; skills and agents create issues in Backlog and never promote them.

The admin may move an issue **Backlog → Ready** only when it is chosen _and_ every one of these
holds (the definition of ready):

1. **Fields set**: milestone, native issue type, Track, Mode, Size, Priority and Week, plus one type
   and one area label (`triage-labels.md`). The admin confirms the filer's type, Priority, Size and
   Week here (**Issue fields**).
2. **Checkable outcome**: the body states the goal and an "Acceptance criteria" list that a reviewer
   can verify (a test, a command, a file, a number).
3. **Fits one session**: Size is S or M. An L is split into smaller issues first.
4. **Unblocked**: no `blocked:*` label, and every native blocker is closed.
5. **No open decision**: the decisions it rests on are recorded (ADR, `GLOSSARY.md`,
   `docs/requirements/spec.md`) and linked. If working it needs a quick call by the admin,
   answerable in a comment, it gets `blocked:decision`. If it needs real design work, a `design`
   issue blocks it through a native dependency.

An `idea` issue never moves to Ready: it's fleshed out by a blocking `design` issue, or retyped once
its body meets rules 2–5.

An issue that meets all five but isn't chosen stays in Backlog. When its last blocker closes,
nothing moves automatically: whether it becomes the focus is the admin's call.

**`factory:ready`** is also the admin's choice, to delegate rather than work it. The factory only
picks up issues that are in Ready _and_ carry `factory:ready`, and the label additionally requires
all of:

- no step needs the admin (no secrets, dashboards or manual setup);
- it doesn't touch protected paths: `tests/acceptance/`, `.github/`, config files, `AGENTS.md`,
  `CONSTRAINTS.md`;
- every item under "Acceptance criteria" is verified by CI alone.

**The other moves.** The board moves itself (#417): nobody runs a script for the rows marked
_automatic_. The workflow `.github/workflows/board.yml` does the In progress and In review rows,
through `scripts/board-status.sh` and `scripts/issue-fields.sh --from`; the Project's built-in "Item
closed" and "Pull request merged" workflows do Done. The automation never sets Ready, never moves an
issue out of Backlog, never sets Mode, and leaves an issue that isn't on the Project alone. Only the
PR that closes the issue moves it, so the `Part of #N` parts of a split or stack don't: on `main`,
the issues GitHub records the PR as closing; on another base (a stack's closing part, for which
GitHub records none until it sits on `main`), the body's closing keyword, which `guard / pr-body`
allows only on the closing part. A lane PR opens as a draft and is marked ready once linked (#358):
it's In progress as a draft, and In review once ready and green: the CI run that the ready mark
starts decides, not the mark itself. A finished check moves an issue only when the PR's checks turn
green or red; the PR's own events (opened, ready, draft, closed) do the rest.

<!-- prettier-ignore -->
| Move                     | When                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Ready → In progress      | _Automatic._ Work starts: a branch named `<N>-<slug>` is created, or a PR with `Closes #N` opens. The admin is assigned (manual), or the factory claims it (factory). |
| In progress → In review  | _Automatic._ A PR with `Closes #N` is open, not a draft, and its checks are green. Green means every check passes apart from `guard / code-owned`, which stays red on a code-owned PR until the admin approves its head, or reviews it on a PR the admin opened (admin, 21 Nov, on #417; #494). A check still running, cancelled or stale isn't green yet: a re-run decides it. A draft stays In progress until it's marked ready. |
| In review → In progress  | _Automatic._ That PR's checks go red, it turns back into a draft, or it closes unmerged. |
| In review → Done         | _Automatic._ The PR merged (the issue closes, and the Project's built-in workflow moves it). |
| Any → Backlog            | It turns out not ready (add the `blocked:*` label that says why, or split it), or the admin drops it from the current focus. |

**The coordinator only fixes a wrong status.** It no longer moves issues as PRs open and merge. When
the board shows a status the rows above don't explain (a move the workflow missed, or a run that
failed: the `board` workflow's runs show why), it sets the right one with
`scripts/issue-fields.sh <N> --status <Status>` from a local session, never Ready.

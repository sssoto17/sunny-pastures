---
status: accepted
---

# How the project uses GitHub

Sunny Pastures lives on GitHub: the code, the issues, the Project board and, from M3, CI and the
deploy hooks. Until now each piece was set up when it was first needed, and nothing protects `main`.
M2 starts on 9 Nov with the first production code in `packages/sim` and the factory, where agents
work `factory:ready` issues without the admin. Before that, this ADR settles how the repo, the board
and the platform are used, and in which order the admin turns things on.

This began as a proposal on 7 Nov. **Accepted 12 Nov 2026, after checklist steps 1–10 and #40 were
applied.** The admin applies only what they approve, using the checklist at the end. Files under
`.github/` are a protected path, so their drafts sit in the appendix and land in the admin's PRs.

**Applied so far:** checklist steps 1–8 on 8 Nov (#66), step 9 with the templates PR (#91), step 10
with the Dependabot PR (#92), and the first required checks (#40), which the admin put in a ruleset
of their own, `main checks` (area 2). Where what was applied differs from the text, a dated note
("Applied 8 Nov, #66: …") sits next to what it amends; the decision above it stays as it was
written. The rest of the checklist is not applied yet.

## How this was checked

The current state below was read on 7 Nov 2026 from the repo, `git log`, the GitHub REST API and
GraphQL (read-only calls), docs.github.com and its source (the `github/docs` repository), GitHub's
Terms of Service, and Vercel's docs. Each claim carries its source and "checked 7 Nov". The two
claims that couldn't be confirmed from a primary source are marked _(not re-checked)_: two Project
workflow names (area 5) and the Repository admin role's ID (checklist step 3).

**Checked locally on 7 Nov** (a second session on the admin's machine, `gh` with the `repo` and
`project` scopes, read-only `GET` and GraphQL queries only):

- Environments, Actions permissions, secrets, variables, Dependabot settings, webhooks, deployments
  and commit signatures were read from the REST API. Secrets and variables were listed by name and
  count only.
- The Project's workflows, views and fields were read through GraphQL.
- The account's plan couldn't be read by API: `gh api user --jq .plan.name` returns `null`, because
  the token lacks the `user` scope. The admin answered Q1 instead (below).

**The admin's answers, 7 Nov:**

- **Q1:** the account is on **GitHub Pro**, through a verified GitHub Education student account. The
  repo stays **private until about M3–M4**, then goes public (#38).
- **Q2:** the factory gets **its own identity**. How it reaches GitHub is spike #37 (area 2).
  _Decided 8 Nov in #37:_ its own GitHub App, `sunny-factory`, from Actions on GitHub-hosted
  runners, beside the reviewer's App.
- **Q7 and Q8** are decided together when the repo goes public (#38).
- **Q9:** `area:tools` widens to cover all dev tooling (area 6).
- **Approvals:** PRs are reviewed the way people on GitHub review each other. A reviewer bot, its
  own GitHub App, **approves** a PR, which then auto-merges, or **requests changes**. The admin
  approves only sensitive paths (CODEOWNERS) and PRs that are escalated, for example a finished
  feature slice or a changed module interface (area 2). Escalation is the label `review:admin`. #37
  decided on 8 Nov that a review thread from the bot will replace it once #104 lands. (**#495, 22
  Nov 2026:** the label stays, and the admin's removal of it on the head is the sign-off; #104 is
  superseded, area 2, "Solo-admin approvals".)
- **Deploys:** once production is live, only a `v*` release tag ships to production, deployed by
  GitHub Actions; a merge to `main` reaches staging only. Bot-approved PRs keep auto-merging (area
  4).
- **The merge guard** is for unattended sessions only, once #37 shows how to detect them; attended
  sessions are never blocked (area 2). _Dropped 8 Nov in #37:_ the factory runs as its own App,
  which GitHub holds to the rulesets.

**The approval mechanics** were checked on 7 Nov against the `github/docs` source, the REST API
description (`github/rest-api-description`) and two community reports, each cited where it's used in
area 2. Whether a GitHub App's approval counts toward a required approval is not stated in GitHub's
docs; the checklist tests it once.

**GitHub Marketplace**, researched on 7 Nov from the vendors' pricing, terms and docs pages,
read-only. The summary is in area 9.

Areas 2–9 below were revised with these answers.

## The skill and AGENTS.md

Branching, commits, the PR flow, merge methods, versioning, tags, releases and the changelog follow
Addy Osmani's `git-workflow-and-versioning` skill
(`.agents/skills/git-workflow-and-versioning/SKILL.md`, cited below as "skill, _section_"). Where
the skill and `AGENTS.md` disagree, `AGENTS.md` wins:

<!-- prettier-ignore -->
| # | Skill default | AGENTS.md rule | Resolution |
|---|---|---|---|
| C1 | Branches named `feature/…`, `fix/…`, `chore/…` (skill, *Branch Naming*) | One worktree per issue, named `<N>-<slug>` | The branch takes the worktree's name, `<N>-<slug>`. The type lives in the PR title, as `triage-labels.md` already says. |
| C2 | Worktrees beside the repo, `../project-feature-a` (skill, *Working with Worktrees*) | Worktrees under `.claude/worktrees/`; the main folder stays on `main` | `.claude/worktrees/<N>-<slug>`, already ignored by `.gitignore`. |
| C3 | Merge every branch within 1–3 days and delete it (skill, *Trunk-Based Development*, *Feature Branches*) | `prototype/*` branches are never merged | `prototype/*` is exempt from the lifetime and is kept as evidence. It is protected from deletion (area 2). |
| C4 | Pre-commit hygiene runs `npm test`, `npx tsc` and suggests husky with lint-staged (skill, *Pre-Commit Hygiene*) | pnpm only; ask before adding a dependency | `pnpm` equivalents. No husky or lint-staged unless the admin approves them as dependencies. CI is the gate. |
| C5 | The secret check is `git diff --staged \| grep -i "password\|secret\|api_key\|token"` (skill, *Pre-Commit Hygiene*) | Never print secret values | That grep prints the matching line, value and all. Use `git diff --staged \| grep -c -i -E '…'`: it prints a count, never the line. |
| C6 | The skill assumes a human reviewer approves every PR | `docs/diagrams/workflow.md`: "Every PR is merged by you, factory PRs included" | Superseded (area 2): a reviewer bot approves or requests changes, and the PR auto-merges on its approval; the admin approves sensitive paths and escalated PRs. `workflow.md` and `AGENTS.md` follow in a later PR (Consequences). |

One more departure is not an AGENTS.md conflict, but a repo decision that predates this ADR. The
skill warns that "squashing destroys the development narrative" (skill, _Common Rationalizations_).
`triage-labels.md` (#18) already makes the PR title the squash-commit message. Area 3 keeps squash
as the default and says why.

## 1. Git branching strategy

### Model

**Current state.** In effect trunk-based with short-lived branches, but without protection. Of the
21 first-parent commits on `main`, 15 were pushed directly with no PR (for example `8c6edbd` and
`0231cdc` on 7 Nov). Six arrived through PRs (#3, #13, #14, #19, #26, #30). The spike PRs (#20–#25,
#27, #29) merged into `prototype/persistence`, which is never merged.

**Recommendation: adopt now. Trunk-based development with short-lived issue branches, and every
change to `main` through a PR.** `main` stays deployable: every merge deploys to staging, and any
commit on `main` can be tagged and shipped (area 4). A branch lives for one issue, which "fits one
session" by the definition of ready, so it lives hours to a day or two. This is the skill's
recommended default (skill, _Trunk-Based Development_). Incomplete player-facing work hides behind a
flag rather than a long branch (skill, same section), when it comes to that.

**Alternatives considered.**

- **GitHub flow** (branch, PR, merge to `main`, deploy). It is nearly the same thing. Trunk-based is
  named instead because it sets the lifetime limit and the "main is always deployable" rule that the
  factory needs.
- **git-flow** (`develop`, `release/*`, `hotfix/*`). Rejected: a long-lived `develop` is the "hidden
  cost" the skill warns about, and Vercel already gives each PR a preview, which is what a `develop`
  branch would be for.
- **Release branches for playtests.** Deferred: the skill accepts them "when you need to stabilize a
  release while main moves forward" (skill, _Trunk-Based Development_). A playtest runs on a tagged
  production deploy. If `main` must move during a playtest, a `release/v0.5` branch can be cut from
  the tag then.

### Branch names

<!-- prettier-ignore -->
| Work | Branch | Notes |
|---|---|---|
| An issue (manual or factory) | `<N>-<slug>`, e.g. `41-plot-ripening` | Same as the worktree (C1). Issue #17's idea reads the number from the name. |
| A cloud session | `<N>-<slug>` when the brief names one | If the harness picks its own name (for example `claude/…`), keep it; the PR body's `Closes #N` links the issue. |
| A prototype | `prototype/<name>` | Never merged into `main`. PRs into it are allowed, as in M1. |
| Docs with no issue | `docs/<slug>` | Rare. Retros and small rule edits by the coordinating session. |
| A release fix during a playtest | `release/v0.<m>` | Only if needed (above). |

The observed names so far are mixed: `docs/2-requirements-spec`, `chore/4-local-supabase`,
`11-replay-cost`, `docs/glossary`. From M2 the table above applies. Old branches aren't renamed.

**Alternative considered:** `<type>/<N>-<slug>` (the skill's prefixes plus the number). Rejected:
the worktree name would differ from the branch name, and the type is already in the PR title.

### Lifetime, updating, deleting

- **Lifetime:** merge within 1–3 days (skill, _Feature Branches_). A branch older than 3 days is a
  sign the issue was too big: split it.
- **Updating from `main`:** merge `main` into the branch, or press GitHub's **Update branch** (a
  merge). A squash merge removes those merge commits from `main` anyway. An update is a push, so it
  dismisses the reviewer bot's approval and starts a new review, which is a new Claude run (area 2):
  update only when the PR needs it. Rebase only a branch no one else has fetched, and push it with
  `--force-with-lease`, never `--force`. Force-pushing a shared branch is a red flag in the skill
  (skill, _Red Flags_). The retro's stale local branch (15 commits behind) is avoided by always
  branching from `origin/main` after a fetch.
- **Deleting:** GitHub deletes the head branch after merge (`delete_branch_on_merge` is already
  `true`). The worktree is removed in the evening routine (`docs/diagrams/workflow.md`).
  `prototype/*` is never deleted (C3).

### Commit messages

**Current state.** Conventional Commits with scopes are already used: `docs(agents): …`,
`chore(supabase): …`, `spike(persistence): …`.

**Recommendation: adopt now.**

```
<type>(<scope>): <summary in the imperative, lower case, no full stop>

<body: why, not what, wrapped at 72>

Co-Authored-By: …   (agent commits)
Claude-Session: …   (cloud sessions)
```

- Types: the skill's `feat`, `fix`, `refactor`, `test`, `docs`, `chore` (skill, _Descriptive
  Messages_), plus `spike` from `triage-labels.md`. A scope is optional: a package, an area or a doc
  (`sim`, `tracker`, `adr-0002`).
- One logical change per commit, about 100 lines, and over about 1,000 lines split it (skill,
  _Atomic Commits_, _Size Your Changes_). Refactors and features go in separate commits, ideally
  separate PRs (skill, _Keep Concerns Separate_).
- The PR title uses the same format. With squash merges it becomes the commit on `main`.

**Alternative considered:** free-form messages. Rejected: the PR-title check and the release notes
both read the prefix.

### Versioning, tags, releases and the changelog

**Current state.** No tags and no releases (`GET …/tags` and `…/releases` return empty).

**Recommendation: adopt at M4 (playable slice, 29 Nov).** Until something is deployed for people
outside the project, there is no consumer, and the skill ties versions to consumers (skill, _Release
& Versioning_). From M4 the playtesters and the examiners are consumers of a build.

- **SemVer, 0.x until hand-in.** One minor version per milestone that ships a build: `v0.4.0` (M4
  playable slice), `v0.5.0` (M5 playtest 1), `v0.7.0` (M7 playtest 2 + freeze), `v1.0.0` (M9
  hand-in). A fix during a playtest is a patch (`v0.5.1`). The minor number matches the milestone,
  so the tag says which milestone a build belongs to.
- **Annotated tags on `main`**, created by the admin at the milestone gate after `/ship` says go
  (`git tag -a v0.4.0 -m "…"`; skill, _Tag the release_). Tags are protected (area 2). **Pushing the
  tag is what ships it:** the `deploy` workflow sends a `v*` tag to production (area 4).
- **The tag is the source of truth** (skill, same section). `package.json` stays `private` with no
  hand-edited version. The app shows the version from the deploy's git ref.
- **A GitHub Release per tag**, with notes generated from `.github/release.yml` (appendix A6) and
  then edited by hand.
- **The changelog.** The skill wants a curated, human changelog grouped by Added / Changed / Fixed /
  Deprecated / Removed / Security, written with the change, not at release time (skill, _Keep a
  changelog written for humans_). Parallel factory PRs that all edit one `CHANGELOG.md` would
  conflict with each other all day. So each PR body has a **Changelog** line (player-facing impact,
  or "none"; appendix A2). The squash puts it into the commit on `main`. At the tag, the admin
  copies those lines into `CHANGELOG.md` under the version, grouped by impact, and into the Release.
  The entry is still written with the change, and the file still exists for readers.

**Alternatives considered.**

- **A tag per merge, or CalVer** (`2026.11.29`). Rejected: there's no consumer per merge, and a date
  says nothing about the milestone.
- **semantic-release or Changesets.** Rejected for now: a new dependency, and the skill says a
  changelog generated from raw commits "buries what matters".
- **No changelog, only Release notes.** Rejected: the report needs a readable history of what each
  playtest build changed, kept in the repo.

## 2. Rulesets and protection

**Current state.** Nothing protects anything. `GET …/rulesets` returns `[]`,
`GET …/branches/main/protection` returns 404 "Branch not protected", and `GET …/rules/branches/main`
returns `[]`. Anyone with write access, which includes every agent session, can push to `main`,
force-push it or delete it.

**The plan and the visibility (Q1, decided).** The account is on GitHub Pro (GitHub Education), and
the repo stays private until about M3–M4 (#38). Rulesets, protected branches and CODEOWNERS work in
private repos on GitHub Pro, Team or Enterprise
([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners);
checked 7 Nov against `github/docs` `gated-features/repo-rules.md`, `protected-branches.md`,
`code-owners.md`). So everything in this area works now. What only public visibility adds is in
areas 4 and 8.

**Recommendation: adopt now.** Rulesets, not classic branch protection: they can be read by anyone
with read access, several can stack, and they can target tags too
([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).

**The local layers in front of the rulesets** (the main-folder guard hooks and the git hooks that
refuse commits on `main`) are [ADR-0008](0008-main-folder-guard.md) (#118).

### Ruleset `main`

Target: the default branch. Enforcement: active.

<!-- prettier-ignore -->
| Rule | Setting | Why |
|---|---|---|
| Restrict deletions | on | `main` can't be deleted. |
| Block force pushes | on | History on `main` is never rewritten (skill, *Red Flags*). |
| Require a pull request before merging | on, **1** required approval | Every change goes through a PR, so CI runs on it (MUST-17.1). The approval comes from the reviewer bot, or from the admin on sensitive and escalated PRs (below). |
| ↳ Require review from Code Owners | **on** | A PR that touches a path in CODEOWNERS also needs the admin's approval (MUST-15.1); the bot's approval can't stand in for it. |
| ↳ Dismiss stale approvals when new commits are pushed | **on** | A push that changes the diff after an approval, the bot's or the admin's, needs a fresh one, so nothing unreviewed rides on an approval ([available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging)). The admin's decision, 7 Nov. |
| ↳ Require conversation resolution | on | An open review thread blocks the merge. It turns `code-review` findings left as comments into a gate. |
| ↳ Allowed merge methods | merge, squash | Area 3. |
| Require status checks to pass | **added later**, when CI reports them | Placeholders below. A required check that never reports blocks every merge, so none are added before the CI/CD step. Each is pinned to GitHub Actions as its source (`integration_id` 15368), so no session can satisfy it with a hand-made commit status ([REST: `StatusCheckConfiguration.integration_id`](https://docs.github.com/en/rest/repos/rules), schema checked 7 Nov; `gh api apps/github-actions --jq .id` returns 15368). |
| ↳ Require branches to be up to date | off for now | With parallel factory PRs and no merge queue (area 3), strict mode means updating and rerunning CI after every merge. Auto-merge of bot-approved PRs makes two green PRs that break `main` together more likely. **Ratchets too:** two PRs can each pass the bundle or coverage ratchet and together go past it. Accepted: the next PR's ratchet run measures `main` as it is and fails, which shows the drift a PR later. Turn on if either happens twice (the self-improving rule). |
| Require linear history | **off** | Area 3 keeps merge commits for evidence PRs. |
| Require signed commits | off | Cloud-session commits are signed, but local commits aren't. Checked 7 Nov (`verification.verified` on every commit of `main`, `prototype/persistence` and this PR's branch): all 54 cloud-session commits (author Claude, `Claude-Session:` trailer) and all 14 merges made on github.com are verified. All 43 local commits, the admin's and local sessions', are unsigned. The rule would block every local push until the admin sets up signing, for little gain in a solo repo. |
| Require deployments to succeed | off; revisit at M4 | Could require the Vercel preview to deploy before merge. Decided together with the `preview / …` checks, which need a preview to measure (below). |
| Bypass list | Repository admin, mode **"For pull requests only"** | The admin can merge a PR past a rule (an admin-review PR the factory opened as the admin, or a red check during an outage) but can't push straight to `main`. **Until the reviewer App exists (checklist step 12), nobody can give the required approval, so every merge is a bypass merge, and any session can make one.** Decided (Q15): the ruleset starts with 0 required approvals and goes to 1 at step 12; code-owner review stays on throughout (Consequences). Rulesets accept "Repository admins" as bypass actors with no organization condition; the "organization only" limit in the docs is for classic branch protection ([creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset), checked 7 Nov). |

**Decided 22 Nov 2026, #495:** "Require review from Code Owners" and "Require conversation
resolution before merging" go **off** once #565 and #566 land; `guard / code-owned` in `main checks`
then holds code-owned and escalated PRs ("Solo-admin approvals", below).

**Applied 8 Nov, #66:** ruleset `main` (id 26810726) as in the table, with 0 required approvals
(Q15). The bypass list shows "Repository admin, For pull requests only" in the UI, so `actor_id: 5`
is the Repository admin role. GitHub added two parameters this table doesn't set; A8 says what they
do.

**Applied 8 Nov, #40: the required checks live in their own ruleset, `main checks`** (id 26816327,
the admin's decision, 23:17 CET), not in `main`. It holds only the `required_status_checks` rule,
with **no bypass actors**; `main` keeps deletion, force pushes and the pull request rule, with the
admin's "For pull requests only" bypass. Why, in the admin's reasoning (#110, 8 Nov): with the
checks in `main`, a bypass merge, which every code-owned PR needs while sessions open PRs as the
admin, skipped the checks too. Split, the bypass lifts only the approvals, and the checks hold for
everyone.

- _Documented:_ a ruleset's bypass list lets an actor "bypass the rules in the ruleset"
  ([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rulesets)),
  and an actor with "For pull requests only" can "bypass any branch protections and merge that pull
  request"
  ([creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset)).
  GitHub aggregates the rules of every ruleset that targets a branch
  ([rule layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-layering)).
  All read 12 Nov.
- _Inference:_ a bypass in `main` doesn't lift the rules of `main checks`. The docs don't say so in
  those words. The API is consistent with it: it returns `current_user_can_bypass: "never"` for
  `main checks` and `"pull_requests_only"` for `main`.

**The cost:** "a red check during an outage" (bypass row above) can no longer be bypassed. A broken
check blocks every merge until it's fixed, or until the admin edits `main checks`. The four checks
and the JSON are in A8.

**Placeholder required checks.** The names are a superset of the "Required check" column of
`CONSTRAINTS.md`'s "Enforced with numbers" table (on `main` since #45), which owns every threshold.
The bundle ratchet has no row in that table yet; it reports as `preview / bundle`.
`guard / pr-title`, `guard / protected-paths` and `guard / no-prototype` are this ADR's own. The
CI/CD step builds the checks (#40, #42). (Amended 19 Nov: `guard / protected-paths` is built as
`guard / acceptance`, which fails a `[bot]`-authored PR that touches `tests/acceptance/**`;
[ADR-0007](0007-apps-web-and-game-api.md), section 6.) (Amended 22 Nov, #308: `guard / floor` reads
this table's first column as the list of required checks, so every check in ruleset `main checks`
has a row here, `guard / code-owned` and `guard / acceptance` included; ADR-0004 has the note.)

<!-- prettier-ignore -->
| Check | Covers |
|---|---|
| `guard / floor` | the floor guard: a weakened bar (CONSTRAINTS.md, "Guarding the bar") fails unless the same PR adds an Exceptions row (below) |
| `ci / typecheck` | MUST-17.1 |
| `ci / lint` | MUST-17.1, plus the lint rules in `CONSTRAINTS.md` |
| `ci / test` | unit and property tests, including changed-line coverage (MUST-17.1) |
| `ci / boundaries` | MUST-10.1: `packages/sim` imports nothing outside itself, and client code never imports `src/server/` |
| `ci / bench` | sim speed: `advance()` and `apply()` medians, inside BASE-04's budget |
| `ci / ui` | BASE-02 (browsers and widths) and BASE-05 (prediction within 100 ms), tool chosen in #44 |
| `ci / determinism` | the determinism gate (MUST-17.1) |
| `ci / acceptance` | acceptance tests on a throwaway stack (MUST-15.3, MUST-17.1) |
| `ci / audit` | `pnpm audit --audit-level=high`, the required dependency check (area 8) |
| `ci / scripts` | the shell scripts' test suites, every `*.test.sh` under `scripts/` and `.claude/hooks/`, with their fake `gh`; the suites need no secret or network (#255) |
| `guard / pr-body` | a body that says `Part of #N` and also links #N with a closing keyword (#270), or a closing keyword that names an issue other than the PR's own `<N>` outside an `Also closes #M` line (#512); required since 16 Nov (`main checks`, 10 checks) |
| `guard / stack-base` | a PR whose base isn't `main` and isn't in a native stack: a hand-chained PR (#264); required once the admin adds it after #264 merges |
| `guard / code-owned` | a held PR (it touches a code-owned path in `.github/CODEOWNERS`, or has ever carried `review:admin`) needs the admin to remove `review:admin` on its head (#337, #565; "Solo-admin approvals"); required in `main checks` |
| `guard / acceptance` | `guard / protected-paths` as built: fails a `[bot]`-authored PR that touches `tests/acceptance/**` (MUST-15.2; #384, [ADR-0007](0007-apps-web-and-game-api.md), section 6); required in `main checks` |
| `guard / secrets` | the gitleaks CLI over the PR's commits (area 8) |
| `guard / code-scan` | Semgrep (area 8) |
| `preview / lighthouse`, `preview / axe`, `preview / bundle`, `preview / latency` | page performance, BASE-03 (axe), the bundle ratchet and BASE-04 (latency smoke), measured on the Vercel preview (below; #43) |
| `guard / pr-title` | the Conventional Commit prefix (`triage-labels.md`, automation candidate): a few lines of bash, no third-party action (area 9) |
| `guard / protected-paths` | fails an agent PR that touches `tests/acceptance/**` (MUST-15.2). Built as `guard / acceptance`, keyed on a `[bot]` author (amended 19 Nov, [ADR-0007](0007-apps-web-and-game-api.md), section 6) |
| `guard / no-prototype` | fails a PR into `main` whose head is `prototype/*` (rulesets can't block a head branch) |

`ci / mutation` (Stryker) also runs and reports, but it is **not required**. Nor is `ci / stack`,
which only tells typecheck, lint and test whether to run ("Stacks", below). Nor is `ci / workflows`
(#442): actionlint, with shellcheck, over `.github/`, in `workflow-lint.yml`. Its event has
`paths: ['.github/**']`, so a PR that touches nothing there shows no check rather than a skipped
one; making it required means dropping that filter first.

**Preview checks.** The `preview / …` checks measure the Vercel preview, so they start from Vercel's
deployment events. A PR that Vercel doesn't build would then never report, and a required check that
never reports blocks the merge. So each preview check also runs on the PR itself. When no preview
exists for the head commit (nothing deployable changed, or Vercel skipped the build), it reports
success and says "no preview, nothing to measure". The signal Vercel sends for a skipped build is
unverified until Vercel is connected (Q10). Previews sit behind Vercel's Deployment Protection, so
the checks send Vercel's automation bypass secret in the `x-vercel-protection-bypass` header
([Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation),
checked 7 Nov). It's an Actions secret, set without echoing it (area 4). The preview checks become
required together with "Require deployments to succeed", at M4 (ruleset table above).

Every required check must report on **every** PR, so none of them may use a path filter: a check
that doesn't apply reports success and says why. A required check is matched by its **job name**,
not "workflow / job", so each job is named exactly as above, and no two jobs in any workflow share a
name
([troubleshooting rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules),
checked 7 Nov).

### Ruleset `prototype/*`

Target: `refs/heads/prototype/*`. Rules: restrict deletions, block force pushes. No PR requirement,
because M1 merged spike PRs into the prototype branch with custom merge subjects. A prototype is
evidence for an ADR (ADR-0001's results), so it must not vanish or be rewritten. Merging it into
`main` is blocked by `guard / no-prototype`.

### Ruleset `v*` tags

Target: tags matching `v*`. Rules: restrict creations, restrict updates, restrict deletions, block
force pushes. Bypass: Repository admin, **always**. Only the admin cuts a release; a tag never moves
once it exists (skill, _Tag the release_). A `v*` tag deploys to production (area 4), so this
ruleset guards production too. Until #37, every session holds this bypass (below).

### Ruleset `production`

Target: `refs/heads/production`, the branch Vercel treats as production so that `main` deploys as
staging (area 4). Rules: restrict creations, restrict updates, restrict deletions. No bypass: nobody
pushes it, and production ships only through the `deploy` workflow.

### Approvals: a reviewer bot, and the admin where it counts

The admin's decision (7 Nov): PRs are reviewed **the way people on GitHub review each other**. A
reviewer bot reads every PR and either **approves** it, after which it auto-merges, or **requests
changes**, after which the factory fixes and pushes. The admin approves only what is sensitive or
what an agent sends up. The admin is not the bottleneck, and every review lands on the PR.

The flow:

1. The factory opens a PR.
2. The reviewer bot reviews it (Actions, on every push).
3. **OK:** the bot submits an **Approve** review and turns on auto-merge. The PR merges once the
   required checks are green.
4. **Not OK:** the bot submits **Request changes**, with its blocking findings as line comments. The
   factory fixes them and pushes. The push dismisses any earlier approval, and the bot reviews
   again.
5. **Needs the admin:** the bot escalates with a review thread that mentions the admin (below,
   decided in #37). On a PR the admin's account opened it still approves a PR it finds clean, and
   the open escalation thread alone holds the merge until the admin resolves it (#264). On a PR an
   App opened it withholds its approval. **#495 (22 Nov 2026), once #565 and #566 land:** the bot
   approves every clean PR, whoever opened it, and `guard / code-owned` holds an escalated or
   code-owned PR until the admin removes `review:admin` on its head ("Solo-admin approvals", below).

<!-- prettier-ignore -->
| Need | Native GitHub feature |
|---|---|
| Nothing merges without an approval | `main` ruleset: **1** required approval, from checklist step 12 (0 before, while nobody but the admin could approve; Q15) |
| "Request changes" blocks the merge | Built in: "If someone chooses the **Request changes** option in a review, then that person must approve the pull request before the pull request can be merged" ([available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging), checked 7 Nov) |
| A new push needs a new review | Dismiss stale approvals when new commits are pushed |
| Sensitive paths need the admin | CODEOWNERS plus "Require review from Code Owners": the bot's approval meets the count, but only `@sssoto17` can meet code-owner review |
| Findings block until handled | Required conversation resolution: open line comments hold the merge |
| Reviews go somewhere | They *are* the PR's reviews: verdicts, summaries and line comments stay on the PR as the record, and as report data |
| Merge without a human | Auto-merge, turned on by the bot when it approves (area 3) |

**#495 (22 Nov 2026), after the admin's ruleset steps:** "Sensitive paths need the admin" moves from
"Require review from Code Owners" to the required `guard / code-owned`, and "Findings block until
handled" from required conversation resolution to Request changes and the bot's withheld approval
while a finding thread of its own is open; both settings go off ("Solo-admin approvals", below).

**Two kinds of PR need the admin**: a _code-owned PR_ and an _escalated PR_. Below, an _admin-review
PR_ means either kind.

- **Sensitive paths (CODEOWNERS, appendix A3):** `tests/acceptance/**` (MUST-15.1); `.github/**`,
  `.claude/**`, `.agents/**`; `AGENTS.md`, `CLAUDE.md`, `CONSTRAINTS.md`; `docs/adr/**`,
  `docs/requirements/**`; every `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and
  `vercel.json`; the configs that can weaken a check; the review rules themselves (`docs/agents/`,
  `docs/diagrams/workflow.md`, `skills-lock.json`); migrations and RLS. GitHub enforces these:
  without the admin's approval, the PR doesn't merge.
- **Escalated PRs (decided 8 Nov in #37; this replaces the label `review:admin`):** the reviewer bot
  escalates a PR, code-owned ones included, when it meets a row of the escalation criteria in
  `CONSTRAINTS.md` (#47) or on the bot's own judgement. Escalate when a PR wraps up a feature slice,
  or changes a module's public interface (for example the exports of `packages/sim`, or an API
  contract), so the admin keeps ownership of how a module turns out. The bot checks every row on
  every run. Every row can be read from the PR, its diff and its linked issue. An agent that knows a
  reason the PR can't show (for example "can't be split") writes it in the PR template's Review
  section (A2), which the bot reads. A body that asks for more caution is harmless even though the
  PR wrote it.
  - **Scope re-checked before auto-merge (#68 step 1, 12 Nov).** Both kinds were checked path by
    path and row by row. CODEOWNERS is unchanged. In `CONSTRAINTS.md`, the Content change row now
    covers only content values, and the weakened-bar row is gone now that `guard / floor` is
    required. The reasons are in `CONSTRAINTS.md`'s interview record.
  - **The escalation is a thread.** The bot posts a file-level review thread on the file that
    triggered the row, "escalated: <rows>", which mentions `@sssoto17` so the admin is notified. A
    review summary or a plain comment wouldn't create a thread. Required conversation resolution
    holds the merge until the thread is resolved, and **that thread is the escalation's gate**: the
    bot is to approve an escalated PR it finds clean **only when the admin's account opened it**
    (decided by the admin, 15 and 16 Nov, #264's decisions comment). Withholding the approval made
    every escalated part of a stack a separate bypass merge, since the admin can't approve PRs the
    admin's account opened; an approval on every clean part lets a stack merge in one action once
    its threads are resolved ("Stacks", below). On a PR an App opened (#336) it still withholds:
    resolving a thread starts no workflow (below), so a thread the factory App resolved could let
    the PR merge before the bot checks who resolved it. **Built in #322:** `post-review.sh` reads
    who opened the PR from the REST PR object (`user.login` and `user.type`, never text the PR
    wrote) and approves a clean escalated PR only when that is the admin's `User` account and its
    own escalation thread is open on the PR. When no file took the thread, or the admin has already
    resolved it and a later head comes in, nothing would hold the merge, so it withholds; a finding
    whose body starts with `escalated:` is posted as `Finding: escalated: …`, so it can't pass for
    the thread. #68's test (e) was rewritten to match. Until #104 the bot also adds `review:admin`
    when it escalates, and the label holds its approval ("Until #104, the label stays"), so the
    approval shows only once the label is gone. Code-owner review is separate and stays on (Q15). On
    a factory PR the bot also requests the admin's review, so `review-requested:@me` is the admin's
    queue. The admin's own open PRs show under `author:@me`. **#495 (22 Nov 2026), once #565 and
    #566 land:** the thread stops being the gate. It stays as the bot's explanation, the bot
    approves a clean escalated PR whoever opened it, and the label, removed by the admin on the
    head, is the gate ("Solo-admin approvals", below).
  - **The escalation thread is the bot's memory across runs.** Anyone with write access can resolve
    a thread, the factory App included, and so can any session on the admin's account. Agents never
    resolve review threads: a `deny` rule on the GitHub MCP resolve-thread tool and the `PreToolUse`
    hook `.claude/hooks/block-thread-resolve.sh`, which also runs in cloud sessions, stop it in
    Claude Code (#264). That is a standard plus a check, not a boundary: until agent PRs come from
    the factory App (#107), GitHub sees the admin either way. Resolving doesn't start a workflow:
    `pull_request_review_thread` is a webhook event, not an Actions trigger
    ([events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
    read 8 Nov). So on its next run the bot reads each escalation thread's `resolvedBy`, and
    unresolves (`unresolveReviewThread`) one that anyone but the admin (`User` `sssoto17`) resolved.
    When it resolves its own fixed findings, it skips escalation threads. **#495 (22 Nov 2026), once
    #566 lands:** the bot stops reopening escalation threads and stops reading them as memory; the
    label's history in `guard / code-owned` does that job.
  - **The admin's go-ahead** is resolving the thread. The bot's approval already meets the count, so
    the PR, or the whole stack, then merges like any other. A code-owned PR still needs the code
    owner's approval: on a PR the admin's account opened, which the admin can't approve, the admin
    left a Comment review on its head, which `guard / code-owned` counted as the code owner's
    sign-off until #565 removed that rule (#494; "Stacks", below), and bypass-merged it; a PR an App
    opened the admin approves (code-owner review stays on; "Stacks", below). The resolved thread and
    the merge are the record of who decided. **Amended 22 Nov 2026, #495:** the go-ahead becomes
    removing `review:admin`, bound to the head; threads stop being required, and code-owner review
    goes off ("Solo-admin approvals", below).
  - **The bot's earlier Request changes.** When its re-review finds those findings fixed, the bot's
    Approve replaces its Request changes, on an escalated PR too (#322). Where it withholds with
    every finding fixed (an escalated PR an App opened, or `review:admin` until #104), it dismisses
    its own Request changes instead (`dismissPullRequestReview`), which would otherwise block for
    good. The admin can also dismiss it. **#495 (22 Nov 2026), once #566 lands:** neither case
    withholds any more, so the Approve replaces the Request changes there too.
  - **Why a thread, not a review request or a label.** Attended sessions act as the admin after #37
    too, so the admin authors their PRs, and GitHub doesn't request a review from a PR's own author.
    That's widely reported as an API error; it isn't in the docs or tested here. So a review request
    can't carry the signal alone. The 7 Nov design used a label, `review:admin`, which works whoever
    the author is. The admin retired it on 8 Nov: as few label families as possible, and native
    features wherever they can carry a signal. Renaming it into `blocked:*` was rejected, because
    that family's rule is "remove it when the reason clears", while this one only the admin may
    clear. A draft PR was rejected too: anyone can mark a PR ready, and "draft" would also have to
    mean "unfinished". Deciding at approval time also removes the label's race, where a label added
    after the bot approved could lose to auto-merge. **#495 (22 Nov 2026):** the label comes back as
    the gate, because removing it fires a workflow and the timeline shows it, where resolving a
    thread does neither; the admin owns the one-family cost. The race is handled in order: the guard
    labels a code-owned PR from its diff on `opened` and `synchronize`, and the bot adds the label
    before it approves (#566), so a held PR's `guard / code-owned` is red before any approval.
  - **Until #104, the label stays.** (**Amended 22 Nov 2026, #495:** the label stays for good, as
    the admin's sign-off, and #104 is superseded; "Solo-admin approvals", below.) Until the reviewer
    App posts escalation threads (#68), `review:admin` is the admin's only queue. So
    [Retire review:admin](https://github.com/sssoto17/sunny-pastures/issues/104) waits for #68 and
    #101. Until it lands, agents add the label as `CONSTRAINTS.md` says, the bot never approves a PR
    that carries it, and only the admin removes it. Nothing on GitHub enforces that last rule; see
    "The honest limit" below. #104 is where the label's hold moves to the thread, as #264 decided.

**The reviewer bot is its own GitHub App** (the admin's choice, 7 Nov), for example
`sunny-reviewer[bot]`, used from Actions. It runs Claude with the repo's review skills
(`code-review`, the standards and spec axes). What it checks, its severities (Required, Optional,
Nit) and its report follow `REVIEW.md` at the repo root, which #68 has it read from `main` (added 12
Nov, #225). This section keeps the mechanism: the App, its writes, and when it approves or
escalates. It is a separate identity from the PR's author, so its approval is not a self-approval,
even while the factory still acts as the admin (until #37). Its private key is an environment
secret, handed only to the review job. It's set up alongside the factory's App, `sunny-factory`: two
Apps, since one App can't approve the PRs it opens. Claude is billed through the admin's employer
seat (#37; "The factory's identity" below).

- **The App's permissions (decided 7 Nov, Q14).** The App turns on auto-merge (step 3 of the flow),
  and GitHub's docs say "People with write permissions to a repository can enable auto-merge for a
  pull request"
  ([automatically merging a pull request](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request),
  checked 7 Nov). Required approvals also come from "reviewers with write permissions"
  ([about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-pull-request-reviews-before-merging)),
  and a community report says an App's approval counts only with `contents: write`
  ([discussion #211598](https://github.com/orgs/community/discussions/211598)). So `contents: read`
  would fail. **So the App gets `contents: write` and `pull_requests: write`, and the `main` ruleset
  gets `require_last_push_approval: true`** (A8), so the App can never approve a push it made
  itself. **Not at step 12 (admin, 17 Nov 2026, #264's decisions):** while lanes push as the admin's
  account, the last pusher is the admin and the rule would hold every PR for someone else's
  approval, so it stays off while lanes push as the admin's account. #336 doesn't change that: it
  moves PR authorship to the App, not the pushes ("Lanes open PRs as sunny-factory", below), so the
  rule waits for pushes from an App (#107). The blast radius: a prompt-injected reviewer could push
  commits to PR branches, but not to `main` or to tags, which the rulesets block. The checklist's
  test (step 12) confirms each step of the flow.
- **What it reads is untrusted.** The bot feeds text that the PR wrote to a model, so a PR could try
  to talk it into approving. It runs on `pull_request_target`, from `main`'s copy of the workflow,
  never runs PR code, and its approval can't stand in for the admin's on a code-owned PR. The
  required checks still run whatever it says.
- **Blocking and non-blocking findings.** Blocking findings are line comments plus Request changes.
  Suggestions go in the review's summary, so they don't hold the merge through conversation
  resolution.
- **Who resolves the threads.** Conversation resolution would stall auto-merge on the bot's old line
  comments. So when the bot re-reviews and finds a finding fixed, it resolves that thread itself
  (`resolveReviewThread`, from Actions, where GraphQL is open). A thread it still considers open
  stays open, and the PR doesn't merge. Agents answer a thread's finding with a PR comment, never a
  reply on the thread or a review, and never resolve a thread (the hook above, #264, #497).
- **Each run costs.** The bot runs on every push, every `labeled` event (until #104; #495 keeps the
  label, so this stays) and every "Update branch", since each of those dismisses the approval. One
  `concurrency` group per PR with `cancel-in-progress` keeps only the newest run (Consequences).
- **Only this App approves.** Every other app keeps auto-approve off: CodeRabbit's
  `@coderabbitai approve`, Greptile's auto-approve, Renovate's `autoApprove`, "Copilot approvals".
  "Allow GitHub Actions to create and approve pull requests" stays off (area 8), so no other
  workflow can approve. Only `@sssoto17` is a code owner. This supersedes the Marketplace research's
  catch-all `* @sssoto17`, which would have sent every PR to the admin.

**The review workflow (#68 step 2, 12 Nov): `.github/workflows/review.yml`.** On
`pull_request_target` from `main`, for non-draft PRs from this repo's branches, to `main` or in a
native stack on any base (#404, "Stacks"). The pattern is _propose, then apply_: Claude proposes and
plain code applies, in two jobs on two runners (#454): `review` runs Claude in the `claude-seat`
environment, and `post` posts the verdict from the `review` environment ("Which environment holds
which secret", below).

- **Propose.** Claude reads the PR as files of data (diff, reviews, threads, linked issues) next to
  `main`'s checkout. It has Read, Grep and Glob only, and the read-only `GITHUB_TOKEN`. It follows
  `.github/review-prompt.md`, which points to `REVIEW.md`, and answers with a JSON verdict
  (`--json-schema`, `.github/review-verdict.schema.json`).
- **The review skill (#68, admin 18 Nov 2026).** The prompt starts with `/code-review-and-quality`,
  so the CLI loads that skill before the task; `review-prompt.md` and `REVIEW.md` still decide what
  is reported. A step copies `main`'s copy into `~/.claude/skills` (`cp -RL`: the repo's entry is a
  link into `.agents/skills/`), because `--setting-sources user` registers skills from there only.
  _Alternatives:_ adding the `project` source was rejected: it also loads the repo's
  `.claude/settings.json` (hooks, allow rules) and `.mcp.json`, whose servers the action starts (it
  sets `enableAllProjectMcpServers`). Allowing the `Skill` tool was rejected as unneeded: a typed
  skill is expanded by the CLI, not through the tool, so `Skill` stays denied and the model can't
  load another skill. Tried by hand (#381, 21 Nov) with CLI 2.1.319, the version the pinned action
  installs (61a9c27: its installer pins `2.1.319` in `src/entrypoints/run.ts` and
  `base-action/action.yml`, and the SDK is handed `~/.local/bin/claude` as
  `pathToClaudeCodeExecutable`, so its bundled binary is never used), and with 2.1.330, both with
  `--setting-sources user` and `Skill` denied: the skill's text reached the model. Unverified in a
  CI run until #381's first run after merge shows `loaded=1`. The proof (#381): the CLI writes the
  expanded skill to the session's transcript (`~/.claude/projects/<cwd>/<session>.jsonl`) as an
  `isMeta` user message, and never to its `stream-json` output, even with `--replay-user-messages`:
  that stream is what the SDK relays and the action saves as its execution file. So the Report step
  runs `.github/scripts/skill-proof.mjs`, which takes the session id from the execution file and
  counts the skill's `# Code Review and Quality` heading in that transcript, in records from the
  skill's own folder (the model reading `SKILL.md` with Read doesn't count). It logs
  `RESULT skill=code-review-and-quality registered=<bool> loaded=<n> cli=<version> from=<dir>`, and
  with `loaded=0`, no transcript or no execution file, it fails the step with an `::error::`
  annotation. Failing, not warning: a green job with a warning goes unread, and `review` isn't a
  required check, so the red job blocks no merge. The transcript and the execution file exist only
  on Claude's runner, so the Report step stays in the `review` job (#454); a failed proof fails that
  job, and `post` still posts the verdict (its `if:` asks for a `review` job that wasn't cancelled
  and a verdict). GitHub drops a job output that holds a secret's value, so a verdict quoting the
  seat token never reaches `post`, and nothing is posted.
- **Apply, in its own job (#454).** `post` runs on a fresh runner that never ran the model, and is
  the only job that enters `review` and mints the App's token, scoped to contents and pull requests.
  The hand-off is the `review` job's outputs: the verdict, the head, the base and its commit as the
  gate read them, and the commit `origin/<base>` pointed at after the action's fetch (read with
  plain git after Claude, on Claude's runner, the only one that fetched it). They are data from the
  model's runner, so before the token exists `post` checks the run's ref and runs
  `post-review.sh --check`: the verdict's whole shape and no credential in it, the head a commit
  SHA, and on a stacked part a plain base name and the two base commits the same SHA (#404's race
  check, which two empty values no longer pass). It reads the PR's file list again with the
  read-only `GITHUB_TOKEN` rather than taking it from the hand-off, so the rows from paths never
  rest on the model's runner. `.github/scripts/post-review.sh` (tested by
  `.github/scripts/tests/post-review.test.mjs`) then posts the review and applies the rules above in
  code. It approves only when none of these holds: a Required finding, `review:admin` (until #104),
  or an earlier finding of its own still open. **An escalation row or an escalation thread of its
  own no longer withholds it on a PR the admin's account opened (#264, done in #322)**: there it
  approves while its escalation thread is open on the PR, which then alone holds the merge. On a PR
  an App opened, or anyone else, they still withhold. It also reopens escalation threads someone
  other than the admin resolved, resolves only the App's own fixed finding threads, adds the label
  and the escalation thread, requests the admin's review on factory PRs, and dismisses its own
  Request changes when it withholds with every finding fixed. **#495 (22 Nov 2026), once #566
  lands:** it approves unless a Required finding or an earlier finding of its own is open; neither
  `review:admin` nor an escalation withholds it, whoever opened the PR, and it no longer reopens
  escalation threads. It still adds the label and the escalation thread ("Solo-admin approvals",
  below).
- **Rows from paths (12 Nov, #240's review).** The script also works out the rows that depend only
  on paths, and merges them with the verdict's, so a prompt-injected verdict can't drop them:
  Code-owned path (`.github/CODEOWNERS`, gitignore rules, a rename's old path too) and Content
  change (any file under `packages/sim/src/content/` but its tests). The second errs towards the
  admin: a path can't show whether a value changed, so a check-only edit there escalates again.
  Feature slice, Interface change, Security-sensitive code (no globs until M3), the issue rows and
  Not converging need reading, so they stay the verdict's.
- **`labeled`:** adding `review:admin` re-runs the review, which dismisses the App's earlier
  approval and posts a COMMENT (test (e)); a later COMMENT alone wouldn't replace an APPROVE. The
  job skips every other label, and the label the App adds itself (`sender` is
  `sunny-reviewer[bot]`), so it can't loop. Its concurrency group is on the job, so a skipped event
  doesn't cancel a running review. `post` has a group of its own that never cancels (#454): an older
  run's `post` can't cancel a newer run's review, and a `post` that started finishes its review;
  `post-review.sh` posts nothing once the head has moved.
- **Once per head (#274, 16 Nov; retro 2026-11-15, item F).** Before Claude runs, the `gather` step
  asks `.github/scripts/review-gate.sh`, and every later step waits on its answer. It skips a head
  the App has already reviewed: a review of its own on that commit with a non-empty body, which is
  the summary every run posts last; the empty-body reviews its line comments make don't count, so a
  run that died before its summary is retried. The exception keeps test (e) true: the review runs
  again while the PR carries `review:admin` and an approval of the App's still stands (state
  `APPROVED`, not yet dismissed), whatever the event, since a `reopened` at the same head can cancel
  the `labeled` run. Tests: `.github/scripts/tests/review-gate.test.mjs`.
- **An approved head isn't reviewed (#404; admin, 21 Nov 2026).** The gate also skips a head that
  carries an `APPROVED` review from the admin or from `sunny-reviewer[bot]` on that very commit. A
  head with only the bot's Request changes or comments is still reviewed, a push after an approval
  is a new head and is reviewed, and a dismissed approval reads `DISMISSED`, so it doesn't count.
  The test (e) exception comes first: the bot's standing approval under `review:admin` is withdrawn
  even when the admin approved the head too. So the App reviews every head nobody has approved yet,
  and a factory fix round is re-reviewed on its own push. Opening a PR still gets one review of its
  first head: it opens as a draft (#358), which the job skips, the ready mark starts the review, a
  newer run for the PR cancels an older one (the job's `concurrency`), and the gate skips a head a
  finished run already reviewed.
- **Auto-merge (step 3 of the flow; #68 step 4, 12 Nov).** After an Approve, the script turns on
  auto-merge, squash, for the head it reviewed (`enablePullRequestAutoMerge` with
  `expectedHeadOid`). When a run doesn't approve, it turns off auto-merge that is on. It never
  merges: `gh pr merge --auto` was rejected because it merges at once when the PR is already
  mergeable, whatever `allow_auto_merge` says. So Q16 still holds at the repo setting: while
  `allow_auto_merge` is off, GitHub refuses, the approval stands and the log reads
  `auto_merge=refused`. Squash only for now; the PR template's merge-commit choice isn't read. On a
  PR based on anything but `main`, a stacked part, it never turns auto-merge on, and turns off one
  already on (#404): that would squash the part into the part below on its own, and a stack merges
  whole. The log reads `auto_merge=stacked`.
- **No subprocess env scrub here (#454).** `factory.yml` sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`,
  which needs bubblewrap installed and smoke-tested first. The reviewer's Claude step doesn't: its
  Claude has no Bash, no hooks (`--setting-sources user`), no MCP servers and `Read(//proc/**)`
  denied, so no subprocess runs a command the model chose, and the scrub keeps the token only from
  such subprocesses. Its runner holds the seat token and a read-only `GITHUB_TOKEN`, nothing that
  writes. Adding the scrub would cost an `apt-get` and a new way for every review to fail for no
  change in what the model can reach. Revisit it if the reviewer ever gets Bash.
- **Alternatives considered.** Claude writing to GitHub itself with the App's token, through `gh` or
  the action's comment tools: rejected, because the model that reads the PR's text would then hold a
  token that can approve. A Bash allow-list (`gh pr view:*` and the like): rejected, because Bash
  rules match command text (`docs/agents/sandbox.md`). One job with the App's token minted after
  Claude (the layout until #454): rejected once the seat token got its own environment, because a
  job that enters `review` gets both the seat token and the App's key, and the write step shares a
  runner with whatever Claude's step left behind. The skill proof in `post`, from an uploaded
  transcript: rejected, because `actions/upload-artifact` is a new action (as for the factory) and
  the transcript holds the PR's text.

### Solo-admin approvals: removing `review:admin` is the sign-off (#495)

**Decided by the admin, 22 Nov 2026, in #495's grill; amends this area where the notes marked "#495"
say so. #565 built the guard (migration step 2; #494's stopgap is gone from it); #566 (the bot) and
#567 (the stack check) follow, and until the admin's steps below are done, the text the decisions
amend still applies where those PRs haven't changed it.**

**The problem.** GitHub never counts a PR's author as its own approver or code-owner reviewer, and
its answer for a solo maintainer is the bypass list. "Merge stack" offers no bypass (#315), and
`main checks` has none (#110). So every code-owned PR the admin's account opens (an `--as-admin`
lane, #385), and every stack with one, merged by bypass, part by part. #494 made
`guard / code-owned` count the author-admin's own Comment review, but a Comment review looks the
same as a plain comment in the timeline (admin, 22 Nov, while merging #487), and the bypass stayed.

**The decisions (Q1–Q7 of the grill):**

1. **The reviewer bot approves every PR it finds clean**: escalated or not, code-owned or not,
   whoever opened it. Its approval means "the code review passed", meets the count of 1, and lets a
   stack merge in one action. The admin's gate is never a withheld approval any more; it is a
   required check in `main checks`, which has no bypass. #322's reason for withholding on a PR an
   App opened (anyone's resolution of the escalation thread opens the merge before the bot checks
   who resolved it) goes away, because no thread opens anything (decision 6). What it costs: an
   approval no longer says the admin agreed, only the check does, so the check must be required and
   never skipped (a skipped required check passes, #312); and on an escalated PR the bot's
   auto-merge fires the moment the check turns green, so the admin's sign-off is also the merge.
2. **GitHub's "Require review from Code Owners" goes off**, and `guard / code-owned` is the only
   code-owner gate. #68's precondition, the guard being a required check, holds (checked 22 Nov).
   What it costs: a bug in the guard would let a code-owned PR through. The guard runs `main`'s
   script, CODEOWNERS and (decision 7) workflow, and all three are code-owned. CODEOWNERS still
   requests the admin's review. Rejected: keeping it on, which makes #494's bypass merges permanent.
3. **The admin's sign-off is removing `review:admin`**, read from the PR's events. Removing a label
   fires `pull_request_target` `unlabeled`, so the guard runs on the admin's act, and the timeline
   shows it unambiguously. The run that removal fires checks that the event's head is still the PR's
   head and writes a **sign-off record on that commit as a check run named
   `code-owned / sign-off`**, conclusion `success`, its summary naming the removal's event id and
   actor. Only a GitHub App (here the Actions token) can create a check run, so no user token forges
   it. A workflow on a PR's own branch holds an Actions token too, and could write a check run of
   that name, as it could fake any required check today; so the guard counts a record only when it
   came from `main`'s `code-owned.yml` on `pull_request_target` (read through the record's check
   suite and workflow run), which #565 proves on a throwaway PR. The record is not a required check.
   Every guard run passes a held PR only when the label is off and such a record exists for the
   current head. A push re-arms it: the guard runs on `synchronize`, puts the label back on any PR
   that has ever carried it, and fails; even without that run, the new head has no record, so it
   can't pass. A held PR is a code-owned one (the guard adds the label from the diff, as today) or
   one the bot escalated (the bot adds it); from then on the guard reads the label, not the reason.
   #494's Comment-review rule goes, and
   [#104](https://github.com/sssoto17/sunny-pastures/issues/104), "Retire review:admin", is
   superseded: the label is the gate, and the escalation thread is the bot's explanation. Rejected:
   a Comment review (ambiguous in the timeline), resolving the thread (fires no workflow), and both
   the label and the thread (two clicks for one decision).
4. **One writer per head.** The job gets a name of its own (`code-owned (run)`), neither of the two
   check-run names, and the script creates or updates one `guard / code-owned` check run on the head
   through the Checks API, re-reading the live state (label, the `code-owned / sign-off` record,
   diff) each time. Runs go one at a time: a per-PR `concurrency` group without
   `cancel-in-progress`, so a newer pending run replaces an older pending one and the last run reads
   the final state. A cancelled run carries the job's name, never the required one, so neither
   #379's stale twin nor #483's cancelled run can decide the result. A head the script hasn't
   written shows "Expected" and blocks. To prove on throwaway PRs first: an API-written check run
   satisfies a required check whose source is GitHub Actions, and updating it in place changes the
   merge box. Rejected: concurrency keyed by head and event (twins both report, and which one the
   gate reads is #379's open question), and a sweep that re-runs cancelled runs (treats the
   symptom). `pr-body.yml` keeps #483. **What #565's throwaway PRs found (23 Nov 2026; #629, #630;
   admin to approve in #565's PR):** a check run written through the Checks API with an Actions
   token lands in the commit's oldest GitHub Actions check suite, whichever workflow that is. So (a)
   the record's check suite and workflow run don't say who wrote it, and the guard proves provenance
   instead with an OIDC token GitHub signs for the writing run, in the record's summary: audience
   the repo, PR and head; claims `main`'s code-owned.yml on `pull_request_target`. (b) When that
   suite is a `create` run (board-branch.yml on a branch pushed with its first commit), the check
   run never reaches the PR's merge box, so the guard also sets a commit status `guard / code-owned`
   with the same verdict, which the merge box shows as required. An API-written check run in a PR's
   own suite does satisfy the required check, and updating it in place changes the merge box; a
   cancelled `code-owned (run)` isn't required. Alternatives considered for the record's proof: its
   check suite and workflow run (shown above not to carry provenance); a record written with an App
   token that only a `main`-only environment holds (sound, but one more credential for the admin to
   keep); and artifact attestations (the same OIDC root, with more moving parts). The verdict
   itself, check run and status alike, carries no such proof: a workflow on a PR's branch can still
   write a `guard / code-owned` of its own, as it could fake any required check before (decision 3).
5. **Only `sssoto17`, a `User`, signs off.** A removal by anyone else (either App, `github-actions`,
   another collaborator) writes no record; the guard puts the label back and stays red, as the bot
   reopens an escalation thread someone else resolved. Agents are denied removing the label: the
   `gh pr edit` and `gh issue edit` patterns in `.claude/settings.json` move from ask to deny, and
   the REST route (`gh api *labels/review:admin*`, `gh api *labels/review%3Aadmin*`) is denied too.
   Remote sessions skip the hooks but read the same settings. **The honest limit:** GitHub sees any
   session on the admin's account as the admin, so one that gets past the deny rules signs off as
   the admin; it could already bypass-merge, so this adds no power, and the events don't record
   whether a removal came from the UI or the API. Rejected: a separate sign-off identity (a second
   account or an App only the admin holds), one more credential and more clicks per PR.
6. **Thread resolution is no longer required** (`required_review_thread_resolution` off in `main`).
   The bot still posts the escalation thread, `escalated: <rows>`, mentioning the admin, and adds
   the label, but it stops reopening threads and stops reading its escalation threads as memory: the
   label's history does that. Nothing is lost on findings: a Required finding is a Request changes,
   which blocks until the bot approves, and the bot withholds its approval while a finding thread of
   its own is open. A thread the admin starts no longer blocks on its own; Request changes does.
7. **`code-owned.yml` runs on `pull_request_target` only** (`opened`, `synchronize`, `reopened`,
   `labeled`, `unlabeled`): the verdict depends on the label, the sign-off record and the diff, not
   on reviews. So every run takes `main`'s workflow as well as its script, and it never runs PR
   code.

**Patterns.** A _quality gate_ (one required check holds the merge for the admin, whoever approved);
a _single writer_ per head (one check run, updated in place, from serialised runs); a _capability
record_ (the sign-off is a check run only an App can write, bound to one commit); and the PR's
events as the _audit log_ (who removed the label, when).

**Migration, in order:**

1. The admin adds the deny rules (decision 5) to `.claude/settings.json`, a protected path.
2. Build: the new guard (decisions 3, 4, 5's guard half, 7), a hard switch that drops #494's rule in
   the same PR, with the throwaway proofs of decision 4. It merges under the rules of the day.
3. Open PRs merge under the old rules before it lands where they can; after it lands, each is
   updated onto `main` (`scripts/stack.sh refresh` for a stack), so its copy of `code-owned.yml` no
   longer has the review-triggered job writing under the required name, and the admin signs off by
   removing the label.
4. Build: `post-review.sh` approves every clean PR and drops thread reopening and thread memory
   (decisions 1, 6). Blocked by step 2: until then a PR the bot escalated that touches no code-owned
   path is held only by the withheld approval, and would auto-merge.
5. The admin turns off "Require review from Code Owners" and "Require conversation resolution before
   merging" in `main`.
6. Verify on a throwaway stack the admin's account opens, with a code-owned part: the bot's
   approvals meet the count, the merge box asks for 1 approval, not 2 ("Require an additional
   approval for unattributed Copilot pull requests", on by default and scoped by the docs to PRs
   Copilot opens: A8), the admin removes the label on each part, and "Merge stack" merges it in one
   action. Then #68's code-owner criterion is ticked and #104 closed as superseded.

### Stacks: one approval pass, one test run, one merge (#264)

Related PRs are always a native GitHub stack, built one way (admin, 16 Nov 2026; `CONSTRAINTS.md`,
"Split size"). Before #264, with 1 required approval and the bot withholding its approval on
escalated PRs, the admin could only bypass one part at a time, and each merge restacked the rest and
re-ran their checks. That kept ruleset `main` at 0 approvals with last-push approval off (#68).

- **One entry point: `scripts/stack.sh`** (`open`, `add`, `update`, `refresh`, `status`), for local
  and cloud lanes alike. It works over REST (`pulls`, `stacks`, `stacks/<n>/add`) and plain git:
  `gh stack` and `gh pr` reach GraphQL, which the cloud GitHub proxy refuses, while `/stacks` passes
  it (checked from a cloud session, 16 Nov). The stack stays **linear**: after an edit to a lower
  part, `update` rebases each part above it onto the new head below; after a lower part merges,
  `refresh` rebases the rest onto the base, dropping the commits the squash holds. Both push the
  stack's own part branches with `--force-with-lease`, never `main`. The first design merged upward
  instead, and the throwaway stack showed why it can't: GitHub's "Rebase stack" failed twice on
  #313, and replaying #313 here showed the merge commit `update` had made coming out empty after
  #312's squash, which stops a replay. It never merges and never unstacks; merging stays with the
  admin, and `.claude/settings.json` asks before every REST, MCP and `gh stack` merge path.
  _Alternatives:_ `gh stack` (GraphQL, so it fails in the cloud); a skill that calls the REST
  endpoints itself (the same calls with no tests); the GitHub MCP server (it has no stack tools).
- **`guard / stack-base`** fails a PR whose base isn't `main` unless it's in a native stack, so a
  hand-chained PR can't slip in. On `opened` the event's `pull_request.stack` is `null`, because
  `stack.sh` links the stack after opening the PRs (seen on throwaway stack #315), so the guard asks
  GitHub again for up to 60 s before it fails. Since #358 its run comes from `ready_for_review`,
  after the stack is linked, so the retry is a fallback.
- **Approvals.** The reviewer approves each clean part, escalated ones included when the admin's
  account opened them; the escalation thread alone holds the merge ("Approvals", above). (**#495, 22
  Nov 2026, once #565 and #566 land:** it approves every clean part, whoever opened it, and
  `guard / code-owned` holds each held part until the admin removes `review:admin` on its head.)
  GitHub's stack merge needs "all pull requests below it … approved and … passing checks", and its
  restack "will … retain approvals if a diff has not changed, even if you have the dismiss stale
  approvals rule enabled"
  ([merging stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests),
  quoted in #264). Throwaway stack #315 under a ruleset like `main` at 1 approval (admin, 16 Nov)
  showed what a bypass can't do: a bypass merges one part at a time, and "Merge stack" offers no
  bypass ("Unable to merge as a stack"), so a one-action stack merge needs every part below to pass
  the rules itself. That's the bot's approval on each part, which needs "approval from someone other
  than the last pusher" met, and so #68's App. After a partial merge GitHub retargets the next part
  to the base and keeps the stack, but doesn't rebase it ("This stack is out-of-date with its base
  branch"): `scripts/stack.sh refresh` does. Whether approvals survive that restack, or
  `stack.sh refresh`, is a criterion on #68, checked on the first stack after `main` goes to 1
  approval.
- **The reviewer covers every part (#404; admin, 21 Nov 2026).** `review.yml` has no `branches:`
  filter any more. GitHub matches that filter against the PR's base (events-that-trigger-workflows,
  "Running your `pull_request_target` workflow based on the head or base branch"), so
  `branches: [main]` never ran for a PR on another base: neither #312 to #314 (a throwaway stack on
  `test-264/base`) nor #402 (part 2, on part 1's branch) got a review. The workflow and its checkout
  still come from `main` whatever the base: for `pull_request_target` on github.com, `GITHUB_REF` is
  "Default branch" and `GITHUB_SHA` "Last commit on default branch", and the workflow "is taken from
  the base repository's default branch" (the same page, and securely-using-pull_request_target; read
  from `github/docs` `main`, 21 Nov 2026). The `gather` step stops on any other `GITHUB_REF`, so a
  change there fails loudly. The gate (`review-gate.sh`) then decides by base, from `GET pulls/<n>`,
  never the event:
  - a PR on `main` is reviewed as before;
  - a PR on another base is reviewed only when its live `stack` is set, the same test as
    `guard / stack-base`, so a hand-chained PR the guard refuses gets no review. The event's `stack`
    is `null` on `opened`, but parts open as drafts and are marked ready once linked (#358), so the
    run that reviews a part already sees its stack. There is no retry: a part that isn't linked yet
    is skipped, and its ready mark reviews it;
  - `claude-code-action` restores `.claude/`, `CLAUDE.md`, `.mcp.json` and a few other config paths
    from `origin/<base.ref>` before Claude starts (`SENSITIVE_PATHS` in
    `src/github/operations/restore-config.ts` at the pinned SHA). Above part 1, that is the part
    below's branch, which nobody has merged. `--setting-sources user` already keeps those settings,
    hooks and MCP servers unloaded, but the gate doesn't lean on it: when the stack below changes
    one of those paths (REST compare of `main...<base sha>`; 300 files, the compare's cap, counts as
    "may"), it skips the part with a warning, and the coordinator dispatches a reviewer. The compare
    takes the base's SHA, never its name: `gh api` cuts a path at `#`, so `main#x` compared `main`
    (PR #468's review). A base name outside `[A-Za-z0-9._/-]` gets no review at all;
  - the action fetches `origin/<base>` 20 to 60 s after the gate read it, so the part below can move
    in between. `post-review.sh` checks that `refs/remotes/origin/<base>` is still the commit the
    gate read, and otherwise posts nothing and fails the run. Claude has already run by then, with
    `--setting-sources user` keeping that config's settings, hooks and MCP servers unloaded; only
    the review is withheld.

  The coordinator dispatches a reviewer only when the App can't: a part the gate skipped for
  restored config or an odd base name, a run that posted nothing because the base moved, a PR opened
  before #404 landed, or a run that failed. _Alternatives:_ keeping `branches: [main]` and listing
  each stack's base (bases are lane branches, unknown ahead of time); a `branches-ignore` list (the
  same problem); calling `stack-base-guard.mjs` from the gate (its one-minute retry exists for
  `opened`, which the draft flow no longer needs, and it would add a Node step ahead of every
  review); reading the event's `pull_request.stack` (`null` on `opened`).

- **Code-owner review on stacks: a finding, not a decision** (the admin took the decision out of
  #264, 16 Nov 2026). On a PR the admin's account opened, code-owner review showed no gate of its
  own: #313, code-owned, showed only "At least 1 approving review is required by reviewers with
  write access", because the admin is both its author and its only code owner. Once #68 sets 1
  approval, a code-owned part needs a code owner's approval that nobody but the admin can give, and
  the admin can't approve their own PRs, so it merges only by bypass, and a bypass can't merge a
  stack (above): a stack with a code-owned part merges part by part. Code-owner review stays on
  (Q15). This is input for #68, which turns code-owner review off only after the deterministic
  `guard / code-owned` check (#337) is required (#68's criteria). From #494 until #565 the guard
  itself passed such a part once the admin, as its author and a code owner of each of its code-owned
  paths, had left a Comment review as their last review on its head (below); the bypass is still
  needed for GitHub's own code-owner review. **Decided 22 Nov 2026, #495:** code-owner review goes
  off and the guard is the only code-owner gate, so such a stack merges in one action once the admin
  has removed `review:admin` on each part ("Solo-admin approvals", above).
- **One test run per stack.** `ci / typecheck`, `ci / lint` and `ci / test` run on a stack's top
  part only, diffing from the stack's base, so one run covers every part. The other jobs, the floor
  guard among them, and the review run on each part. The `if:` in GitHub's
  [CI for stacked PRs](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests)
  reads `github.event.pull_request.stack`, which is `null` on `opened`, so all three parts of #315
  ran the suite at open. So a job, `ci / stack`, asks GitHub instead (`isTopPart` in
  `stack-base-guard.mjs`) and the three jobs skip only when it answers `false`; a failed lookup
  never skips them. It answers `false` only for a lower part whose head the top open part's head
  already contains (REST compare: `ahead` or `identical`), so a push to a lower part without
  `scripts/stack.sh update`, or a top part that left the stack, runs the suite on that part rather
  than leaving a stale green above it (#264's fix round). Both jobs take the script from `main`, as
  the floor job does (#99), so a PR can't switch off its own tests. Before #358, part 1 of a stack
  on `main` ran them once at open, since it was opened before the stack existed; it now stays a
  draft until the stack does. Shown on #315: skipped on the lower parts, run on the top one (runs
  43939156451, 43939157918, 43939156505). A required job skipped by its `if:` counts as passing:
  #312 showed ci/lint, ci/test and ci/typecheck "Skipped · Required" with a green summary ("3
  skipped, 10 successful"; admin, 16 Nov).
- **One CI run per head: drafts around every push** (#358; admin, 21 Nov 2026). A push to a stacked
  part fires `pull_request` `synchronize` twice on the same head, about a second apart:
  `scripts/stack.sh update` pushes the parts in one atomic push, so the part above gets a new head
  and a new base at once (PR #376's evidence: #365, #366, and throwaway stack #391 over 4 rounds).
  No event filter tells the two apart (same action, head and merge commit), and no push from
  `stack.sh` or `gh stack` avoids them. So they land on drafts:
  - `scripts/open-pr.sh` opens every PR as a draft (`draft: true` on REST create). The `open-pr` run
    links a stack part into the stack, then marks it ready; `stack.sh` keeps part 1 a draft until
    the stack exists, then marks it ready. So `ready_for_review` carries `pull_request.stack`.
  - `stack.sh update` and `refresh` turn the parts they move into drafts, push, and wait until
    `GET pulls/<n>` shows each part's pushed head and, above part 1, the part below's new head as
    its base. Then they mark those parts ready. A wait that times out fails loudly and leaves the
    parts drafts, so no stale run can report; running the command again marks them ready.
  - `ci`, `security` and `pr-body` run on `ready_for_review`, and every job skips while the PR is a
    draft. A first job, `gate`, reads the PR's live draft state (`GET pulls/<n>`, read-only token),
    never the event payload's (admin, 21 Nov 2026, option (a) of #449's review); every other job has
    `needs: gate` and `if: ${{ !cancelled() && needs.gate.outputs.draft != 'true' }}`. On `push` to
    `main`, or when the read fails, the output is empty and every job runs: the gate fails open
    toward running CI. A required check skipped on a draft hides nothing, since a draft can't merge,
    and the ready mark starts the run the merge box reads. `review.yml` already skipped drafts and
    ran on `ready_for_review`, so the review runs once a head too.
  - The switch goes through the `pr-draft` dispatch ("Lanes open PRs as sunny-factory", below): the
    REST update endpoint has no draft field, and the cloud proxy refuses the GraphQL mutations
    `convertPullRequestToDraft` and `markPullRequestReadyForReview`. The App's token marks ready,
    never `GITHUB_TOKEN`, since events `GITHUB_TOKEN` causes start no workflows.
  - Whether turning an approved part into a draft keeps its approval is unknown, and is checked on
    the first real stack after #358 (its criteria); the admin decides if it doesn't.

  _Alternatives_ (PR #376, options (a) to (d)): no concurrency group, from #264 to #358, where both
  twins ran in full and a flaky job got two draws (on #366 `ci / test` timed out on one twin and
  passed on the other); a twin gate whose second run replays the first's result, which still runs
  twice and so breaks "two runs never go in parallel" (admin, 19 Nov); a group without cancelling,
  where both runs cost in full and a third event cancels the pending one; stages and filters, which
  can't tell the twins apart.

- **The backstop: cancel-in-progress** (#358, admin decision (c)). `ci`, `security` and `pr-body`
  have a `concurrency` group per workflow and PR number, `github.sha` on a push, with
  `cancel-in-progress: true` (the workflows' headers hold the expression). A newer run for a PR
  cancels the older one, and `github.sha` gives each push to `main` a group of its own, so nothing
  on `main` is cancelled. A `synchronize` that GitHub raises after the ready mark carries
  `draft: false`, runs in full, and cancels the ready run. The merge box reads each check from the
  head's newest check suite: on #313 both events came in the same instant and the cancelled run sat
  in the newer suite ("10 cancelled, 3 successful", blocked), while on throwaway stack #391, events
  about 1 s apart, 12 of 12 cancelled runs sat in the older one. If a merge box shows cancelled
  checks again, #376's guard that restarts the cancelled run is the next step. **The gap the gate
  closes:** a `synchronize` raised while the part was still a draft, whose run starts only after the
  ready run. Read from its payload (`draft: true`), its jobs would skip, it would cancel the ready
  run, and its skipped checks would sit in the newest suite, which reads as passing. The wait before
  the ready mark only narrows that window, since a head and base GitHub shows prove the events were
  raised, not that their runs exist. With the gate, that late run reads the PR as ready and runs in
  full, so the newest suite holds checks that ran. **The residual** is #313's twin race: two runs
  created in the same instant, where the cancelled one lands in the newer suite. It fails closed:
  the merge box shows cancelled checks and blocks, and a re-run clears it.
- **`guard / code-owned` runs on reviews only** (#379; admin, 19 Nov 2026). _Historical: since #565
  it runs on `pull_request_target` only ("Solo-admin approvals", area 2)._ It ran on `pull_request`
  and on `pull_request_review`, and on PR #377 the admin's approval didn't unblock the merge: the
  review run passed in its own check suite, but the merge stayed blocked on the `pull_request` run's
  earlier failure until that run was re-run by hand. So `code-owned.yml` triggers on
  `pull_request_review` (`submitted`, `dismissed`) alone, one run per review, with nothing that
  re-runs another run. `main` needs an approval, so no PR merges without a review, and so without
  this check. A push leaves the new head without it ("Expected"), which blocks, until a review of
  that head runs it; whether the stale-approval dismissal on a push fires `dismissed`, and so runs
  it at once, is checked on #379's throwaway PRs. The job has no `if:`: a skipped required check
  reads as passing (above), so a COMMENTED review would turn it green; it always runs and passes or
  fails on the diff and the reviews. Like `ci`, `security` and `pr-body` since #358 (above), it has
  a `concurrency` group per PR with `cancel-in-progress` (admin, 19 Nov): reviews don't come in
  twins on one push, and a run that a newer review cancels is followed by the newer run on the same
  head. Whether GitHub then reads the cancelled run as the head's result, as on #313, is unproven
  for review runs; #379's throwaway PRs check two reviews seconds apart. The workflow comes from the
  PR's merge ref, as for `pull_request`; the script and CODEOWNERS still come from the default
  branch (#337). The label `review:admin` it adds now lands at the first review, not at open; the
  agent and the reviewer bot still add it earlier (CONSTRAINTS.md, "Escalation criteria").
- **`guard / code-owned` on a PR a code owner opened** (#494; admin, 22 Nov 2026: option A).
  _Historical: #565 removed this rule; the sign-off is removing `review:admin` on the head
  ("Solo-admin approvals", area 2)._ The guard waited for a code owner to approve the head, GitHub
  never lets an author approve their own PR, and `main checks` has no bypass (#110), so a code-owned
  PR the admin's account opened (an `--as-admin` lane, #385; ADR-0007 section 6) could never pass
  it: #386's stack (#487, #488) was the first. Now, when the PR's author is a code owner of every
  code-owned path the PR touches, the guard counts the author's own latest review that isn't
  dismissed as the sign-off, if it is on the current head (`commit_id`) and APPROVED or COMMENTED.
  Latest means last submitted (`submitted_at`, then `id`), since a review's id likely dates from
  when its draft started (inferred from REST, not checked here). The author is read from the REST PR
  the run already fetches to pin the head (`user.login`, and `user.type` must be `User`), never the
  event, as `post-review.sh` reads who opened a PR (#322). Every other case keeps the rule: on any
  other PR only a code owner's APPROVED review on the head counts; the bot's reviews never count; a
  review of an older head never counts. `code-owned.yml` already runs on `submitted` and `dismissed`
  reviews, so the admin's Comment review runs the check; the script and CODEOWNERS still come from
  the default branch. **The admin's steps** on such a PR, and on each part of such a stack in turn:
  1. resolve the escalation thread;
  2. leave a Comment review on the part's head, which runs `guard / code-owned` green;
  3. bypass-merge the part ("Merge stack" offers no bypass, above); for a stack, run
     `scripts/stack.sh refresh` after each merge, then repeat from step 1 on the next part (a
     refresh pushes a new head, which needs a new review).

  **The honest limit:** GitHub sees any session on the admin's account as the admin, so such a
  session could leave that Comment review on its own PR, as it could resolve the thread. That adds
  no merge path: code-owner review still holds the PR until the admin's bypass, which the same
  session could already use. REVIEW.md keeps dispatched reviewers read-only, a standard rather than
  a boundary, as for resolving threads (above); a PR the factory App opened (#107) keeps the old
  rule.

  _Alternatives:_ the bot approves every clean PR and code-owner review goes off, the broader
  redesign, kept for #495; counting any review by the admin whoever opened the PR, which would let a
  COMMENTED review stand in for an approval on App PRs the admin can approve; a label or a
  `/approve` comment the admin posts, which a session on the admin's account could post too, as it
  can a review, and which the guard would have to learn to read.

  **#495 (22 Nov 2026), once #565 lands:** this rule and the admin's steps above are replaced. The
  admin removes `review:admin` on each part's head, with no thread to resolve, no Comment review and
  no bypass, and the stack merges in one action once the admin's ruleset steps are done ("Solo-admin
  approvals", above).

- **The floor guard compares the whole stack below a part with the stack's base**, not each part
  with the part below (the admin left this to the lane, 16 Nov). Per-part diffs would read the guard
  from the lower part's branch, so a part could swap the guard that judges the part above, and a
  lower part's unmerged Exceptions row would read as "merged" in the spent-row note (PR #301's
  review; the note claims no merge since #310). The cumulative diff costs this: an expected floor
  finding in a lower part turns every part above it red, as on #259 and on this stack's own
  `ci.yml`. A stack merges whole, so one route clears it: an Exceptions row in the part that needs
  it covers the parts above it, or the admin lifts `main checks` once for the stack's merge. #264's
  own stack took the second (admin, 16 Nov 2026): its new `if:`s, the changed floor job, and the
  dupes and coverage steps now diffing from `$SINCE` are 12 `check-removed` findings in `ci.yml`, by
  design.
- **A partial merge can't hide a broken `main`.** A partial stack merge lands lower parts whose
  tests ran only as part of the top part's run. A merge queue (`merge_group`) would test exactly
  what lands, but it isn't available on this user-owned repo: a ruleset with a `merge_queue` rule
  answered HTTP 422 "Invalid rule 'merge_queue'" (admin, 16 Nov). So `ci` also runs on `push` to
  `main`, which detects rather than prevents, and the standard is that a stack merges whole
  (`CONSTRAINTS.md`, "Split size"; admin, 15 Nov).
- **Until #404 the reviewer only saw PRs based on `main`.** `pull_request_target` runs `main`'s
  `review.yml`, whose `branches: [main]` matched a part only when its base was `main`: #303 (base
  `main`, part 2 of stack #304) was reviewed while #302 was open. A part based on the part below
  wasn't, even with the filter widened on that base branch: #312 to #314, and #402, got no review
  run. #404 dropped the filter ("The reviewer covers every part", above).

**A weakened bar is blocked, or goes to the admin (decided 7 Nov).** The ways a bar gets lowered are
listed once, in `CONSTRAINTS.md`, "Guarding the bar". `guard / floor` fails a PR that weakens the
bar, unless the same PR adds an Exceptions row to `CONSTRAINTS.md`. That file is code-owned, so the
PR then needs the admin's approval. One rule, with no commit-message escape hatch.

**Tuning** (the self-improving loop, `docs/diagrams/workflow.md`):

- log every revert of a bot-approved PR, with its paths and cause, as data for the report, including
  PRs the admin would have escalated;
- when a bad bot approval happens twice, move the paths to CODEOWNERS or sharpen the escalation
  criteria (`CONSTRAINTS.md`, "Admin review");
- when escalated PRs keep coming back unchanged from the admin, loosen the criteria.

### The factory's identity (Q2, decided in #37)

**What the factory is.** The _factory_ is agent work on a `factory:ready` issue that runs without
the admin in the loop, from launch until its PR is open. The reviewer bot is not part of the
factory: it reviews the factory's PRs. A session the admin drives is _attended_, and is never the
factory, even when it works a `factory:ready` issue. `GLOSSARY.md` holds the game's language, where
"factory" is a word to avoid (it means a Facility), so the process term is defined here.

**Decided 7 Nov:** the factory gets its own identity, so code-owner review and the reviewer bot see
a factory PR as someone else's. A cloud session always acts as its owner, since the cloud GitHub
proxy swaps git credentials for the owner's token (#37, #60), so that identity can't come from a
cloud session.

**Decided 8 Nov (#37): the factory runs as its own GitHub App, `sunny-factory`, from Actions on
GitHub-hosted runners.** An App needs no seat and no second account, and it isn't a code owner: its
PRs are what the admin approves. The facts behind it are in the research for #60
(`docs/spikes/research-factory-identity.md` on the throwaway branch `research/factory-identity`),
where each claim is marked as documented, repo record or inference. The options #37 weighed:

<!-- prettier-ignore -->
| | (a) App, GitHub-hosted runners | (b) App, self-hosted runner | (c) Claude self-hosted environment | (d) own `claude -p` dispatcher |
|---|---|---|---|---|
| Identity | `sunny-factory[bot]` | `sunny-factory[bot]` | The admin, unless a wrapper mints App tokens | `sunny-factory[bot]` if handed an App token |
| Cost while private | Pro's $18 a month (area 9), then billed or blocked | Minutes free; the host is ours | Our host, plus Team seats | Our host |
| Cost once public | Free | Free, but GitHub says self-hosted runners "should almost never be used" on public repos | Our host | Our host |
| Repo hooks run | Yes: `claude-code-action` loads project settings by default | Yes, plus the host's `~/.claude` | Yes | Yes, without `--bare` |
| A database per job | A fresh VM per job, Docker on Ubuntu runners | Only with just-in-time runners and our own cleanup; must stay off the load-test VM | One container per session | Ours to build |
| Secrets | Actions environment secrets | Actions secrets, delivered to our host | Our host | Our host |
| What the admin sets up | Two Apps, their keys, the Claude token, "Allowed actions", the workflows | All of (a), plus a host, runner automation and Docker | A Team organisation, a runner image, a token wrapper | A host, the dispatcher, token minting, isolation |

(c) needs a Team or Enterprise plan whose Owner turns it on, so it would put the project inside the
admin's employer's organisation. (b) and (d) add infrastructure we'd build and keep running, and (b)
must be dropped or fenced off once the repo is public. (a) costs minutes only until go-public (#38).

- **Two Apps, `sunny-factory` and `sunny-reviewer`.** GitHub doesn't let a PR's author approve it,
  so one App couldn't open a PR and approve it. Each App has its own private key, an environment
  secret handed only to its own job, so a leaked factory key can't approve anything. The reviewer's
  workflow lists the factory App in `claude-code-action`'s `allowed_bots`.
- **The factory App's permissions:** contents, pull requests and issues write. No Administration, no
  Workflows, and **on no bypass list** (`main`, `v*`, `production`). The factory job sets
  `permissions:` so its `GITHUB_TOKEN` is read-only; otherwise that token is a second identity the
  factory could act through.
- **Its token** comes from `actions/create-github-app-token` (GitHub-owned, so already allowed by
  area 8), expires after an hour and is revoked when the job ends. Its PRs start CI. A PR opened
  with `GITHUB_TOKEN` would not: its runs wait for someone to approve them
  ([triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow),
  checked 7 Nov).
- **Hooks:** `claude-code-action` loads the project's `.claude/settings.json` by default, so the
  repo's hooks run in factory jobs (#60).
- **A database per job:** each job is a fresh VM, and the acceptance stack runs in Docker on it.
- **Secrets** are Actions environment secrets: the two App keys, `CLAUDE_CODE_OAUTH_TOKEN` and the
  sweep's Project token, each set with `gh secret set` and never echoed.

**How Claude is billed in CI (decided 8 Nov).** The factory and the reviewer use a `setup-token`
from the admin's employer seat (Team or Enterprise), stored as `CLAUDE_CODE_OAUTH_TOKEN`. Team and
Enterprise seats fall under Anthropic's Commercial Terms, so the Consumer Terms' clause on
"automated or non-human means" (#60) doesn't apply. The admin's statement, recorded here: the
employer knows the seat is used for school work, and the project only uses allowance the employer
already pays for, which the admin's 60 hours a month of paid work leave unused. The employer is the
contracting customer for the seat, so its organisation's policies, and its admins' view of the
seat's usage, apply to these runs too. A billed API key is the fallback, only if it becomes
necessary, for example if the employer's policy ever rules this out. The factory and the reviewer
share the seat's weekly limit with the admin's paid work, hence the caps below.

**How a factory job starts (decided 8 Nov; historical).** This paragraph and its list record the 8
Nov plan. Since #619 (admin, 23 Nov 2026) `factory:ready` is the only gate, and neither the gate nor
the sweep reads Ready or Mode: see "The factory workflow, built" and "The factory sweep, built"
below. The factory is a `workflow_dispatch` workflow that takes an issue number. The plan had it
refuse an issue that lacks `factory:ready` or isn't in Ready. Three things dispatch it:

- **a scheduled sweep** at 07:00, 12:00 and 17:00 CET. It dispatches **one** item that is Ready, has
  Mode Factory and carries `factory:ready`, and has no open PR or branch yet, and none while a
  factory job is running or waiting;
- **a chain:** when a factory job finishes (`workflow_run`), the sweep runs again and dispatches the
  next item, so a queue drains one job at a time without waiting for the next slot;
- **`/today`** (stage 2, #73): it reports what the factory did since the admin's last workday, which
  issues are ready for it and a suggested queue, and starts the queue on the admin's go-ahead.

Concurrency is 1: one factory job at a time. One item per dispatch is deliberate. A concurrency
group keeps one run going and one waiting, and a newly queued run cancels the one already waiting
(GitHub's concurrency docs), so dispatching a whole queue at once would cancel all but two. A
cancelled run still completes, so it would fire `workflow_run` and start more sweeps; the chain acts
only on a run that wasn't cancelled. **Open for the build issue:** how `/today`'s agreed order
reaches the sweep, which otherwise picks by Priority, then board order; and whether `workflow_run`'s
limit of three chained levels resets when a `workflow_dispatch` sits between the sweep and the
factory job (inference, untested). Moving an issue to Ready can't start a workflow itself, because
Project field changes aren't an Actions trigger. `GITHUB_TOKEN` can't read a user-owned Project
(area 5), so the sweep reads the board with a read-only token of the admin's. Which token is #102.
It is never a classic PAT with `repo`, which would reach every private repository the admin's
account can, the employer's included. Each run costs at least a whole runner minute: a sweep every
30 minutes would cost about 1,440 minutes a month while private, and three slots plus the chain
about 90.

**Caps (decided 8 Nov).** A repo variable, `FACTORY_ENABLED`, is the kill switch: the sweep, the
chain and the factory job check it. The reviewer keeps running, so open PRs still get reviewed. Each
Claude run has `--max-turns`, and its job has `timeout-minutes`, so one runaway issue can't use up
the week. Every factory and review run logs `total_cost_usd` (a client-side estimate) and its runner
minutes, as report data. A weekly budget is set from the first week of that data, together with the
map's cap on CI cost (#59).

**The kill switch, built (#106).** `.github/workflows/factory-switch.yml` is a reusable workflow
(`workflow_call`) that runs `.github/scripts/factory-enabled.sh`: only the exact value `true` gives
`run=true`; unset (which reads as empty), `false`, `TRUE` and anything else give `run=false` and log
one `SWITCH off: FACTORY_ENABLED is …` line. The factory workflow (#107) and the sweep and chain
(#108) call it as their first job, and every other job `needs` it with
`if: needs.switch.outputs.run == 'true'` (the snippet is in the workflow's header). A skipped job
never starts, so the `factory` environment never hands it the App's key: nothing mints a token or
calls Claude. The switch job itself holds no secret and no environment, only `contents: read` for
the checkout. Its cost is one more runner minute a run while the repo is private. The reviewer
doesn't call it. Neither does `open-pr.yml`: lanes opening their PRs as `sunny-factory` don't obey
the switch, only the factory jobs (the sweep, the chain and the factory job) do (admin, 19 Nov
2026).

- **Turn the factory off or on** (only the admin: a repo variable needs the admin's token). In the
  UI: Settings → Secrets and variables → Actions → Variables → `FACTORY_ENABLED` → edit (New
  repository variable the first time). Or:
  `gh variable set FACTORY_ENABLED --repo sssoto17/sunny-pastures --body false` (`true` to turn it
  on). Read it with `gh variable get FACTORY_ENABLED --repo sssoto17/sunny-pastures`. The next run
  reads the new value; a job already past the switch finishes, and `gh run cancel <id>` stops it.
- **It is set to `false`** by `scripts/setup/factory-switch.sh`, which asks first and reads it back
  (`scripts/setup/README.md`). The run with the switch off is posted on #106; the throwaway workflow
  that made it is removed.

**The factory workflow, built (#107).** `.github/workflows/factory.yml` is the `workflow_dispatch`
run above: an `issue` input, and a `max_turns` input that can only lower the cap. Pattern: a
pipeline of guard jobs, each skipped unless the one before says go, so a refusal never reaches a
secret or Claude; and a split between the model and the writer, so Claude never shares a runner with
a write credential (the rule `review.yml` follows too). Concurrency 1 (group `factory`, never
cancelling a running job), and `GITHUB_TOKEN` read-only in every job.

**Ready and Mode (admin, 21 Nov 2026, option b).** The workflow doesn't read the Project: no Actions
token can read this user-owned board (#102). `factory:ready` stands for Mode Factory, which
`triage-labels.md` keeps in step with it, and the admin's manual dispatch stands for Ready. Only the
admin and collaborators can set labels. The sweep (#108, below) read Ready and Mode from the board
before it dispatched; since #619 (admin, 23 Nov 2026) `factory:ready` is the factory's only gate,
and neither the sweep nor the gate reads Status, Mode or Track.

1. **`switch`** calls `factory-switch.yml`, exactly as its header shows. With the switch off the run
   logs `SWITCH off` and stops; that is how the workflow is tested without turning the factory on.
2. **`gate`** has no environment and only the read-only `GITHUB_TOKEN`.
   `.github/scripts/factory-gather.sh` reads the issue, the open PRs and the issue's `<n>-`
   branches, and `.github/scripts/factory-gate.sh` refuses (`GATE refused: …`) unless the input is
   an issue number and the issue exists, is open, isn't a PR, was opened by the owner or a
   collaborator (`author_association`: the repo is public, and an issue's author can edit its body
   after it is labelled), carries `factory:ready` (or `factory:working`, which the sweep sets just
   before it dispatches; #619), has no `blocked:*` label and no open native blocker (read from
   `GET …/issues/{n}/dependencies/blocked_by`), and has no open PR and no `<n>-` branch yet (one
   factory branch per issue).
3. **`factory`** (`timeout-minutes: 60`; environment `claude-seat`, which holds only
   `CLAUDE_CODE_OAUTH_TOKEN`) checks out `main` and installs. It runs the gate again on a fresh
   read, then writes the issue and only its owner's and collaborators' comments to files.
   `claude-code-action` runs on the setup-token with `--max-turns` from the gate (100 unless
   lowered, the Claude step stopped at 55 minutes), only the read-only `GITHUB_TOKEN` (as
   `github_token`, which the action also hands to git and its GitHub tools), and
   `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, with bubblewrap installed and smoke-tested first (below).
   The prompt is `/implement #N` plus `.github/factory-prompt.md`. Claude commits locally and writes
   the branch name, PR body and labels to files, and a plain step packs them with a git bundle of
   the new commits into the job's output (the hand-off, under 900 kB). The project's settings load,
   so an `ask` rule denies (no one can answer it) and the hooks run; web tools are off.
4. **`publish`** runs on a fresh runner that never ran the model, with `main`'s checkout.
   `.github/scripts/factory-publish.sh` refuses (`PUBLISH refused: …`, a failed job) a hand-off with
   any entry but the four files, a branch that isn't `<n>-<slug>`, a body without `Closes #<n>`, a
   label outside `review:admin` and `area:*`, a diff that touches `.github/workflows/` or
   `tests/acceptance/` (a pathspec, so a quoted non-ASCII name or a move counts), or a commit whose
   author or committer isn't `sunny-factory[bot]`. Only then does it mint the App's token
   (`contents: write` to push and to send `open-pr`'s dispatch, `pull-requests: read`), push the
   branch with hooks off, and run `scripts/open-pr.sh`, so `open-pr.yml` opens the PR as
   `sunny-factory[bot]`. The PR's author and every commit's author and committer are the App.
5. **`labels`** (`if: !cancelled()`, #619; a run the admin cancels leaves its label for the sweep's
   reconcile) moves the issue's `factory:*` label (below, "The factory sweep, built") on a fresh
   runner in environment `factory`, with an App token minted with `issues: write` only:
   `factory:review` when publish opened a PR or a fix round ran, `factory:failed` and one comment
   when the run opened none.
6. **`report`** (`if: always()`) logs `total_cost_usd` and turns, each job's billed minutes (GitHub
   rounds each job up) and their sum, and the PR.

**Caps.** `--max-turns` doesn't count the turns of `Task` subagents, so the 55-minute step timeout
and the job's 60 are the real bound on a run.

**The factory sweep, built (#108).** `.github/workflows/sweep.yml` dispatches at most **one**
eligible issue to `factory.yml` per run, so a queue drains one factory run at a time without the
admin starting each. It replaces the three daily slots above (admin, 22 Nov 2026). Pattern: the same
pipeline of guard jobs as the factory (`switch`, then `select`, then `dispatch`, each skipped unless
the one before says go), with the choice a pure function over gathered data
(`.github/scripts/factory-sweep.mjs`, tested on fixtures), and the reads in a separate script
(`factory-sweep-gather.sh`). Alternatives considered: one bash script that reads and decides (harder
to test on fixtures, as the gate's split shows), and one job that both reads the board and
dispatches (it would hold the Project token and `actions: write` together).

- **Triggers:** every hour (`23 * * * *` UTC: any hour will do, so DST needs no handling), the
  factory's runs finishing (`workflow_run`, the chain; a cancelled run is ignored, so a run the
  concurrency group replaced doesn't start a sweep of its own), and `workflow_dispatch` for the
  admin. Concurrency group `factory-sweep`, not cancelling, so two sweeps never overlap. After it
  dispatches, the sweep waits (up to 2 minutes) until the new run is listed, so a sweep queued
  behind it sees that run.
- **Credentials (admin, 22 Nov 2026; #102 closed as moot):** `select` enters environment `board`
  (main only) for `BOARD_PROJECT_TOKEN`, used on the Project's calls only (`PROJECT_GH_TOKEN`, as
  `board.yml`'s `move` does), REST only, for Priority and board order; the read-only `GITHUB_TOKEN`
  reads the runs, issues, PRs and branches. `labels` (#619) enters environment `factory` and mints
  the App's token with `issues: write` alone, to write the label moves before `dispatch` runs.
  `dispatch` alone has `actions: write`, and `GITHUB_TOKEN` dispatches `factory.yml` on `main`: a
  `workflow_dispatch` is one of the two events a `GITHUB_TOKEN` may start a run with
  ([triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)).
  That makes the factory run's actor `github-actions[bot]`, so `factory.yml`'s Claude step names
  exactly `github-actions` in `allowed_bots` (#582: run 45075597193 failed at the action's actor
  check without it). Dispatching with the factory App's token instead would need the App to get
  Actions write, which it doesn't have ("The factory App's permissions", above); that is the admin's
  call.
- **The decision**, in order, the first that holds deciding: the kill switch (`FACTORY_ENABLED`,
  read before anything else, so nothing is read with it off); a factory run that is queued, waiting,
  pending, requested or in progress (strictly serial); the **open-PR cap**: open PRs by
  `sunny-factory[bot]`, drafts included, at or above the repo variable `FACTORY_MAX_OPEN_PRS`
  (default 4 when unset; a value that isn't a whole number dispatches nothing). It is backpressure
  on the review queue, and works the same before and after auto-merge: a PR that merges lowers the
  count and the chain goes on (admin, 22 Nov 2026, replacing a per-day run cap). Then the eligible
  issues (admin, 23 Nov 2026, #619: `factory:ready` is the only gate): open, at `factory:ready`
  after the reconcile (below), opened by the owner or a collaborator, with no `blocked:*` label, no
  open native blocker (`GET …/issues/{n}/dependencies/blocked_by`), no open PR from a `<n>-` branch
  and no `<n>-` branch (the gate's rules, so the sweep doesn't dispatch what the gate would refuse).
  Status, Mode and Track aren't read: Backlog, Ready, In progress or In review all qualify, so the
  admin can label a whole chain at once and the factory walks it in blocker order.
- **The `factory:*` states (#619).** An issue carries at most one: `factory:ready` (the admin's
  "take this"; only the admin sets it), `factory:working` (a run is going), `factory:review` (a PR
  is waiting), `factory:failed` (the last run ended without a PR, or its PR closed unmerged). Each
  transition is written with the App's token by one script, `.github/scripts/factory-label.sh`,
  which removes the other `factory:*` labels before adding the new one: `sweep.yml`'s `labels` job
  sets `factory:working` on what it dispatches (a fix round's issue too, read from its PR's `<n>-`
  branch), before the dispatch; `factory.yml`'s `labels` job (`factory-outcome.sh`) sets
  `factory:review` once publish opened the PR or a fix round ran, and `factory:failed` with one
  comment when a run that passed the gate opened none: the run's link and the factory job's last
  `RESULT claude=`, `RESULT handoff=` and `RESULT factory=` lines (Claude's `FACTORY …` reason,
  #615), read from that job's log, backticks dropped, in a code block so the model's words can't
  format, link or mention. A gate refusal moves only an issue at `factory:working` to
  `factory:failed`, with the gate's reason; an issue the admin dispatched keeps its label. Retry is
  the admin replacing `factory:failed` with `factory:ready`. `review:admin` stays on PRs only. This
  replaces the rule that skipped an issue whose last run ran Claude and opened no PR until the issue
  was edited (`claude_ran`, #582): a run that opens no PR can't loop, since its issue leaves
  `factory:ready`. Pattern: a state machine kept in labels, with one transition function shared by
  both workflows, and drift repaired by a reconcile, as a controller reconciles desired with
  observed state. Alternatives considered: deriving the state from runs and PRs on every sweep with
  no labels (stateless like the fix-round guard, but invisible on the issue and the board, which is
  the point of the labels); writing each label inline in each job (four copies of the
  one-label-at-a-time rule to drift apart); `GITHUB_TOKEN` with `issues: write` (a second writing
  identity, which "The factory App's permissions" rules out).
- **The reconcile (#619)**, in `factory-sweep.mjs` before any choice, from what the gather read
  (every issue under each `factory:*` label, open or closed, the newest 100 factory runs, the open
  PRs, and the newest 100 closed PRs by `sunny-factory[bot]`): a closed issue loses every
  `factory:*` label; an issue with several keeps the most advanced (`failed` over `review` over
  `working` over `ready`); `factory:working` with no live run (`factory #<n>`, or a fix round on its
  `<n>-` PR) goes to `factory:review` when an open `<n>-` PR exists, else to `factory:failed` ("run
  vanished"); `factory:review` with no open `<n>-` PR goes to `factory:failed` ("PR #x closed
  unmerged") when its newest closed one there closed unmerged; with none found it is left alone,
  since a merged PR past the newest 100 isn't read. The choice reads the labels as reconciled; the
  moves are written by the same `labels` job. A move into `factory:failed` comments its reason, as a
  run's does. Each move is one `LABELS #<n> <from> -> <to> (<why>)` line in `select`'s log and the
  job summary, and one `LABEL #<n>: …` line where it is written.
- **Order:** Priority (P0 first, unset last), then board order, read as the order the REST items
  list returns; an issue not on the board comes last, by number. `/today`'s agreed order isn't wired
  to the sweep yet: the sweep has no input for it, and the admin steers by Priority, by which issues
  carry `factory:ready` and by their blockers.
- **The chaining limit:** `workflow_run` doesn't chain more than three levels of workflows. Whether
  a `workflow_dispatch` between the sweep and the factory resets that count is **unproven**: not
  tested here, and the docs say nothing on it. A factory run that the sweep's `GITHUB_TOKEN`
  dispatched fired no `workflow_run` on the first night (run 45075597193 finished at 22:05 UTC, 22
  Nov, and no sweep followed; #582), as GitHub's rule that events made with the `GITHUB_TOKEN` start
  no new runs, `workflow_dispatch` and `repository_dispatch` excepted, reads. So the hourly schedule
  is the loop, at worst one issue an hour, until a dispatch with another token.
- **Logs:** one `SWEEP` line and a job summary per run: the switch, the open factory PRs against the
  cap, the eligible issues in order, the skipped ones and why, and the one dispatched or why none.

**Fix rounds (#588; admin, 22 Nov 2026).** Step 4 of the review flow ("the factory fixes them and
pushes", above), built: when `sunny-reviewer[bot]` sends a factory PR back, the sweep dispatches the
factory on that PR, which fixes only the Required findings on the same branch, so the factory can
fix its own PRs overnight while the coordinator's laptop is off. Pattern: the same guard pipeline
and model/writer split as an issue run, in a second mode of the same workflow (inputs `pr` and
`head` instead of `issue`), and a stateless loop guard derived from the factory's own run titles.
Alternatives considered: a separate `factory-fix.yml` (a second copy of the switch, environments,
bubblewrap and caps, which would drift apart from the first); a label or a comment on the PR as the
round counter (state anyone with write access can edit, and one more write per round); fixing in the
reviewer's own job (it would run Claude next to the reviewer App's key, which "Which environment
holds which secret" rules out).

- **What the sweep picks:** after the kill switch, the cap's parse and the serial rule, and before
  the open-PR cap and any new issue (a fix round adds no PR), the open PR with the lowest number
  that the factory made: opened by `sunny-factory[bot]` with every commit authored and committed by
  its bot user. Lanes open their PRs as `sunny-factory[bot]` too ("Lanes open PRs as sunny-factory",
  below) but commit as themselves, so a lane PR is never picked. Its newest review from
  `sunny-reviewer[bot]` that gives a verdict (not dismissed, not pending, not one of the
  empty-bodied reviews that carry its line comments) must be on the PR's current head and be Request
  changes or start "merge after fixes". `factory-review.mjs` holds those rules for the sweep and the
  fix gate both.
- **The loop guard:** at most **2** fix rounds per PR, and never two on one head. A fix run's
  `run-name` is `factory fix #<pr> at <head SHA>`, so the sweep counts a PR's rounds from the
  factory runs it already reads: every such run counts, whatever it did, a run that pushed nothing
  or failed included. A PR over the limit, or with a run at its head, is skipped, and the `SWEEP`
  line and the summary say why. The sweep reads the newest 100 factory runs, so a round older than
  that falls out of the count. After 2 rounds the reviewer's own "Not converging" row (3 Request
  changes) is one review away.
- **Fix mode in `factory.yml`:** `gate` runs `factory-fix-gate.mjs` (through `factory-gather.sh`),
  which refuses unless the PR is open, the factory made it (the rule above), its branch is
  `<n>-<slug>` in this repo, its head is still `head`, and the newest verdict on that head asks for
  fixes and lists at least one Required finding; the issue is the branch's number. `factory` makes
  the PR's branch at `head` and hands Claude only the Required findings and the PR's body, with
  `.github/factory-prompt.md`'s "Fix mode": fix those findings and nothing else, commit on top,
  never rewrite history. Same environment, read-only `GITHUB_TOKEN`, tools, `--max-turns` and
  timeouts as an issue run.
- **Labels and the body are publish's:** a finding like "`review:admin` is missing" or a wrong
  Review line isn't applied by Claude, which holds no write token. Claude writes the labels to add,
  a whole new body and an `escalated:` comment into the hand-off; `factory-publish.sh` (with
  `FIX_BRANCH`) checks them (labels only `review:admin` and `area:*`, added, never removed; the body
  still says `Closes #<n>`; the comment one line starting `escalated: `) and checks the new commits
  as for an issue run (identity, protected paths, at most 100), plus that they descend from the
  reviewed head. `publish` then fetches the branch and refuses if it moved since the gate, mints the
  App's token with `contents: write` and, in fix mode only, `pull-requests: write`, applies the
  labels, body and comment, and pushes the commits last with a plain push, which GitHub refuses
  unless it fast-forwards the branch: never a force-push. The push starts the next review ("An
  approved head isn't reviewed", above).

**Two environments, both `main` only (admin, 21 Nov 2026, in the coordinator session).** The Claude
job runs in `claude-seat`, which holds only `CLAUDE_CODE_OAUTH_TOKEN` and is named for the seat, not
the factory, so `review.yml` can share it (it does since #454). The App's key stays in `factory`,
which only `publish` (and `open-pr.yml`) enters, so nothing on Claude's runner can reach the key,
whatever GitHub hands a job.

**Which environment holds which secret (#454; admin, 21 Nov 2026).** One rule: no job that runs
Claude enters an environment that holds an App's private key, and the seat token lives in one
environment only. GitHub hands a job every secret of the environment it enters, so the environment,
not the step, is the boundary.

<!-- prettier-ignore -->
| Environment | Secrets (variables) | Jobs that enter it | Why |
|---|---|---|---|
| `claude-seat` | `CLAUDE_CODE_OAUTH_TOKEN` | `factory.yml` `factory`, `review.yml` `review` | The jobs that run Claude: they need the seat token and nothing else. `main` only, so no branch's own workflow can read it |
| `factory` | `FACTORY_APP_PRIVATE_KEY` (`FACTORY_APP_CLIENT_ID`) | `factory.yml` `publish`, `open-pr.yml`, `pr-draft.yml`, `check-68-factory-resolve.yml` | Plain steps that act as sunny-factory; none runs Claude. `main` only (#336) |
| `review` | `REVIEWER_APP_PRIVATE_KEY` (`REVIEWER_APP_CLIENT_ID`) | `review.yml` `post` | The one job that posts as sunny-reviewer; it never runs Claude |
| `board` | `BOARD_PROJECT_TOKEN` | `board.yml` `move`, `milestone-review.yml` `file` | The Project token (#417); no Claude, no App key. Two workflows share it since #517 (area 5, "Status automation") |

`scripts/setup/ci-claude.sh` writes the seat token to `claude-seat` only, and stops unless that
environment admits `main` alone. Until the admin deletes it after #454's merge, `review` still holds
the old copy of `CLAUDE_CODE_OAUTH_TOKEN`, which no job reads any more (the wizard warns while it is
there).

**Bubblewrap for the scrub (admin, 21 Nov 2026, option a).** The scrub runs Claude's subprocesses
under bubblewrap, and Claude Code 2.1.319 refuses to start with the scrub on and no `bwrap`
("bubblewrap is required for subprocess env scrubbing and isolation"; #107's live test, three runs).
PR #448's body read the action as setting the isolation up only with `allowed_non_write_users`; that
was wrong for this CLI, which needs bubblewrap whenever the scrub is on. At the pinned SHA that
input makes the action install bubblewrap itself (its "Install subprocess isolation dependencies"
step), turn the scrub on by default and put `/usr/bin` first on the `PATH`, among other things, none
of which the factory uses (`action.yml`, read 21 Nov 2026). So the factory job installs `bubblewrap`
and `socat` from Ubuntu's archive before the Claude step, as that action step does; the scrub stays
on, never `0`. Ubuntu 24.04's AppArmor denies unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=1`), which bwrap needs. The step first loads the
narrowest fix, an AppArmor profile that lets `/usr/bin/bwrap` alone create them
(`/usr/bin/bwrap flags=(default_allow) { userns, }`, the form of Ubuntu's per-program example in
[Restricted unprivileged user namespaces](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces),
read 21 Nov 2026), and only if `bwrap` still fails sets that sysctl to `0` for this runner, as the
action's step does. A smoke run of `bwrap` with a PID namespace follows, so a broken install fails
the job before Claude starts, and `RESULT bwrap=ok via=…` records which fix was needed. The runner
user has sudo either way, so the sysctl takes no boundary away from Claude's runner.
`sandbox.bwrapPath` in managed settings isn't needed: `apt-get` puts `bwrap` on the `PATH`.

**What the scrub's sandbox protects, and the dependency broker (#635; admin, 23 Nov 2026).** The
scrub runs each of Claude's Bash commands in bubblewrap with a filesystem policy built into Claude
Code (2.1.325 in the factory; read from 2.1.332's bundle, 26 Nov 2026): writable under `/home`,
`/root`, `/tmp`, `/var`, `/opt`, `/run` and `/mnt`, but read-only over these paths of the launch
folder (the checkout): `package.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`,
`bunfig.toml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.gitmodules`, the `.env` files,
`node_modules/.bin`, `scripts/`, `.claude/`, `.github/`, `.git/hooks`, `.git/config`,
`.git/modules`, `.git/worktrees`, `.git/info/exclude` and `.git/commondir`; and over the shell rc
files, `.ssh`, `.netrc`, git, gh and package-manager config in home, the runner's own folders and
the action's. These are added to whatever `sandbox.filesystem` says, and a project setting can't
widen the sandbox, so no setting gives the run `pnpm-lock.yaml`. Run 45249182872 (#594) stopped on
exactly that. The admin decided a run may write `node_modules` and `pnpm-lock.yaml` and nothing else
newly; `minimumReleaseAge` holds, install and build scripts stay off, and the PR is held
(`package.json` and the lockfile are code-owned). So the factory job starts
`.github/scripts/factory-deps.sh serve` before the Claude step, outside Claude's sandbox: Claude
asks it for `add <dir> [--dev] <name@x.y.z>…`, and it checks the request (a workspace package, exact
versions, `pnpm-workspace.yaml`, the root `package.json` and `.npmrc` unchanged since it started),
then runs `pnpm add --save-exact --ignore-scripts --ignore-pnpmfile` in a bubblewrap of its own:
everything read-only, then the checkout and the pnpm store writable, then `.git`, `.github`,
`.claude`, `scripts`, `pnpm-workspace.yaml` and the protected files above read-only again (an empty
read-only file where one is missing), with no environment carried in and its own `/tmp` and PID
namespace. Its answers go to `/srv/factory-deps`, outside every folder Claude's sandbox can write,
so it never writes through a link Claude planted. Against the sandbox Claude already has, the new
writes are `pnpm-lock.yaml` and `node_modules/.bin`; `.git/hooks`, `.git/config` and the rest stay
read-only. Alternatives considered: `sandbox.excludedCommands` for `pnpm add` (it would run with
none of the scrub's protections, and whether the scrub honours it isn't documented); managed
settings (`allowWriteWithinDeny` lifts a folder inside a denied one, not a denied file); launching
Claude from another folder (it moves every protection with it); `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0`
(ruled out above). The broker's pnpm is the runner's, which Claude's sandbox can reach in `/opt` and
home; a pnpm changed there would still run inside the broker's bubblewrap, and its lockfile reaches
`main` only through the held PR.

**Residual risk.** The setup-token is in the Claude step: the scrub keeps it out of Bash's
environment, but the runner user has sudo, so a prompt injection could still read it from the
action's own process. It reaches Claude's model calls only, and rotates with `claude setup-token`.
Claude's Bash also has open network access, so whatever it can read can leave the runner. No write
token exists on the model's runner: what the model wrote reaches GitHub only through the publish
checks, and the App can't push workflows, approve, merge or bypass a ruleset.

Alternatives considered: everything in one job with `if:` on each step (every refusal would start
the 60-minute job; and a write step after Claude on the same runner is reachable from anything
Claude left running, with sudo); handing the work over as an artifact (`actions/upload-artifact` is
a new action, which the admin ruled out; a job output carries a small bundle); reading the board (no
Actions token can, #102).

**Until the factory App runs, every session acts as `sssoto17`.** Elsewhere in this ADR, "until #37"
means until then: the build issues under #58, after the checks #101–#103. Cloud and local sessions
alike, factory or not, use the admin's account, so they hold the admin's "For pull requests only"
bypass too. **The interim rule (decided 8 Nov): no unattended factory runs until the App runs.**
`factory:ready` issues are worked from attended sessions, and no interim guard is built.

- **Admin-review PRs are then held by instructions only.** GitHub doesn't let an author approve
  their own PR, so an admin-review PR the factory opened merges only by bypass, and any session can
  use that bypass. An agent could merge its own change to `tests/acceptance/`, `.claude/` or the
  dependencies. GitHub can't tell that merge from the admin's.
- **Still better than today.** With the rulesets on, a direct push, a force-push and a merge with a
  red check are all blocked. The hole left is a deliberate bypass merge. Auto-merge doesn't use the
  bypass list, so an admin-review PR with auto-merge on waits for an approval and never merges by
  itself. A public reproduction shows this: a Repository admin in the bypass list turned on
  auto-merge, and the PR stayed at "Review required" until approved, while a direct merge went
  through ([community discussion #208718](https://github.com/orgs/community/discussions/208718), 24
  Sep 2026, read 7 Nov). Not stated in GitHub's docs.
- **The reviewer bot works unchanged:** it's a separate identity from the author, so its approval
  counts (area 2). Only the admin's own approval is blocked, on sensitive and escalated PRs.
- `guard / protected-paths` can't tell an agent from the admin by author, so it reads the
  `Co-Authored-By: Claude` / `Claude-Session:` trailers that agents add by instruction. With the
  App, it checks the author. (Amended 19 Nov: the App opens agent PRs, so the check, built as
  `guard / acceptance`, reads only the PR's author: a `[bot]` author fails it, and trailers aren't
  read, because they would also catch the admin's own commissioned runs;
  [ADR-0007](0007-apps-web-and-game-api.md), section 6.)

**No merge guard for unattended sessions (decided 8 Nov).** On 7 Nov the admin allowed one only
"once #37 shows how to detect them", and map #59 kept it open in case the factory got no App of its
own. It has one, and GitHub enforces the limits on it:

<!-- prettier-ignore -->
| What a session on the admin's account can do | What stops the factory App |
|---|---|
| Bypass-merge an admin-review PR | It's on no bypass list. Code-owner review and the 1 required approval hold the merge |
| Clear an escalation | It can resolve the escalation thread on any PR. The reviewer never approves an escalated PR an App opened (only one the admin's account opened, #264), and on its next run it unresolves a thread the admin didn't resolve. But resolving starts no workflow, so on an escalated PR the admin's account opened, which the reviewer approved with auto-merge on, a thread the App resolves lets the PR merge before any re-check (the admin's rule of 16 Nov, #322; "The honest limit", below) |
| Push a `v*` tag | The tag ruleset restricts creation, and only the Repository admin role bypasses it (A8). An App installation doesn't hold that role |
| Edit a ruleset | That needs the Administration permission, which the factory App doesn't get |

No unattended runs happen before the App (the interim rule above), and attended sessions are never
guarded. So no hook is built. Two open facts from #60 were only needed for a guard, and they are
dropped: whether the cloud proxy replaces a `GH_TOKEN` set in a cloud session, and how a hook tells
a routine from an attended cloud session. A third answer stays useful: the cloud GitHub proxy
refuses tag pushes, so no cloud session can push a `v*` tag at all (#60).

**The honest limit.** Any session on the admin's account _is_ the admin on GitHub: same account,
same rights. That includes attended local and cloud sessions after #37, which still act as
`sssoto17`. For those sessions, four things stay held by instructions, the permission rules and the
classifier, never by GitHub:

- bypass-merging an admin-review PR;
- resolving an escalation thread, whose `resolvedBy` is then the admin's (and, until #104 retires
  it, removing `review:admin`); the resolve-thread hook and `deny` rule back the instruction (#264);
- pushing a `v*` tag from a local session, which ships to production (area 4);
- editing a ruleset.

One gap holds for the factory App as well, by the admin's rule of 16 Nov (#264, #322): on an
escalated PR the admin's account opened, the reviewer approves and turns on auto-merge while the
escalation thread holds the merge. Any account with write access, the factory App included, can
resolve that thread, and resolving starts no workflow, so the PR merges at once, before the reviewer
can reopen a thread the admin didn't resolve. Only instructions (agents never resolve review
threads) and the resolve-thread hook stand in the way.

**#495 (22 Nov 2026), once #565 and #566 land:** this gap and the "Clear an escalation" row above
close, since resolving a thread opens nothing and the escalation is cleared only by the admin's
`User` account removing `review:admin`, which the guard checks. Removing the label replaces
resolving the thread in the list of four; the permission rules deny it rather than ask ("Solo-admin
approvals", decision 5).

PR #52 makes Claude Code ask before tag pushes and before `--remove-label review:admin` (permission
rules, commit `523f745`), so two of the four become a prompt the admin sees. The factory is outside
this limit: its PRs come from the App, so the admin can approve them and no longer needs the bypass
for them. The rulesets still stop the mechanical mistakes: a direct push, a force-push, a merge with
a red check.

**MUST-15.1** ("CODEOWNERS entry and a ruleset on `main` requiring code-owner review") is met in
mechanism once A3 and the `main` ruleset are in place. Until #37, the admin's approval on a factory
PR is a bypass merge, held by instructions. `spec.md` gets a note saying so (Consequences).

**Alternatives considered.**

- **Classic branch protection.** Rejected: one rule per branch pattern, no tag targets, and rulesets
  replace it in GitHub's docs.
- **Bypass mode "Always" for the admin.** Rejected: it would let any session (same account) push
  straight to `main`, which is what happened 15 times so far.
- **No protection, rely on discipline.** Rejected: the factory removes the admin from the loop until
  merge, and a mistake that happens twice must become a check (AGENTS.md).
- **The admin approves every PR** (this ADR's first draft). Rejected by the admin: the admin becomes
  the factory's bottleneck.
- **Two tiers: the admin's paths, and auto-merge for everything else.** Rejected by the admin: too
  much would merge with no review at all.
- **Three tiers, with the agent's verdict as a required check** (this ADR's second draft: a
  `review / agent` check, a `guard / tier` check sorting PRs, and a no-review lane for small docs
  and CSS changes). Replaced by the admin: it removed the approval step. A real approval and Request
  changes are native, read like a conversation between teammates, and need neither custom check.
- **Copilot code review as the approving bot.** "Copilot approvals" is documented to count toward
  required approvals, but it needs a Copilot plan, spends AI credits and Actions minutes, and gives
  less control over what it checks. The admin chose an own App running the repo's skills.
- **`github-actions[bot]` as the approving bot** (`GITHUB_TOKEN`, with "Allow GitHub Actions to
  create and approve pull requests" on). No App to register, but then any workflow could approve,
  which GitHub's docs flag as a risk.
- **A reviewer machine user.** Native approvals, but it uses up the one free machine account the
  terms allow and needs a long-lived token. An App does the same without either.
- **A catch-all `* @sssoto17` in CODEOWNERS** (the Marketplace research). Superseded: it sends every
  PR to the admin.
- **A machine user for the factory** (the first draft's option a). The terms allow one, but a cloud
  session swaps its token for the owner's (#37), so an App from Actions does the same job without a
  second account
  ([Terms of Service, B. Account Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#b-account-terms),
  checked 7 Nov).

### Lanes open PRs as sunny-factory (#336)

**Decided by the admin, 16 Nov 2026** (#336, "Decided"). Until #336 every lane, cloud or local,
opened its PRs with the admin's account. So the admin couldn't approve them (GitHub refuses an
author's approval), code-owner review showed no gate of its own ("Stacks", above), and no check
could tell the admin's approval from an agent's. Auto-merge (#68) needs the admin to be a real
reviewer, so the PR's **author** is now the App. #107, the unattended factory in Actions, is
separate: this is only the identity step for lanes in Claude Code.

- **Lanes push as before, then ask.** The branch is pushed with the session's credentials (the
  admin's: the cloud GitHub proxy swaps git credentials for the owner's, #37). Then
  `scripts/open-pr.sh` sends `repository_dispatch` with event type `open-pr` and five
  `client_payload` properties (branch, base, title, body, labels; GitHub allows 10 and under 64 KB),
  waits for the run named `open-pr <branch>`, and prints the PR's number. A failed run answers with
  its link. `scripts/stack.sh` opens every part through it.
- **The workflow** (`.github/workflows/open-pr.yml`) always runs `main`'s copy, as
  `repository_dispatch` does. Its job has `permissions: {}` and environment `factory`, whose only
  deployment branch is `main`. It mints the App's token with `contents: read` and
  `pull_requests: write` only, checks out `main`'s `.github/scripts`, and
  `.github/scripts/open-pr.sh` opens the PR over REST, adds the labels that already exist, and links
  a stack part into the stack of the part below. The PR opens as a draft, and the run marks it ready
  after the link (#358, "Stacks", above), with the App's token, so its ready mark starts CI and the
  review as any App's events do ("The factory's identity", above). The sixth payload property,
  `ready: "false"`, leaves it a draft: `scripts/stack.sh` sends it for part 1, which it marks ready
  through `pr-draft` once the stack is linked.
- **The key never enters a session.** It lives only in the secret `FACTORY_APP_PRIVATE_KEY` of
  #101's environment `factory`, which #107's `publish` job uses too (its Claude job doesn't); the
  client ID is that environment's variable `FACTORY_APP_CLIENT_ID`. `scripts/setup/factory.sh`
  checks both, and stores a new key only through stdin.
- **One environment, `main` only (admin, 17 Nov 2026).** The lanes and #107's factory share
  `factory`, and its only deployment rule is `main`: the admin removed #101's `throwaway/*` rule,
  and the setup script stops while any other rule remains. With one App, a second key in a second
  environment would add no protection, since either key acts as the same App. The risk is a workflow
  on any branch other than `main` reading the key: a branch's own copy of a workflow could print it.
  So #107's throwaway test dispatches from `main` instead of running on a `throwaway/*` branch.
  (Amended 21 Nov 2026, #107: the key still has one environment, but #107's Claude job runs in a
  second one, `claude-seat`, which holds only `CLAUDE_CODE_OAUTH_TOKEN`, so Claude's runner never
  enters the environment with the key; "The factory workflow, built (#107)", above.)
- **The payload is untrusted.** Anyone with write access can dispatch, a prompt-injected session
  included. Its fields reach the shell only through `env:`, never as `${{ }}` inside `run:` (the
  run's name uses the branch, which is display text no shell reads), and go to GitHub as values
  (`jq --arg`). Refused before any write: `main`; a name outside the lanes' (`<N>-<slug>`,
  `claude/<name>`, area 1); a branch not on origin or with an open PR; a base that isn't `main` or a
  lane branch with an open PR; a title over 256 or a body over 65,536 characters.
- **The blast radius.** A dispatch can only open a PR for a lane branch already on origin, which the
  same caller could open as the admin anyway. The token can't push (`contents: read`), isn't on any
  bypass list, and its PR still needs the approvals and checks of any PR. A leaked key would act
  with the installation's own permissions (contents, issues and pull requests write, #101), never
  administration or workflows; it can't leave Actions except through a workflow on `main`, which is
  code-owned.
- **Stacks with the App's token.** Whether `/stacks` accepts an App installation token isn't
  documented. The run tries, records `stack=<number>` or `stack=refused` in its output and summary,
  and never fails over it; `stack.sh` then links what the run left out with the lane's token, as
  before. The admin's throwaway test on 17 Nov 2026 showed that `/stacks` accepts it: the `open-pr`
  run linked #352 and #353, both opened by `sunny-factory[bot]`, as stack #354 with the App's token,
  and `stack.sh` needed no fallback
  ([#336, results](https://github.com/sssoto17/sunny-pastures/issues/336#issuecomment-6934736098)).
  The fallback stays in case a later GitHub change refuses the App's token.
- **Drafts and ready through a second dispatch, `pr-draft`** (#358; "Stacks", above). The REST
  update endpoint has no draft field, and the switch needs GraphQL's `convertPullRequestToDraft` and
  `markPullRequestReadyForReview`, which the cloud proxy refuses.
  `scripts/pr-draft.sh draft|ready <pr>...` sends event type `pr-draft` with two properties, `state`
  (`draft` or `ready`) and `prs` (the PR numbers, comma-separated), leaving out PRs already in that
  state. It waits until `GET pulls/<n>` shows each one switched, and fails with the run's link on a
  failed run or after `PR_DRAFT_TIMEOUT` (120 s). `.github/workflows/pr-draft.yml` is modelled on
  `open-pr.yml`: `main`'s copy, environment `factory`, `GITHUB_TOKEN` with `contents: read` for the
  checkout only, and the App's token with `pull_requests: write` alone. That token marks ready,
  never `GITHUB_TOKEN`, whose events start no workflows. `.github/scripts/pr-draft.sh` checks the
  payload and every PR before any write: the state is `draft` or `ready`, `prs` holds 1 to 20
  numbers, and each PR is open, from this repository, with a lane branch as its head. The node id
  goes to GraphQL as a variable. The blast radius: a caller can switch an open lane PR between draft
  and ready, as it could in the UI, and a draft only holds a merge.

**What changes.** The admin approves lane PRs instead of bypass-merging them: a code-owned PR, a
code-owned part of a stack (so such a stack can merge as one), and an escalated PR, on which the
reviewer withholds its approval when an App opened it ("Approvals", above), so the admin's Approve
and the resolved thread both hold it. (**#495, 22 Nov 2026, once #565 and #566 land:** the reviewer
approves it too, and the admin removes `review:admin` instead of approving.) GitHub doesn't count an
App's PR as "unattributed" (`require_extra_approval_for_unattributed_changes`, A8): on the 17 Nov
2026 throwaway test, the admin's Approve on #350 (local) and #351 (cloud), both opened by
`sunny-factory[bot]`, turned `reviewDecision` to `APPROVED` with no second approval asked
([#336, results](https://github.com/sssoto17/sunny-pastures/issues/336#issuecomment-6934736098)).

**`require_last_push_approval` stays off.** The PR's author is the App, but its commits are still
pushed by the admin's account. The rule wants an approval "from someone other than the last pusher",
so with it on the admin's Approve on a lane PR wouldn't count, and a code-owned PR would again merge
only by bypass, undoing what #336 is for. It stays off while lanes push as the admin's account, and
turns on once pushes come from an App (#107); #68's ruleset criterion says so. Until then Q14's
concern, the reviewer approving a push it made itself, rests on `post-review.sh`, which only reviews
and never pushes.

**Alternatives considered.**

- **Lanes push as the App too.** Not possible through the cloud GitHub proxy, which swaps every git
  credential for the owner's (#37, #60). A local lane could push with a minted token, but then a
  token, or the key that mints it, would sit in the session.
- **`workflow_dispatch` instead of `repository_dispatch`.** It needs `actions: write`, which the
  cloud session's token is refused; `POST /dispatches` needs `contents: write`, which lanes have
  (#336's research, 16 Nov).
- **The key in the cloud environment**, minting the token in the session. Cloud environment
  variables are readable by every command the model runs (Claude Code's cloud-environment docs), so
  one prompt injection could carry the key off, and with it the App, for good.
- **A second environment and key for the lanes** (this PR's first draft). Rejected by the admin (17
  Nov 2026): one App means one identity whichever key mints its token, so a second key protects
  nothing, and two environments are two branch rules to keep right.
- **Keep opening PRs as the admin's account** (the status quo). Every admin-review PR stays a bypass
  merge that any session could make ("The honest limit", above), and auto-merge (#68) can't rest on
  a real admin approval.

### Commissioned work as the admin (#385)

**Decided 19 Nov 2026** (#333, section 5; ADR-0007, "Acceptance tests"). Admin-owned paths, first
`tests/acceptance/**`, must never come from `sunny-factory[bot]`: `guard / acceptance` (#384) fails
a `[bot]`-authored PR that touches them. A lane the admin deliberately starts for such work opens
its PR as the admin instead.

- **Pattern: a feature toggle off by default, behind a guard clause.** The default path, the
  dispatch to the App, is unchanged; the switch branches off before it.
- **The switch.** `scripts/open-pr.sh --as-admin` (and `scripts/stack.sh open|add --as-admin`, which
  passes it on) skips the dispatch and opens the PR over REST (`POST /repos/{o}/{r}/pulls`) with the
  session's own credentials, the admin's; pushes are the admin's already (#336, above). It adds the
  labels after opening, refusing first any that don't exist, and `stack.sh` links the parts with the
  lane's token. The PR opens as a draft, and the `pr-draft` dispatch marks it ready as the App
  (#358), at once for a single PR and after the link for a stack's parts, since the session can't
  switch a draft over REST. Since no workflow runs, the script repeats the workflow's refusals
  (main, a non-lane branch or base, a base with no open PR, the length limits), and refuses an open
  PR the App already opened for the branch. Off by default: without it nothing changes.
- **The gate.** The script refuses unless `OPEN_PR_AS_ADMIN` holds an issue number and the body
  links that issue (`Closes #N` or `Part of #N`). Only the admin's launch sets it: locally
  `OPEN_PR_AS_ADMIN=<N> claude …`, in the cloud the environment's variables for that run. A brief
  only says to use the switch; it can't turn it on. Locally an `ask` rule on
  `*open-pr.sh*--as-admin*` and `*stack.sh*--as-admin*` also prompts the admin. The script appends
  to the body that a lane opened the PR as the admin for #N.
- **The honest limit.** A session on the admin's account can set any variable the admin can, and an
  `ask` rule doesn't prompt in a cloud auto-mode lane. So, like the thread-resolve hook, this is a
  standard plus a check, not a boundary; the guarantee ADR-0007 states rests on which identity runs.
- **Such a PR merges by bypass**, as every lane PR did before #336: the admin is its author and
  can't approve it.

**Alternatives considered.** A boolean variable: one setting would cover every later run in the same
environment, where an issue number covers one issue. Detecting the admin's runs by commit trailer or
branch: ADR-0007 rejects it, it's easy to fake. `gh pr create`: GraphQL, which the cloud proxy
refuses, and an `ask` rule already.

## 3. Merge methods

**Current state.** All three methods are enabled. Merge commits were used for #3, #26 and #30. #13,
#14 and #19 landed as single commits with one parent (squash; #19 shows `(#19)` in its subject).
Squash commits take the PR title for single-commit PRs and the commit messages as body
(`squash_merge_commit_title: COMMIT_OR_PR_TITLE`, `squash_merge_commit_message: COMMIT_MESSAGES`).
Merge commits are titled "Merge pull request #N from …" (`merge_commit_title: MERGE_MESSAGE`).
Auto-merge is off. "Always suggest updating branches" is on.

<!-- prettier-ignore -->
| | Merge commit | Squash | Rebase |
|---|---|---|---|
| History on `main` | Every branch commit, plus a merge commit. Readable with `git log --first-parent`. | One commit per PR, titled with the PR title. | Every commit, linear, no PR boundary. |
| The spike's evidence trail | Kept: the order of commits shows a rule was fixed before data existed (ADR-0001's pre-registration). | Lost on `main`. The PR keeps its commits on GitHub. | Kept, but rewritten: new SHAs and commit dates, so the trail is weaker. |
| Revert one PR | `git revert -m 1 <merge>` | `git revert <sha>` | Revert each commit, and find them first. |
| Agent WIP commits | All land on `main`. | Collapsed. | All land. |
| Fits the skill | Keeps atomic commits (skill, *Atomic Commits*). | The skill warns that squashing "destroys the development narrative". | Keeps atomic commits. |

**Recommendation: adopt now. Allow squash and merge commits; disable rebase. Squash is the
default.**

- **Squash for issue PRs** (almost all of them). One issue is one logical change of about 100–300
  lines, which is the skill's own size for a commit (skill, _Size Your Changes_). Agents commit save
  points as they work (skill, _The Save Point Pattern_), and those save points don't belong on
  `main` one by one. The PR keeps them on GitHub. The PR title becomes the commit
  (`triage-labels.md`), and per-PR revert is one command. This is where the proposal departs from
  the skill's "prefer clean incremental commits": the narrative stays in the PR and the issue,
  linked from the squash commit by `(#N)`.
- **Merge commits for evidence PRs**: a spike's results, an ADR whose decision rule was fixed before
  its data, or any PR whose commit order is itself the evidence. The PR body says "merge commit" and
  why.
- **Rebase merge: disabled.** It rewrites SHAs and dates, which weakens the evidence trail, and it
  loses the PR boundary for reverts.
- **Commit titles:** set both squash and merge commits to use the **PR title** and the **PR body**
  (`squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`,
  `merge_commit_title=PR_TITLE`, `merge_commit_message=PR_BODY`). Then
  `git log --first-parent --oneline main` reads as one Conventional Commit per PR, whichever method
  was used, and the PR body's `Closes #N`, verification and Changelog line land in git.
- **Linear history** is not required, because of the merge-commit exception. `--first-parent` is the
  readable view.
- **Auto-merge: turn on at repo level only when the required checks report, the reviewer App passes
  tests (a)–(f) (checklist step 12) and #47's escalation criteria are merged (Q16), not before.** On
  a private repo it needs Pro, which the account has
  ([auto-merge](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)).
  Bot-approved PRs merge this way (area 2). Without required checks, an approved PR would merge
  before CI had run.
  - **Who turns it on: the reviewer App, when it approves.** Turning on auto-merge is GraphQL-only
    (`enablePullRequestAutoMerge`; the REST description has no endpoint for it, checked 7 Nov).
    GraphQL is closed in cloud sessions (#37), but not in Actions, where the App runs. The method is
    the one the PR template's "Merge method" line names: squash by default, a merge commit for
    evidence PRs.
  - **Sensitive and escalated PRs:** the admin approves, then merges or turns on auto-merge, keeping
    the choice of method. While the factory acts as the admin (until #37), the admin can't approve
    its PRs and merges them by bypass.
  - Auto-merge ignores the bypass list (area 2), so it never merges a PR that still lacks the
    admin's approval.
- **Merge queue: not available.** It exists only for organization-owned repos (public, or private on
  Enterprise Cloud)
  ([merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
  This repo belongs to a user.
- **Update branch: keep on** (merge-based). It's how an agent or the admin brings a stale PR up to
  date without force-pushing. Each update dismisses the bot's approval and costs a new review (area
  2).

**Alternatives considered.**

- **Squash only, with linear history.** Simplest, and enforceable. Rejected because the next spike
  (or a playtest analysis) would lose its evidence trail on `main`.
- **Merge commits only.** Keeps everything, but every agent save point lands on `main`, and the
  first-parent subjects are "Merge pull request…" unless the title setting changes.
- **Rebase only.** Rejected above.

## 4. Environments

**Current state.** No environments, no secrets and no variables (checked 7 Nov:
`GET …/environments`, `…/actions/secrets`, `…/dependabot/secrets` and `…/actions/variables` each
return a count of 0). No workflows exist (`list_workflows` returns 0), so nothing deploys from
Actions. Vercel isn't connected yet: the repo has no deployments and no webhooks, and no PR has a
commit status or check run (checked 7 Nov on #19, #26, #30 and #35). Vercel and the hosted Supabase
projects don't exist yet (`docs/requirements/spec.md`, MUST-17).

**What GitHub offers on this plan.** Environments, environment secrets and deployment branches in a
private repo need Pro, Team or Enterprise. On Free, Pro and Team, required reviewers and wait timers
work **only in public repos**
([managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments);
gating text in `github/docs` `data/reusables/gated-features/environments.md`).

**Vercel covers most of MUST-17 by itself.** Its Git integration deploys every push, including
pushes to PR branches, as a preview, and deploys the production branch (usually `main`) to
production. It keeps its own environment variables per environment (Production, Preview,
Development), and a Preview variable can be limited to one branch
([Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github),
[environment variables](https://vercel.com/docs/environment-variables), checked 7 Nov). So:

- **MUST-17.3** (each PR gets a preview on the staging Supabase project) stays a Vercel setting:
  preview variables point at staging.
- Vercel reports back to GitHub without any GitHub-side setup. It uses GitHub's Deployments API, so
  its preview deployments show in GitHub. By default each deployed commit also gets a commit status,
  and each PR gets a comment with its preview URL
  ([Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github), checked 7 Nov). The docs
  don't give the names of the GitHub environments those deployments use. Check them once Vercel is
  connected (Q10).

### Only a release tag ships to production (decided 7 Nov)

The admin's decision: once production is live, **a merge to `main` no longer deploys to production.
Only a `v*` release tag does, and GitHub Actions deploys it.** Bot-approved PRs auto-merge (area 2),
so with deploy-on-merge, playtesters could get a change no human had looked at. With deploy-on-tag,
the admin's look at staging before tagging is the gate to production. MUST-17.2 changes to match, in
a later PR (Consequences).

<!-- prettier-ignore -->
| Where | Deployed by | Data |
|---|---|---|
| Each PR | Vercel's Git integration, as a preview (MUST-17.3) | staging Supabase |
| `main` | Vercel's Git integration, as a preview branch with its own fixed staging domain | staging Supabase |
| A `v*` tag on `main` | The `deploy` workflow in Actions | production Supabase |

- **`main` becomes staging.** Vercel lets a branch be a "preview phase" with its own domain and its
  own variables ([Git deployments, "Multiple preview phases"](https://vercel.com/docs/git), checked
  7 Nov). For `main` to deploy as a preview, Vercel's production branch must be another branch:
  `production`, which nobody pushes (a ruleset blocks it, A8), with
  `"git": { "deploymentEnabled": { "production": false } }` in `vercel.json` as a backstop. That
  option takes branch names and turns off Vercel's deployments for them
  ([Git configuration](https://vercel.com/docs/project-configuration/git-configuration), checked 7
  Nov). _Not verified:_ that Vercel accepts a production branch that never receives a push. Check
  when Vercel is connected (Q10). If it doesn't, set `deploymentEnabled` to false for `main` and
  have Actions deploy staging too, on `push` to `main`. Auto-merge is turned on by the reviewer App,
  not by `GITHUB_TOKEN`, so its merges should start that workflow; check it with the first
  auto-merged PR.
- **Production deploys from a tag, in Actions.** The `deploy` workflow runs on `push` of tags `v*`,
  in the GitHub environment `production`, whose deployment policy admits only tags matching `v*`
  (the REST API takes `"type": "tag"` in a deployment policy, checked 7 Nov). It:
  1. checks out the tag, and fails unless the tagged commit is on `main`;
  2. runs the production migrations (the tool is settled at M3), so the schema ships with its code;
  3. runs `vercel pull --environment=production`, `vercel build --prod` and
     `vercel deploy --prebuilt --prod`, Vercel's documented pattern for Actions
     ([Using GitHub Actions with Vercel](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel),
     checked 7 Nov).
- **Who can ship.** Only the admin creates `v*` tags (the tag ruleset, area 2). Until #37, every
  session acts as the admin, so that holds by instructions only (area 2, "The honest limit"; PR #52
  asks before tag pushes). No guard for unattended sessions is built (#37): the factory App can't
  create a `v*` tag, because only the Repository admin role bypasses the tag ruleset (area 2, "The
  factory's identity"), and the cloud GitHub proxy refuses tag pushes (#60).
- **Rollback** is Vercel's Instant Rollback in the dashboard. A fix ships as a patch tag (`v0.5.1`,
  area 1).

**Recommendation.**

- **GitHub environment `production`: adopt at M4**, before the first tag deploys (checklist).
  Deployment policy: tags `v*` only. It holds `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
  and the production Supabase credentials. Vercel's guide stores them as repository secrets;
  environment secrets are stricter (below).
- **No `staging` GitHub environment** while Vercel deploys staging and holds its variables. Adopt
  one only if Actions runs staging migrations or deploys (the fallback above).
- **Required reviewers and wait timers** aren't available on a private repo on Pro (above). When the
  repo goes public (#38), add the admin as required reviewer on `production`, with "prevent
  self-review" off, since the admin pushes the tag that starts the deploy.
- **Environment secrets, not repo secrets, for anything that can reach production.** A repo secret
  is readable by any workflow run in the repo, including a run on an agent's PR branch, whose
  workflow file the PR itself can change. An environment secret is handed only to a job that names
  the environment, and the deployment policy limits `production` to `v*` tags
  ([deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
- **CI needs no secrets for MUST-17.1.** The acceptance tests run on a throwaway Supabase stack
  inside the runner.
- **Secrets are set without echoing them.** `gh secret set NAME --env production` prompts for the
  value without showing it. Never pass a value on the command line or print it (AGENTS.md).
  `.env.example` lists every name with a placeholder (MUST-17.4).

**Alternatives considered.**

- **Every merge to `main` deploys production** (MUST-17.2 as written, and this ADR's first draft,
  through Vercel's Git integration). Rejected by the admin: with bot-approved PRs auto-merging,
  nothing would stand between an agent-reviewed change and the players.
- **A `production` branch that Vercel deploys, moved to each tag by the admin.** No token in GitHub,
  but migrations would need their own trigger on that branch, and the order (migrate, then deploy)
  would rest on two systems. The admin chose Actions for control over that order.
- **A staged production build, promoted by hand.** Vercel builds `main` as production without
  serving it, and the admin promotes it
  ([promoting deployments](https://vercel.com/docs/deployments/promoting-a-deployment), checked 7
  Nov). Rejected: a staged build runs with production variables, so it can only be checked against
  production data, and migrations run before anyone has looked.
- **A `preview` GitHub Environment.** Skipped: Vercel's Preview scope is the preview environment.

## 5. The Project board and status automation

**Current state.** The Project (user project 3) has the fields in `issue-tracker.md`: Status, Track,
Mode, Size, Priority, Week. A new Project starts with "Item closed → Done" and "Pull request merged
→ Done" turned on
([built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)).
Read through GraphQL on 7 Nov
(`viewer.projectV2(number: 3) { workflows { name enabled } views { name layout filter … } }`):

- **All 8 workflows the API lists are on:** Auto-add sub-issues to project, Auto-add to project,
  Auto-archive items, Auto-close issue, Item added to project, Item closed, Pull request linked to
  issue, Pull request merged. The API doesn't expose a workflow's filter or the Status it sets.
- **Auto-add also adds PRs today.** All 12 closed and 8 open issues are on the Project, and so are 9
  PRs. Eight of them (#23, #24, #25, #26, #27, #29, #30, #35) became items in the same minute they
  were opened.
- **No item is archived yet**, although Auto-archive is on.
- Views: see "Views" below.

### Built-in workflows

The workflow names below are the ones the API returns for this Project (checked 7 Nov). The docs
page doesn't name the workflows. Two rows (Item reopened, Code changes requested / Code review
approved) are names the API didn't return. If the Workflows page doesn't offer them, skip those rows
_(not re-checked in the UI)_.

**Applied 8 Nov, #66 (checklist step 5):** as the table below. The UI offers all three rows the API
doesn't list. "Item reopened" is on and sets Backlog; "Code changes requested" and "Code review
approved" are off. The filters and the Status each workflow sets aren't API-readable, so the admin
confirmed them from screenshots. Auto-add's filter was first saved as `is:issue is:open`, then
corrected to `is:issue`.

<!-- prettier-ignore -->
| Workflow | Recommendation | Why |
|---|---|---|
| Auto-add to project | **On**, filter `is:issue` | On today, and it adds PRs too (above), so the filter changes. Every issue belongs on the Project (`issue-tracker.md`). Issues only: the issue is the work item, and a PR card would duplicate it. Free allows 1 auto-add workflow, Pro 5 ([adding items automatically](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)). Agents still add the item explicitly, and #32's script should treat "already on the Project" as success. |
| Item added to project | **On**, Status = Backlog | Matches "agents create issues in Backlog". On today; check in the UI that it sets Backlog. |
| Item reopened | **On**, Status = Backlog | A reopened issue isn't automatically the focus. Not in the API's list for this Project. |
| Item closed | **On**, Status = Done | `issue-tracker.md`: "In review → Done: the admin merged the PR, the issue closes, and the Project moves it." With the reviewer bot, the merge may be the admin's or auto-merge's; the move is the same. On today. |
| Pull request merged | On (harmless) | Once auto-add takes issues only, PRs aren't added, so it rarely fires. |
| Pull request linked to issue | **Off for now** (on today) | It would set In review when the PR opens, but In review means "PR open *and* checks green". Revisit with #17. |
| Code changes requested / Code review approved | Off | Every PR now gets reviews from the reviewer bot; a review is not a Status change, and In review already means "PR open and checks green" (area 2). Not in the API's list for this Project. |
| Auto-close issue (Status set to Done closes the issue) | **Off** (on today) | Done must come from a merge or an explicit close, not a drag. |
| Auto-add sub-issues to project | On (on today) | Workstream sub-issues belong on the board. |
| Auto-archive items | **Off** (on today) | Closed items are the history the report draws on. Views filter them out instead ([archiving](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/archiving-items-automatically) archives existing matches immediately). |

### Who sets each Status

<!-- prettier-ignore -->
| Move | Set by | Stays manual? |
|---|---|---|
| → Backlog | The auto-add / item-added workflows | — |
| Backlog → Ready | **The admin**, always | Yes. Ready is the admin's chosen focus (`issue-tracker.md`). No automation ever sets Ready. |
| Ready → In progress | The `board` workflow (#417), when a branch `<N>-<slug>` is created or a PR with `Closes #N` opens | No. |
| In progress → In review | The `board` workflow, when that PR is ready and its checks are green, `guard / code-owned` apart | No. |
| In review → In progress | The `board` workflow, when that PR turns red, becomes a draft or closes unmerged | No. |
| In review → Done | The built-in "Item closed" workflow, after the merge (auto-merge on the bot's approval, or the admin's merge for an admin-review PR) closes the issue | — |
| Any → Backlog | The admin, or an agent that finds the issue isn't ready (with a `blocked:*` label) | Yes. |

### Status automation (#417)

`.github/workflows/board.yml` moves Status by the rows above; the transition table is
`scripts/board-status.sh`, and the write is `scripts/issue-fields.sh --from`, a guarded move that
sets Status only when the issue is on the Project and its Status is one the move starts from. A
built-in workflow can't do these rows: "Pull request linked to issue" sets one Status for every
linked issue, Backlog included, and can't see checks or drafts.

- **Events.** `pull_request_target` (opened, reopened, edited, ready_for_review, converted_to_draft,
  closed) for the PR's own state, and `workflow_run` on the completion of each workflow that reports
  a check on a PR head, for the checks. `check_suite` can't be used: it never fires for a suite
  GitHub Actions created, which is every suite here. A new branch comes through `board-branch.yml`
  (`create`), whose finished run starts `board.yml` by `workflow_run`: a `create` run's ref is the
  new branch, which the `board` environment refuses.
- **Two jobs.** `board / decide` reads the PR, its checks and its closing references (GraphQL
  `closingIssuesReferences`, with the run's read-only token; for a PR on another base, which GitHub
  gives none, the body's closing keywords, digits of this repo only) and outputs only
  `<issue>:<kind>` pairs. A finished check run yields a move only when the checks turn green or red,
  so the token's job doesn't start on every check. It can't skip a move that would change nothing:
  reading the Status needs the token. `board / move` holds the token, in environment `board` (main
  only), sees only those pairs and checks them again. Both run main's copy and main's checkout,
  never the PR's code.
- **The token.** A classic PAT with the `project` scope alone, secret `BOARD_PROJECT_TOKEN`. A
  fine-grained PAT can't reach a user-owned Project: GitHub's "Managing your personal access tokens"
  lists "access Projects owned by a user account" under "Fine-grained personal access tokens
  limitations", and the endpoint lists the REST reference is built from (`github/docs`,
  `src/github-apps/data/fpt-2022-11-28/`, read 21 Nov 2026) give fine-grained PATs and Apps only the
  `/orgs/{org}/projectsV2` endpoints, never `/users/{username}/projectsV2`. `GITHUB_TOKEN` can't
  reach any Project ("Automating Projects using Actions"), which recommends a classic PAT for a
  user's Project. The token goes to the Project's calls only (`PROJECT_GH_TOKEN`); the job's
  `GITHUB_TOKEN` reads the issue. The repo is public, so the item's issue isn't redacted for it; if
  the repo goes private again, the token needs `repo` too.
- **A second user: the milestone's architecture review (#517; admin, 22 Nov 2026).**
  `.github/workflows/milestone-review.yml` files "Architecture review, <milestone>" on
  `milestone: created` (and on a dispatch from `main`) through `scripts/milestone-review.sh` and
  `scripts/new-issue.sh`, and sets its Project fields with the same token, in the same environment,
  passed the same way: `PROJECT_GH_TOKEN`, so `scripts/issue-fields.sh` hands it to the Project's
  calls only (reading the Week iterations, adding the item, setting its fields); `GITHUB_TOKEN`
  (`issues: write`) creates the issue, its labels, milestone, type and parent link. Sharing the PAT
  is acceptable for two reasons. It only ever reaches the Project's calls, where its `project` scope
  is all it can do anyway, so the second workflow adds no reach the first didn't have. And the
  `board` environment admits `main` alone, so only a reviewed copy of either workflow can read it; a
  `milestone` event runs from the default branch, and a dispatch from any other branch is refused at
  the environment. It is one job, not board.yml's two, because nothing in it reads text a PR wrote:
  the event's one value is the milestone's number, and only someone with write access creates a
  milestone. Rotating or revoking the token now stops both workflows. Patterns: an event-driven
  filer that is idempotent by a check-then-act guard (a milestone that already has an issue titled
  "Architecture review, …", open or closed, gets no second; not atomic, so the workflow's
  concurrency group keeps one run per milestone), reusing `new-issue.sh` for the filing rather than
  a second copy of it. Alternatives considered: the coordinator filing the review by hand each week
  or milestone (rejected: it was missed in Wk 1, 2 and 3, #290, #407); a schedule that files the
  next milestone's review (rejected: a run whether or not a milestone was made, and lag); a
  token-free job with Week left to triage every time (rejected: every review would land in Triage,
  the manual step this removes).

Patterns: a pipeline of a pure decision and a guarded command (the decide job computes, the move job
applies), and the guarded transition itself (a check-then-set on Status: move only from the listed
states; not atomic, so two close events can land out of order until the next one). Alternatives
considered: one job holding the token (rejected: it would read PR text in the job that can write the
Project); a GitHub App (rejected: an App can't call the user-owned Project's endpoints, above);
polling on a schedule (rejected: minutes of lag and a run every few minutes whether or not anything
changed); parsing `Closes #N` from the body for every PR (rejected on `main`, where GitHub's own
record, `closingIssuesReferences`, is what will close; used only for a stack part on another base,
which GitHub gives no record); `branches: [main]` on the PR event (rejected: it skipped a stack's
closing part, so a stack went from In progress straight to Done).

Mode stays in step with `factory:ready` by hand until the "Mode ↔ `factory:ready` sync" candidate in
`triage-labels.md` reaches 3 repetitions.

### Views

<!-- prettier-ignore -->
| View | Layout | Filter / grouping |
|---|---|---|
| This week (board) | Board by Status | `week:@current`; Done shows only items updated in the last 7 days |
| Roadmap | Roadmap | Group by Milestone, dates from Week |
| Week | Table | Group by Week (iteration), sort by Priority |
| Factory | Table | `mode:Factory` or `label:factory:ready`, Status ≠ Done |
| Blocked | Table | `label:blocked:*` |
| Triage | Table | `label:triage` |

**Views today** (read 7 Nov). Three of the six above already exist:

<!-- prettier-ignore -->
| View today | Layout | Filter / grouping | Matches |
|---|---|---|---|
| This week 📥 | Board, columns by Status | `week:@current`, sorted by Week then Priority | This week. The filter doesn't limit Done to the last 7 days yet. |
| Milestones 🎯 | Table | `has:milestone state:open`, grouped by Milestone | — |
| Roadmap ✈️ | Roadmap | `has:milestone is:issue is:open`, grouped by Milestone | Roadmap |
| Prioritized backlog ⚡ | Table | `state:open status:Backlog is:issue has:priority -label:triage`, grouped by Priority | — |
| Upcoming ➡️ | Board, columns by Status | `week:@next` | — |
| Triage 🔨 | Table | `label:triage` | Triage |
| Bugs 🐛 | Table | `label:bug is:open`, grouped by Priority, sorted by Size | — |

Week, Factory and Blocked don't exist yet.

**Applied 8 Nov, #66 (checklist step 6):** the admin added Week, Factory and Blocked in the UI. Two
filters differ from the table above, and one view is unchanged:

- **Factory** filters on `label:factory:ready -status:Done` only. A Project filter ORs only between
  values of the same field, so it can't OR `mode:` with `label:`. The label is the authoritative
  signal, and Mode follows it by hand.
- **Blocked** lists the three labels, `label:blocked:decision,blocked:external,blocked:admin`,
  because a `blocked:*` wildcard wasn't confirmed to work. A new `blocked:*` label has to be added
  to this view by hand (`triage-labels.md`, "Blocked").
- **This week** is unchanged (`week:@current`). A board filter can't apply to the Done column alone,
  and Week iterations are 7 days (Mon–Sun), so Done already shows only the current week's items.

### Milestones and Project fields

The milestone is the repo-native grouping (`M1` … `M9`, due dates set; M1 closed). The Project's
built-in Milestone field shows it, so it never becomes a custom field. Week is the iteration that
plans inside a milestone. Keeping them in sync is a check, not a sync job: the weekly retro (or
#32's script) lists open issues whose Week ends after their milestone's due date.

**Alternatives considered.**

- **Adding PRs to the Project too.** Rejected: two cards per change.
- **Actions for every move now.** Rejected: the 3-repetition rule, and each needs a PAT secret.
- **A Status field change** (for example a "Blocked" column). Rejected: blocked is a label, and
  changing Status options through the API wipes every item's status (`docs/agents/sandbox.md`).

## 6. Labels

**Current state.** 19 labels exist, and their names and colours match `triage-labels.md` exactly (7
`area:*`, 3 `blocked:*`, 6 types, `triage`, `factory:ready`). GitHub's default labels were removed.
No `wayfinder:*` labels exist yet, as the doc says. PR area labels are set by hand (the retro counts
2+ repetitions). With `review:admin` (area 2; checklist step 9) there will be 20.

**Labels as code: skip for now.** `triage-labels.md` is the source of truth, and the labels match it
today. A sync action would be a new dependency for 20 labels that rarely change. Adopt a
`gh label`-based script if the labels drift from the doc twice.

**Path labeler: adopt with the CI/CD step** (the retro's decision 5). The config in appendix A1 maps
paths to `area:*` exactly as `triage-labels.md` defines them. The action is `actions/labeler`,
pinned to a commit SHA:

```yaml
- uses: actions/labeler@bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13 # v7.0.0
```

Checked on 7 Nov: tag `v7.0.0` (and the moving `v7`) points at commit
`bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13`, committed on 16 Jul 2026, 114 days ago. v7 changes
nothing in inputs or behaviour from v6 ("Migrated to ESM internally"), runs on `node24`, and uses
the v5+ config format (`changed-files` with `any-glob-to-any-file`). The Release was published on 21
Jul 2026, 109 days before 7 Nov, so it passes the 7-day rule (Q6, checked 7 Nov:
`gh api repos/actions/labeler/releases/tags/v7.0.0 --jq .published_at`; `git/ref/tags/v7.0.0` and
`git/ref/tags/v7` both still point at `bf12e9b…`). The previous release, `v6.2.0`, is commit
`b8dd2d9…` (6 Jul 2026, published 9 Jul 2026).

The labeler's limits:

- `tests/acceptance/` and `prototypes/<name>/` take the area of what they test, which a path can't
  say. They get no label from the labeler; the author adds one.
- `area:db` covers "the Drizzle schema, migrations, RLS": `supabase/**` (migrations in
  `supabase/migrations/`), `apps/web/src/server/db/**`, `apps/web/src/server/store/schema.ts` and
  `apps/web/drizzle.config.json` (#372 replaced the guesses). The schema and the client sit under
  `src/server/`, so they get both `area:api` and `area:db`, which is what "one area per area
  touched" means.
- `sync-labels` stays off, so the labeler adds and never removes. A label the admin removed by hand
  comes back only if new matching files are pushed.

**Q9, decided 7 Nov:** `area:tools` widens to all dev tooling: `tools/`, `scripts/`, `.claude/` and
`.agents/`. `area:ci-cd` keeps `.github/`, deploy config and root config. This PR updates the table
in `triage-labels.md` and the labeler config (A1) to match.

The globs were checked with `minimatch` 9.0.9 (the matcher the action uses, with `dot: true`)
against sample paths, re-run on 7 Nov after Q9: a route handler
`apps/web/src/app/api/action/route.ts` gets only `area:api`, `apps/web/src/app/page.tsx` only
`area:ui`; `.claude/settings.json`, `.claude/hooks/*.sh`, `.agents/skills/*/SKILL.md`,
`scripts/*.sh` and `tools/load/*` only `area:tools`; `.github/workflows/*.yml`, `vercel.json`,
`package.json` and `skills-lock.json` only `area:ci-cd`; `supabase/db.sh` `area:db`; and
`tests/acceptance/*.ts` nothing.

**Alternatives considered.**

- **A label-sync action** (labels in a YAML file, synced on push). Deferred, as above.
- **Labeling by branch name.** Rejected: branch names carry the issue, not the area.

## 7. Templates and community files

**Current state.** None exist. The community profile reports 14% health: no README, no CONTRIBUTING,
no issue or PR template, no licence.

<!-- prettier-ignore -->
| File | Recommendation | Why |
|---|---|---|
| Issue forms per type (`.github/ISSUE_TEMPLATE/*.yml`) | **Adopt** at M2 (appendix A4) | Each form asks for a goal and "Acceptance criteria", rule 2 of the definition of ready. It sets the type label and `triage`, and since #254 the native issue type with the top-level `type:` key, by the mapping in `scripts/lib/issue-types.sh` (#266; `.github/scripts/tests/issue-forms.test.mjs` checks the two agree). Agents file through `gh issue create --body`, which bypasses forms, so the forms help the admin's web filing and show agents the expected body ([issue forms syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)). |
| `ISSUE_TEMPLATE/config.yml` | **Adopt**, blank issues **off** | Every issue needs a type. The setting affects only the web UI, not the API or `gh`. |
| PR template | **Adopt** at M2 (appendix A2) | Matches the skill's change summary (skill, *Change Summaries*: changes made, things not touched, concerns) and adds `Closes #N`, verification, protected paths, screenshots and the Changelog line (area 1). |
| CODEOWNERS | **Adopt** at M2 (appendix A3) | Defines the code-owned PRs: the `main` ruleset requires the code owner's approval on these paths (area 2, MUST-15.1). Works on a private repo on Pro. |
| SECURITY.md | **Adopt** at go-public (#38, appendix A5) | From M4 the game is public on Vercel, and players and testers need a way to report a hole that isn't a public issue. While the repo is private, nobody outside can read the file. Once public, it points to private vulnerability reporting, so no email address is needed (Q8). |
| CONTRIBUTING.md | **Skip** | `AGENTS.md` and `docs/agents/` are the contributor guide, and they're the ones agents read. A second guide would drift. |
| README.md | **Adopt now**, as a separate docs issue | No README exists; the repo page is blank for examiners. Not a `.github/` file and not protected, so it doesn't wait for the `.github/` PR. Out of scope here. |
| `.github/release.yml` | **Adopt** at M4 (appendix A6) | Groups generated release notes by area label and leaves out chores ([generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)). |
| Discussions category forms | **Skip** | Discussions stay off (area 9). |
| Saved replies | **Skip** | They're per user account, not per repo, and solo review replies are rare ([saved replies](https://docs.github.com/en/get-started/writing-on-github/working-with-saved-replies/about-saved-replies)). |
| LICENSE | **At go-public (#38), Q7** | Chosen when the repo goes public, after checking EK's rules on student work. With none, all rights are reserved. |
| CODE_OF_CONDUCT.md, FUNDING.yml | Skip | No community and no funding. |
| `CITATION.cff` | Skip; reconsider at M8 | Only if the report wants the repo cited in a standard form. |
| Issue types | **Adopt** (superseded the Skip of 7 Nov) | Was skipped on 7 Nov as an organization feature: the docs describe issue types only per organization ([managing issue types](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-types-in-an-organization)), and GraphQL then returned `issueTypes: null` for this repo. Since then the repo offers its own types (`gh api repos/sssoto17/sunny-pastures/issue-types`: Chore, Bug, Feature, Design), #158 made one required on every issue, #266 set the label → type mapping, and #254 has the issue forms set it. The type label stays (`docs/agents/triage-labels.md`, Types). |
| Autolinks | Skip | Nothing external to link to (and Pro-only on private repos). |

## 8. Security and dependencies

**Current state.** Code scanning is off (`GET …/code-scanning/default-setup`: "not enabled").
Private vulnerability reporting returns 404. Checked 7 Nov: Dependabot alerts are off
(`GET …/vulnerability-alerts` returns 404), Dependabot security updates are off
(`…/automated-security-fixes`: `enabled: false`), and the repo's `security_and_analysis` field is
`null`, so no secret scanning setting exists for it.

What each feature needs, from `github/docs` `data/reusables/gated-features/` (re-read 7 Nov; every
row below matches the source):

<!-- prettier-ignore -->
| Feature | Private repo, user-owned | Public repo |
|---|---|---|
| Secret scanning | **Not available** (needs Secret Protection on an org, or Enterprise Managed Users) | Free, runs automatically |
| Push protection | Not available | On for users by default |
| Dependabot alerts | Available | Available |
| Dependabot security and version updates | Available | Available |
| Code scanning (CodeQL) | **Not available** (needs Code Security on an org) | Free |
| Dependency review | Not available | Free |
| Private vulnerability reporting | **Not available** | Free |

Pro doesn't change the private column for these features. Only visibility does. **Q1 is decided:**
private on Pro until about M3–M4, then public (#38). So rulesets, CODEOWNERS and environments work
now, and every row above that says "not available" arrives at go-public. Until then, CI checks fill
the gap: `guard / secrets` and `ci / audit` below.

**Recommendations.**

- **Secret scanning and push protection: adopt at go-public (#38).** Until then: the local
  safeguards (the `UserPromptSubmit` hook, `.gitignore` for `.env*`, the count-only staged-diff
  check in C5), plus **the gitleaks CLI as the required check `guard / secrets`**, adopted with the
  CI/CD step (#42). It runs `gitleaks git --redact --no-banner` over the PR's commit range
  (`--log-opts="<base>..<head>"`), in a checkout with the full history fetched. `detect` and
  `protect` have been deprecated since v8.19.0
  ([gitleaks README](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md), v8.30.1, checked
  7 Nov). `--redact` keeps any secret it finds out of the log. The CLI is MIT-licensed and is
  downloaded from its release and checked against the published checksums, with no third-party
  action (Marketplace research, area 9). Before the switch, the same CLI scans the full history
  (#38).
- **The pnpm 12 lockfile limits Dependabot here** (checked 7 Nov). "When pnpm writes
  `pnpm-lock.yaml` as two YAML documents, the dependency graph does not detect the dependencies in
  that file. This is the default format for pnpm 12 projects that pin a pnpm version. Dependabot
  version updates still work, but Dependabot alerts and Dependabot security updates are not created
  for those dependencies"
  ([supported ecosystems, "pnpm"](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories#pnpm)).
  This repo pins `pnpm@12.15.0` in `package.json`, and its `pnpm-lock.yaml` already has two
  documents (two `---` separators; the first holds the pinned pnpm itself). So alerts and security
  updates below won't cover the npm dependencies while that format holds. Version updates will.
- **`pnpm audit --audit-level=high` as the required check `ci / audit`: adopt with the CI/CD step
  (decided 7 Nov).** It reads pnpm's own lockfile, so it covers what the dependency graph can't.
  It's part of pnpm, so it adds no dependency and no action. No `--fix` in CI. Its advisory source
  isn't named in its help text (not verified). **osv-scanner** stays only if #42 proves it reads the
  lockfile's second document, which holds the dependencies. The first holds only pnpm itself.
  **Shown in #42 (throwaway PR #276, closed unmerged, 15 Nov): osv-scanner v2.7.0 reads both
  documents.** On a fixture in pnpm 12's two-document format, with `lodash@4.17.20` as a dev
  dependency in the second document, it found 16 packages and failed on lodash's four advisories (2
  High, 2 Medium), the same as on a one-document control. On the real `pnpm-lock.yaml` it found 264
  packages and the one Medium advisory `pnpm audit` also reports (minimatch, GHSA-g3hv-75wg-m249).
  `pnpm audit` takes its advisories from GitHub's database (its report links to
  `github.com/advisories`). So osv-scanner qualifies under D3, but it isn't a check yet: it fails on
  any severity and has no flag to set a threshold, so as a plain step it would turn red on `main`
  today. Its check name, threshold and `CONSTRAINTS.md` row are #278 (the admin's decision, 16 Nov,
  recorded on #42).
- **Semgrep as the required check `guard / code-scan`: adopt with the CI/CD step (#42).** Like
  gitleaks, it needs an "Allowed actions" entry or a checksum-verified download, and so does
  osv-scanner if it's kept. **Applied with #42:** the three scans are jobs in
  `.github/workflows/security.yml`, each tool downloaded in a `run:` step and checked against a hash
  written in the repo, with no third-party action. gitleaks is the v8.30.1 release archive, checked
  against its published SHA-256. Semgrep is installed with
  `pip install --require-hashes --only-binary=:all:` from `.github/semgrep/requirements.txt`, which
  pins Semgrep and every package it needs with their hashes (the admin decided pip with hashes, 16
  Nov; the version is approved in the PR). **Known limit: the rule packs aren't pinned** (the
  admin's decision, 16 Nov). `p/default` and `p/owasp-top-ten` download from the Semgrep registry on
  each run, so a rule-pack update can turn `guard / code-scan` red with no code change. If that
  happens, read the rule diff, and consider vendoring a snapshot of the packs then. A root
  `.semgrepignore` with no entries switches off Semgrep's built-in ignore list, which skips `tests/`
  and `test/` folders, so tests are scanned too. Semgrep v1.184.0 doesn't read `.gitignore`, and a
  `.gitignore` entry can't hide a tracked file from it.
- **Dependabot alerts: adopt now.** Free on private repos. No noise until there are dependencies.
  For npm dependencies, see the pnpm 12 limit above.
- **Dependabot security updates: adopt at M2**, when `packages/sim` brings dev dependencies.
  Security updates ignore cooldowns
  ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown)),
  so a fix can be younger than 7 days, and `pnpm install` will refuse it under `minimumReleaseAge`.
  That's intended: the PR shows the alert, and the admin decides. The setting is never lowered
  (AGENTS.md). For npm dependencies, see the pnpm 12 limit above.
- **Dependabot version updates: adopt at M3**, only with `cooldown: default-days: 7` (matching
  `minimumReleaseAge`), `versioning-strategy: increase` (exact pins stay exact), weekly, grouped,
  for the `npm` ecosystem (pnpm v7–v12 are listed; support for pnpm 11 and 12 arrived on 20
  Oct 2026) and `github-actions` (it updates the version comment of a SHA-pinned action when the
  comment is on the same line)
  ([supported ecosystems](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories),
  checked 7 Nov). Dependabot's PRs come from `dependabot[bot]`, a separate identity, and pass the
  same required checks. They change `package.json` or the lockfile, so they're code-owned PRs, and
  the admin approves them (area 2). Dependabot never adds a dependency, so the "ask before adding"
  rule isn't touched. Draft in appendix A7.
- **Code scanning (CodeQL default setup): adopt at go-public (#38).** Not available while private.
  Whether Semgrep stays the required code scan and CodeQL runs as advice, or the other way round, is
  decided at go-public (Q13).
- **Private vulnerability reporting: adopt at go-public (#38)**; `SECURITY.md` points to it, so no
  contact address is needed (Q8).
- **Dependency review: skip while the lockfile is pnpm 12's two-document format**, even once public.
  It reads the same dependency graph that can't see that lockfile, so it would miss the npm
  dependencies (an inference from the dependency-graph limit, not tested). #38 lists it; drop it
  there or revisit if the format changes.
- **Actions permissions** (set before the first workflow lands). Read on 7 Nov:
  `GET …/actions/permissions` returns `enabled: true`, `allowed_actions: local_only`,
  `sha_pinning_required: false`; `GET …/actions/permissions/workflow` returns
  `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`.
  - Default `GITHUB_TOKEN` permissions: **read** repository contents. Already set. Each workflow
    raises only what it needs per job: `pull-requests: write` for the labeler. The reviewer App
    brings its own token with its own permissions (area 2).
  - "Allow GitHub Actions to create and approve pull requests": **off**. Already off. It's off by
    default for a personal repo
    ([Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).
  - Allowed actions: **"Allow sssoto17, and select non-sssoto17, actions and reusable workflows"**,
    with GitHub-created actions allowed and an explicit list for the rest (for example
    `supabase/setup-cli@*`, `pnpm/action-setup@*`) as the CI/CD step adds them. Today it's "local
    only", which blocks GitHub-authored actions such as `actions/checkout` and `actions/labeler`, so
    this must change before the first workflow runs.
  - **Every action pinned to a full commit SHA with a version comment**, as above. Turn on "Require
    actions to be pinned to a full-length commit SHA". The setting exists (the REST field
    `sha_pinning_required`, off today;
    [REST: Actions permissions](https://docs.github.com/en/rest/actions/permissions), checked 7
    Nov). The 7-day rule applies to actions too: pin a release at least 7 days old.
  - `pull_request_target` only for jobs that never run PR code: the labeler and the reviewer App's
    review job. The review job holds the App's key and feeds text the PR wrote to a model, so its
    guard against prompt injection is designed with it (area 2). **Applied 12 Nov, #226, a temporary
    third user:** `.github/workflows/check-103-claude.yml`, #103's check of Claude in Actions. The
    admin accepted it (comment on #103, 12 Nov) because it runs no PR code. It runs only for a PR
    from `throwaway/103-claude` onto `throwaway/103-base`. Its checkout has no `ref`, so it gets the
    default branch. It uses the `factory` environment. On this event the run's ref is `main`, and a
    job like it would get that environment's secrets for any PR. The admin's note for #68: the
    reviewer should use its own environment. #103's results were recorded and #103 closed on 12 Nov.
    **Removed 12 Nov, #227:** the file is deleted, not rewritten (#68's reviewer is its own
    `review.yml`), with Exceptions row E1 and `ci-check.sh`'s 103 target. The third
    `pull_request_target` user is gone; the labeler and #68's reviewer are the only two.

**Alternatives considered.**

- **Go public now**, for free scanning from M2. Rejected by the admin (Q1): the repo stays private
  until about M3–M4. The CI checks above cover the gap until then.
- **Renovate** instead of Dependabot. Rejected: a GitHub App with its own config and permissions,
  for the same job. Dependabot is built in and has the cooldown option.
- **Disabling Dependabot security updates** to respect the 7 days strictly. Rejected: the admin
  should see the fix and decide; refusing it silently hides a known vulnerability.

## 9. Everything else on the platform

<!-- prettier-ignore -->
| Feature | Decision | Reason |
|---|---|---|
| **Actions** in general | **Adopt** with the CI/CD step | MUST-17.1. The pipeline's design is that step's job, not this ADR's. This ADR sets the permissions it runs under (area 8) and the checks' names (area 2). Cost: a private repo draws on a monthly included compute amount, now given in US dollars, not minutes ($12 on Free, $18 on Pro). Standard GitHub-hosted runners are free in public repos ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), checked 7 Nov). **Until go-public, the factory spends that $18 a month.** Stryker, the Lighthouse runs, Semgrep and the acceptance stack on every factory PR need an estimate or a cap before unattended factory work starts. `CONSTRAINTS.md` has a cost criterion for it (CI runner time per PR, #40). |
| **Releases** | **Adopt** at M4 | Area 1: one per shipped milestone tag. |
| **Insights** | **Use**, read-only | Pulse, commit and PR graphs feed the report's process chapter. On a private repo the graphs need Pro (`gated-features/repository-insights.md`). |
| **Pages** | Skip | Vercel hosts the game; the docs live in the repo. Off today. |
| **Wiki** | Skip (off today) | Docs belong in `docs/`, versioned with the code, where agents read them. |
| **Discussions** | Skip (off today) | Solo project. Playtest feedback goes through forms into `triage` (`docs/diagrams/workflow.md`). |
| **Codespaces / dev container** | Defer for development; reconsider if the examiners need to run the project | Local WSL plus cloud sessions cover the admin. A dev container would pin Node 24, pnpm and the Supabase CLI for a reader. The load run's devcontainer is [ADR-0009](0009-devcontainer-for-the-load-run.md) (load VM only); development use is parked in #502, behind this trigger. |
| **GitHub Packages** | Skip | Nothing is published; `packages/sim` is a workspace package. |
| **Copilot code review** | Skip | The reviewer is an own App running the repo's skills (area 2). "Copilot approvals" stays off: an approval from it would count toward the required approval ([Copilot code review](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review), checked 7 Nov). |
| **Copilot cloud agent** | Skip | The factory is Claude Code (#37). |
| **Notifications** | Adopt | Watch the repo as "Participating and @mentions" plus Actions failures, so CI failures on factory PRs reach the admin. A user setting. |
| **Topics** | Adopt now | None set. Suggested: `idle-game`, `typescript`, `nextjs`, `supabase`, `deterministic-simulation`, `bachelor-project`. |
| **Description** | Keep | Already set and accurate. |
| **Social preview** | At go-public (#38) | Only shown for public repos. |
| **A container for the load test and CI** | Out of scope | Not a GitHub feature. Decided in #39 (M3) and recorded in [ADR-0009](0009-devcontainer-for-the-load-run.md): no app container, a devcontainer for the load run only. |

### GitHub Marketplace

Researched on 7 Nov from each vendor's pricing, terms and docs pages, and each action's releases
(read-only; nothing installed). Every third-party action also needs "Allowed actions" widened
(area 8) and a SHA pin at least 7 days old.

<!-- prettier-ignore -->
| Candidate | Decision | Reason |
|---|---|---|
| `pnpm audit` (not Marketplace) | **Adopt** with the CI/CD step, as `ci / audit` (`--audit-level=high`) | Covers the pnpm 12 lockfile that Dependabot alerts can't read (area 8). No dependency, no action. |
| Semgrep, osv-scanner | **Adopt** with the CI/CD step (#42): Semgrep as `guard / code-scan`; osv-scanner only if it reads pnpm 12's lockfile | Chosen in `CONSTRAINTS.md` (#45). Each needs an Allowed-actions entry or a checksum-verified download (area 8). |
| gitleaks **CLI** | **Adopt** with the CI/CD step, as `guard / secrets`; full-history scan before go-public | MIT; v8.30.1, published 21 Mar 2026, ships checksums. Runs in the runner; nothing leaves it. |
| `gitleaks/gitleaks-action` | Skip | Not open source: its licence is an end-user agreement that forbids modifications and needs a key for organization accounts. The CLI does the job. |
| PR-title check | **Adopt** with the CI/CD step, as `guard / pr-title` | A few lines of bash reading the title from an env var, never interpolated into the script. `amannn/action-semantic-pull-request` only if the rules grow (pin v6.1.1 until v6.1.2 is 7 days old on 12 Nov). |
| CodeRabbit | Skip | Reviews are paid while private ($24–30 per developer per month), and manual-only for public repos under 10 stars. It asks for write on code and workflows. `allow_author_approval` defaults to on, so an author could ask it to approve its own PR. |
| Mergify | Skip | Its merge queue needs a bypass actor in "Exempt" mode with write on code and workflows. Not worth it for one person; branches-up-to-date stays off (area 2). |
| Greptile | Skip | The reviewer is an own App (area 2). If installed later, keep auto-approve off. |
| Copilot code review | Skip | The own reviewer App does the job (area 2). |
| `davelosert/vitest-coverage-report-action` | Later, if Vitest is chosen | Coverage as a PR comment. The threshold itself belongs in `ci / test`. |
| Renovate | Later, only if Dependabot version updates fail on the pnpm 12 lockfile | Its own `minimumReleaseAge`; keep `autoApprove` off. |
| Socket | Later, at go-public, if it supports pnpm 12 | Its docs list pnpm 5–11. |
| Codecov, release-please / Changesets, `codelytv/pr-size-labeler`, `actions/stale` | Skip | A third party for one person's coverage; release automation area 1 rejects; Size is a Project field, not a label; `stale` would close parked `idea` issues. |
| `actions/dependency-review-action` | Skip | Blind to the pnpm 12 lockfile (area 8). |

## Patterns and alternatives considered

<!-- prettier-ignore -->
| Pattern | Where | Why |
|---|---|---|
| Trunk-based development | Area 1 | `main` always deployable; short branches limit merge risk (skill). |
| Policy as code | Rulesets, CODEOWNERS, `labeler.yml`, `dependabot.yml`, `release.yml` | The rules live in versioned config that the platform enforces, instead of in memory. |
| Peer review by a bot | The reviewer App approves or requests changes; code-owner review and escalation bring in the admin (area 2) | Reviews read like a conversation on the PR, and the admin's attention goes where it counts. |
| Quality gate | Required checks pinned to Actions (area 2) | A change reaches `main` only through named checks, whoever approved it. |
| Single writer, capability record | `guard / code-owned` writes one check run per head; the admin's sign-off is a check run only an App can write, bound to one commit (area 2, #495) | Twins and cancelled runs can't decide the result, and no user token can forge the sign-off. |
| Credential broker | Lanes ask the `open-pr` workflow, by `repository_dispatch`, to open their PRs with the factory App's token (area 2, #336) | The App's key stays in an Actions environment; a session holds only the right to ask, and the workflow checks every request. |
| Least privilege | Read-only `GITHUB_TOKEN`; `production` environment secrets for `v*` tags only, the reviewer App's key for the review job only; admin bypass for PRs only | Each actor gets only the rights its job needs. |
| Convention over configuration | `<N>-<slug>` branches, Conventional Commit titles | Tools (#17's parser, the PR-title check, release notes) can rely on the shape. |
| Single source of truth | Tags for versions, `triage-labels.md` for labels, the issue for Status | One place to change; the others read from it. |
| Release gate | A `v*` tag deploys production; `main` deploys staging (area 4) | Merging and shipping are separate decisions, so auto-merge can't reach the players. |

The main alternatives are recorded per area. The ones that shaped the whole proposal:

- **Who gates a PR:** the admin on every PR, auto-merge on everything outside the admin's paths,
  three tiers with the agent's verdict as a check, or **a reviewer bot that approves or requests
  changes, with the admin on sensitive and escalated PRs** (area 2). The admin chose the last.
- **One GitHub identity for everyone** (today) against **a factory App from Actions** (area 2, Q2,
  #37). #37 chose GitHub-hosted runners over a self-hosted runner, a Claude self-hosted environment
  and an own dispatcher. Until the App runs, admin-review PRs from the factory rest on the admin's
  bypass and the agents' instructions.
- **Deploy on merge** against **deploy on a release tag** (area 4). The admin chose the tag, so
  bot-approved PRs can auto-merge to `main` without reaching the players.
- **Private on Pro now, public at M3–M4** (Q1, #38) against **public now**. It decides when GitHub's
  scanning arrives; CI checks cover the gap.
- **Squash-only with linear history** against **squash plus merge commits** (area 3). The evidence
  trail tipped it.

## Consequences

- Once the `main` ruleset is on, **nothing reaches `main` without a PR**, including the coordinating
  session's retros and rule edits, which were pushed directly until now (15 of 21 commits). Retros
  merge on the reviewer bot's approval. Rule edits (`AGENTS.md`, `CLAUDE.md`) are code-owned PRs.
- **The gap before the reviewer App (decided 7 Nov, Q15).** From the ruleset (checklist step 3)
  until the reviewer App works (step 12), nobody but the admin could give an approval, and the admin
  can't approve their own PRs, which the factory's are. So the `main` ruleset starts with
  `required_approving_review_count: 0` and goes to 1 at step 12; `require_last_push_approval` stays
  off while lanes push as the admin's account, #336 included (admin, 17 Nov 2026; area 2, "Lanes
  open PRs as sunny-factory"). Code-owner review stays on throughout, so code-owned PRs still need
  the admin, by bypass while the factory acts as the admin. (**#495, 22 Nov 2026:** code-owner
  review goes off once #565 and #566 land; area 2, "Solo-admin approvals".)
- Required checks can't be added until CI reports them. Until the CI/CD step, the ruleset blocks
  direct pushes, force-pushes and deletion, and requires code-owner review on code-owned PRs.
  Auto-merge stays off.
- **The admin is no longer the merge gate for every PR, but is the gate to production.**
  Bot-approved PRs merge without the admin and reach staging only. Production changes only when the
  admin pushes a `v*` tag (area 4). Bad auto-merges are caught on staging and by the tuning loop
  (area 2), and their reverts are report data.
- **Production deploys need a token in GitHub:** `VERCEL_TOKEN` and the production Supabase
  credentials live in the `production` environment, which only `v*` tags can use (area 4).
- MUST-15.1 is met in mechanism once CODEOWNERS (A3) and the `main` ruleset are in place. **Until
  #37, an admin-review PR from the factory merges by bypass, held by instructions** (area 2, "The
  honest limit"). For any session on the admin's account, bypass merges, clearing an escalation
  (resolving its thread, or removing `review:admin` until #104), tag pushes and ruleset edits stay
  instruction-only, before and after #37. PR #52 turns tag pushes and label removal into prompts.
  (**#495, 22 Nov 2026:** clearing an escalation becomes removing `review:admin`, which the guard
  checks, and label removal moves from a prompt to a `deny` rule; area 2, "Solo-admin approvals".)
- **Rollout order** (checklist): rulesets now, with 0 required approvals → the reviewer App, then 1
  required approval (`require_last_push_approval` once pushes come from an App, #107), then tests
  (a)–(f) → auto-merge only when the required checks report, the App passes (a)–(f) and #47's
  escalation criteria are merged (Q16) → unattended factory work only once the factory App runs (#37
  decided it: checks #101–#103, then the build issues under #58). Attended sessions are never
  blocked.
- `CONSTRAINTS.md` owns the escalation criteria and the split size (#47) and the list of ways a bar
  gets lowered ("Guarding the bar"). This ADR owns the mechanism.
- **Actions cost.** While private, the checks draw on Pro's included compute, about $18 a month
  (area 9). The heavy checks (Stryker, Lighthouse, Semgrep, the acceptance stack) need an estimate
  or a cap before the factory runs unattended; `CONSTRAINTS.md` has the criterion (CI runner time
  per PR, enforced by #40).
- **Claude cost per review.** Each run of the reviewer bot is a Claude run: on every push, every
  `labeled` event (until #104) and every "Update branch", since each of those dismisses the
  approval. That is separate from Actions compute. #37 decided how it's billed: a `setup-token` from
  the admin's employer seat, under the Commercial Terms, which the factory shares (area 2, "The
  factory's identity"). It costs no money, but it draws on the seat's weekly limit, which the
  admin's paid work also uses. So every run logs `total_cost_usd` and its minutes, the factory has a
  kill switch and per-run caps, and a weekly budget follows from the first week of data. One
  `concurrency` group per PR with `cancel-in-progress` keeps only the newest run.
- **Ratchets can drift** while "branches up to date" is off: two PRs can each pass the bundle or
  coverage ratchet and together go past it. Accepted: the next PR's run catches it (area 2).
- `.github/` files (templates, CODEOWNERS, labeler, the review workflow, Dependabot, release notes)
  land in later PRs by the admin, because `.github/` is code-owned.
- #32's script must treat "already on the Project" as success while auto-add is on.
- The PR template's Changelog line is the input for `CHANGELOG.md` at each tag from M4.
- Go-public (#38) brings scanning, CodeQL, private vulnerability reporting, `SECURITY.md`, the
  licence and the environment reviewer, after a full-history secret scan.

**Knock-on edits, for one follow-up after this ADR merges (listed, not made here):**

- `docs/diagrams/workflow.md`: "Every PR is merged by you, factory PRs included" and the "review and
  merge" step become the reviewer-bot model (area 2; C6).
- `docs/agents/issue-tracker.md`: "In review → Done: the admin merged the PR" becomes "the PR
  merged".
- `docs/requirements/spec.md`:
  - MUST-17.2: "A merge to `main` deploys to Vercel production" becomes "a `v*` release tag on
    `main` deploys to Vercel production on the hosted Supabase project; a merge to `main` deploys to
    staging" (area 4). #51 owns the deploy workflow and its guard.
  - MUST-15.1: a note that it's met in mechanism, and that until #37 the admin's approval on a
    factory PR is a bypass merge held by instructions.
- `AGENTS.md`:
  - a short rule on reviews: agents never merge, never turn on auto-merge by hand, never bypass a
    ruleset, never remove `review:admin`, and add it at `gh pr create` when a PR wraps up a feature
    slice or changes a module's interface; the admin merges admin-review PRs in the UI;
  - line 63, "PRs carry only the areas they touch", contradicted by `review:admin`
    (`triage-labels.md`, this PR).
- `CONSTRAINTS.md`:
  - line 37, "(ADR-0002, tier H)";
  - the "Blast radius (auto-merge tiers)" section (heading at line 175, tier criteria at lines
    180–183), which becomes the escalation criteria and the split size;
  - line 237, "D2: this file owns the blast-radius numbers".
- #47: its scope becomes the escalation criteria and the split size. Its last criterion (auto-merge
  waits for #47 and `guard / tier`) becomes "auto-merge waits for #47's escalation criteria"
  (decided 7 Nov, Q16; checklist step 12).
- #37's body: "blast-radius gate" and "tier-H PRs" become the reviewer-bot model and admin-review
  PRs.
- PR #52 (permission rules): cite it from `AGENTS.md` once merged.

## Open questions for the admin

Q1–Q6, Q8, Q9 and Q12 are answered or decided (see "How this was checked"). Q7 and Q13 are deferred
to go-public (#38), Q10 waits for Vercel and Q11 for #47. Q14–Q16 were decided on 7 Nov.

1. **Q1, plan and visibility.** _Decided 7 Nov:_ GitHub Pro (GitHub Education); private until about
   M3–M4, then public (#38).
2. **Q2, factory identity.** _Decided 7 Nov:_ its own identity, a GitHub App used from Actions.
   Where it runs is spike #37 (area 2). _Decided 8 Nov in #37:_ `sunny-factory`, on GitHub-hosted
   runners; it starts from a scheduled sweep, a chain and `/today`.
3. **Q3, Project state.** _Answered._ All 8 built-in workflows the API lists are on, including
   Auto-archive, Auto-close issue and Pull request linked to issue, which this ADR turns off.
   Auto-add is on and adds PRs as well as issues; its filter isn't readable through the API. Seven
   views exist; This week, Roadmap and Triage match this ADR (area 5).
4. **Q4, Actions and Dependabot settings.** _Answered._ Actions enabled, allowed actions "local
   only", SHA pinning not required, default token permissions read, Actions can't create or approve
   PRs. Dependabot alerts off, security updates off. Note the pnpm 12 lockfile limit on alerts and
   security updates (area 8).
5. **Q5, environments and secrets.** _Answered._ No environments, no repo or Dependabot secrets, no
   Actions variables. Cloud-session commits are signed (verified); local commits aren't (area 2).
6. **Q6, labeler release date.** _Answered._ v7.0.0 was published on 21 Jul 2026, 109 days ago, and
   the tag still points at `bf12e9b…` (area 6).
7. **Q7, licence.** _Decided at go-public (#38)_, after checking EK's rules on student work.
8. **Q8, security contact.** _Decided:_ none needed. At go-public, `SECURITY.md` points to private
   vulnerability reporting (#38).
9. **Q9, `.agents/` and dev tooling.** _Decided 7 Nov:_ `area:tools` covers `tools/`, `scripts/`,
   `.claude/` and `.agents/` (area 6; updated in `triage-labels.md` and A1).
10. **Q10, Vercel's GitHub deployments.** _Open until Vercel is connected._ Vercel isn't connected
    yet (no deployments, webhooks, statuses or checks on 7 Nov). Vercel's docs confirm it uses
    GitHub's Deployments API and posts a commit status per deployment (area 4). Once connected,
    check the names it uses on PRs before deciding on "Require deployments to succeed". Also check
    that Vercel accepts `production` as its production branch with no pushes, so `main` deploys as
    staging (area 4), and what it reports when it skips a preview build (area 2).
11. **Q11, the escalation criteria.** _In #47._ When an agent adds `review:admin` (the bot's
    escalation thread after #104), and the size at which the bot asks for a split, in
    `CONSTRAINTS.md`. The sensitive paths are A3.
12. **Q12, the reviewer bot.** _Decided 7 Nov:_ its own GitHub App running Claude with the repo's
    review skills (area 2). Its permissions are Q14; how Claude is billed in CI is #37, which
    decided on a `setup-token` from the admin's employer seat.
13. **Q13, Semgrep or CodeQL as the required code scan.** _At go-public (#38)._ Semgrep is required
    from the CI/CD step; when CodeQL becomes available, one of them stays required and the other
    runs as advice (area 8).
14. **Q14, the reviewer App's permissions.** _Decided 7 Nov:_ `contents: write` and
    `pull_requests: write`, with `require_last_push_approval: true` on `main` once lanes stop
    pushing as the admin's account (#107; #336 moves only the PR's author, area 2). With
    `contents: read`, it couldn't turn on auto-merge. The blast radius: a prompt-injected reviewer
    could push to PR branches, not to `main` or to tags.
15. **Q15, the approval count before the reviewer App.** _Decided 7 Nov:_ 0 required approvals from
    step 3, 1 from step 12; code-owner review on throughout (Consequences).
16. **Q16, what auto-merge waits for.** _Decided 7 Nov:_ auto-merge turns on only when the required
    checks report, the reviewer App passes tests (a)–(f) (step 12), and #47's escalation criteria
    are merged. #47's last criterion still names `guard / tier` (follow-up).

## Admin checklist

In order. **[.github]** marks a change that is a file under `.github/`, for a later PR, not this
one. Every `gh api` call below writes a setting and prints no secret. Run them from the main folder
outside the sandbox (`docs/agents/sandbox.md`). Q1 and Q2 are decided, so nothing waits on them.

1. **Merge settings** (area 3). UI: Settings → General → Pull Requests. Auto-merge stays off until
   step 12.
   ```sh
   gh api -X PATCH repos/sssoto17/sunny-pastures --silent \
     -F allow_squash_merge=true -F allow_merge_commit=true -F allow_rebase_merge=false \
     -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
     -f merge_commit_title=PR_TITLE -f merge_commit_message=PR_BODY \
     -F allow_auto_merge=false -F allow_update_branch=true -F delete_branch_on_merge=true
   ```
2. **Topics** (area 9). UI: repo home → About → gear.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/topics --silent \
     -f 'names[]=idle-game' -f 'names[]=typescript' -f 'names[]=nextjs' \
     -f 'names[]=supabase' -f 'names[]=deterministic-simulation' -f 'names[]=bachelor-project'
   ```
3. **Ruleset `main`** (area 2), with code-owner review and stale-approval dismissal on. Until the
   reviewer App works (step 12), nobody can give the required approval, so every merge is a bypass
   merge (Consequences), so it starts at 0 required approvals (Q15). UI: Settings → Rules → Rulesets
   → New branch ruleset. The JSON is in appendix A8 (`actor_id: 5` is the Repository admin role
   _(not re-checked: the REST reference doesn't list role IDs; GitHub's own rulesets in
   `github/docs` use `actor_id: 5`, `RepositoryRole` for their bypass, checked 7 Nov)_; check the
   bypass list in the UI after creating it).
   ```sh
   gh api -X POST repos/sssoto17/sunny-pastures/rulesets --input ruleset-main.json --jq '.id'
   ```
   _Applied 8 Nov, #66:_ id 26810726. The UI shows "Repository admin, For pull requests only", so
   `actor_id: 5` is confirmed; A8 has the two defaults GitHub added.
4. **Ruleset `prototype/*`** and **ruleset `v*` tags** (appendix A8), same call with their files.
   From here until #37, every session holds the bypass the `main` ruleset gives the admin (area 2).
5. **Project workflows** (area 5). UI only: the Project → ⋯ → Workflows. All 8 are on today (7 Nov).
   Turn off Auto-archive items, Auto-close issue and Pull request linked to issue; set auto-add's
   filter to `is:issue` (it adds PRs today); check that Item added to project sets Backlog. Turn on
   Item reopened only if the page offers it. _Applied 8 Nov, #66;_ the differences are in area 5,
   "Built-in workflows".
6. **Project views** (area 5). UI only: the Project → New view. This week, Roadmap and Triage exist;
   add Week, Factory and Blocked, and the 7-day limit on Done in This week. _Applied 8 Nov, #66,_
   with different Factory and Blocked filters and no 7-day limit (area 5, "Views").
7. **Dependabot alerts** now (area 8); off today. They won't cover npm dependencies while the
   lockfile uses pnpm 12's two-document format (area 8). UI: Settings → Code security → Dependabot
   alerts.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/vulnerability-alerts --silent
   ```
8. **Actions permissions** (area 8), before the first workflow. UI: Settings → Actions → General.
   Today (7 Nov) allowed actions is "local only" and SHA pinning isn't required; the token default
   (read) and the PR-approval setting (off) already match, so the third call only confirms them.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions --silent \
     -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions/selected-actions --silent \
     -F github_owned_allowed=true -F verified_allowed=false
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions/workflow --silent \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
   ```
9. **[.github] The templates PR** (M2): `ISSUE_TEMPLATE/*.yml` and `config.yml` (A4),
   `pull_request_template.md` (A2), `CODEOWNERS` (A3), with the code-owned paths from #34. The
   admin's PR, not an agent's. Create the escalation label, so agents can use it from the start:
   ```sh
   gh label create review:admin --color C5DEF5 --description "Needs the admin's review"
   ```
10. **M2: Dependabot security updates** (area 8); off today. Same pnpm 12 limit as alerts. UI:
    Settings → Code security.
    ```sh
    gh api -X PUT repos/sssoto17/sunny-pastures/automated-security-fixes --silent
    ```
11. **No unattended factory work until the factory App runs** (area 2). #37 gave the factory its own
    App, so no guard for unattended sessions is built. Until the App runs, `factory:ready` issues
    are worked only from attended sessions. Attended sessions are never blocked. The admin's setup
    steps for the Apps and the Claude token are in #101 and #103.
12. **CI/CD step:** **[.github]** `labeler.yml` and its workflow (A1); the CI workflows and the
    review workflow (area 2). **After #37 has settled how Claude is billed in CI** (Consequences),
    register the reviewer App (with #37's factory App) with `contents: write` and
    `pull_requests: write` (Q14); its key as an environment secret. Then update the `main` ruleset:
    `required_approving_review_count` to 1 (Q15); `require_last_push_approval` stays `false` while
    lanes push as the admin's account, after #336 too, which moves only the PR's author to the App
    (admin, 17 Nov 2026; Q14's `true` waits for pushes from an App, #107). Code-owner review stays
    on. **Test the flow once**, on throwaway PRs, reading each result with
    `gh pr view N --json reviewDecision,mergeStateStatus`:
    - (a) the App's approval on a PR outside CODEOWNERS gives `reviewDecision: APPROVED`;
    - (b) the App can turn on auto-merge on that PR;
    - (c) the App's Request changes blocks the merge (`CHANGES_REQUESTED`, merge state `BLOCKED`).
      GitHub's protected-branches page speaks of "a person with admin permissions", so test it
      rather than assume it;
    - (d) a push to the PR dismisses the App's approval (back to `REVIEW_REQUIRED`);
    - (e) a PR that meets an escalation row gets an escalation thread that mentions the admin. On a
      PR the admin's account opened, the App approves it if it finds it clean, and the open thread
      alone holds the merge (`APPROVED`, `BLOCKED`); on a PR an App opened, it withholds its
      approval (#322). When the factory App resolves the thread, the App's next run unresolves it.
      When the admin resolves it, it stays resolved. Until #104, the App also adds `review:admin`
      when it escalates, which holds its approval, so (e) shows no approval; and adding the label
      makes the App dismiss its approval and turn auto-merge off;
    - (f) an App-approved PR that changes one line of `AGENTS.md` still waits for the code owner's
      review (`BLOCKED`).
    - **#495 (22 Nov 2026):** once #566 lands, (e) reads: the App approves a clean escalated PR
      whoever opened it, and `guard / code-owned` holds it (`APPROVED`, `BLOCKED`) until the admin
      removes `review:admin` on its head; no thread is reopened. Once code-owner review is off, (f)
      waits for `guard / code-owned` instead. #567 checks both on a stack.

    Close the throwaway PRs unmerged. If any test fails, fix the App or the workflow and run that
    test again; auto-merge stays off until all six pass. Add the required checks to the `main`
    ruleset as they start reporting, each with GitHub Actions as its source (Settings → Rules → the
    ruleset → Require status checks; A8). _Applied 8 Nov, #40:_ the first four checks went into
    their own ruleset, `main checks`, with no bypass, so the `main` ruleset no longer carries them.
    Add later checks to `main checks` (area 2, A8). A broken check then blocks every merge until
    it's fixed or the admin edits `main checks`. At M4, the preview checks need Vercel's automation
    bypass secret as an Actions secret (area 2), set with `gh secret set` so it's never shown. Turn
    on auto-merge **only once** the required checks report, (a)–(f) pass and #47's escalation
    criteria are merged (Q16):

    ```sh
    gh api -X PATCH repos/sssoto17/sunny-pastures --silent -F allow_auto_merge=true
    ```

13. **M3:** **[.github]** `dependabot.yml` (A7). The `production` environment waits for step 15. A
    `staging` environment only if Actions runs staging migrations or deploys (area 4).
14. **Go-public (#38, about M3–M4):** the full-history gitleaks scan first; then the licence (Q7),
    `SECURITY.md` (A5), the visibility switch, secret scanning, push protection, private
    vulnerability reporting, CodeQL default setup, and the admin as required reviewer on
    `production` (area 4). UI: Settings → Code security.
    ```sh
    gh api -X PATCH repos/sssoto17/sunny-pastures --silent \
      -f 'security_and_analysis[secret_scanning][status]=enabled' \
      -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
    gh api -X PUT repos/sssoto17/sunny-pastures/private-vulnerability-reporting --silent
    gh api -X PATCH repos/sssoto17/sunny-pastures/code-scanning/default-setup --silent -f state=configured
    ```
15. **M4, before the first tag:** the deploy setup (area 4).
    - In Vercel: the production branch set to `production`, `main` given the staging domain and the
      staging variables. UI: the Vercel project → Settings → Environments.
    - `vercel.json` with `deploymentEnabled` off for `production`, in a PR of the admin's
      (`vercel.json` is code-owned, A3).
    - Ruleset `production` (appendix A8), same call as step 3 with its file.
    - **[.github]** the `deploy` workflow (area 4) and `release.yml` (A6).
    - The `production` environment, admitting only tags `v*`, and its secrets, set without echoing
      them:
    ```sh
    gh api -X PUT repos/sssoto17/sunny-pastures/environments/production --silent \
      -F 'deployment_branch_policy[protected_branches]=false' \
      -F 'deployment_branch_policy[custom_branch_policies]=true'
    gh api -X POST repos/sssoto17/sunny-pastures/environments/production/deployment-branch-policies \
      --silent -f name='v*' -f type=tag
    gh secret set VERCEL_TOKEN --env production            # prompts; the value is never shown
    gh secret set VERCEL_ORG_ID --env production
    gh secret set VERCEL_PROJECT_ID --env production
    gh secret set SUPABASE_ACCESS_TOKEN --env production
    ```
    Then the first tag `v0.4.0`, which deploys; its Release; `CHANGELOG.md`.

---

# Appendix: drafts

Drafts only. They land under `.github/` in the admin's PRs (checklist 9, 12, 13 and 15), except
`SECURITY.md`, which lands at the repo root at go-public (checklist 14).

## A1. `.github/labeler.yml` and its workflow

Paths exactly as `triage-labels.md` defines each area. `sync-labels` is left off.

```yaml
# .github/labeler.yml: area:* labels from changed paths (docs/agents/triage-labels.md, "Areas").
# tests/acceptance/ and prototypes/<name>/ take the area of what they test: set by hand.

"area:ui": # apps/web/ outside src/server/: pages, components, client state
  - changed-files:
      - any-glob-to-any-file:
          - "apps/web/*"
          - "apps/web/!(src)/**"
          - "apps/web/src/*"
          - "apps/web/src/!(server)/**/!(route.*)"

"area:api": # apps/web/src/server/, route handlers
  - changed-files:
      - any-glob-to-any-file:
          - "apps/web/src/server/**"
          - "apps/web/src/app/**/route.{ts,tsx,js}"

"area:sim":
  - changed-files:
      - any-glob-to-any-file: "packages/sim/**"

"area:db": # supabase/, the Drizzle schema, migrations, RLS (real paths since #372)
  - changed-files:
      - any-glob-to-any-file:
          - "supabase/**"
          - "apps/web/src/server/db/**"
          - "apps/web/src/server/store/schema.ts"
          - "apps/web/drizzle.config.json"

"area:ci-cd": # .github/, deploy config, root config
  - changed-files:
      - any-glob-to-any-file:
          - ".github/**"
          - "vercel.json"
          - "package.json"
          - "pnpm-workspace.yaml"
          - "pnpm-lock.yaml"
          - "skills-lock.json"
          - ".nvmrc"
          - ".gitignore"
          - ".env.example"

"area:tools": # all dev tooling: tools/, scripts/, .claude/, .agents/
  - changed-files:
      - any-glob-to-any-file:
          - "tools/**"
          - "scripts/**"
          - ".claude/**"
          - ".agents/**"

"area:docs":
  - changed-files:
      - any-glob-to-any-file:
          - "docs/**"
          - "GLOSSARY.md"
          - "AGENTS.md"
          - "CLAUDE.md"
          - "README.md"
```

```yaml
# .github/workflows/labeler.yml
name: Labeler
on:
  pull_request_target: # config read from main; never checks out PR code
    types: [opened, synchronize, reopened]
permissions: {}
jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/labeler@bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13 # v7.0.0
```

## A2. `.github/pull_request_template.md`

The template lives in `.github/pull_request_template.md`; this appendix no longer copies it, so
there is one version to keep current. On 12 Nov the admin set the rule that a checkbox is only for
an item someone will tick (#214): the Review section's two yes/no checkboxes became the plain lines
`Admin review:` and `Code-owned paths:`, with the same meaning and guidance comments.

## A3. `.github/CODEOWNERS`

```
# Code-owned paths (ADR-0002, area 2): a PR that touches any of these needs the admin's approval,
# because the main ruleset requires code-owner review. Tuned with CONSTRAINTS.md (#34).
# Only @sssoto17 is a code owner; never add a bot or an app.
/tests/acceptance/      @sssoto17
/.github/               @sssoto17
/.claude/               @sssoto17
/.agents/               @sssoto17
/AGENTS.md              @sssoto17
/CLAUDE.md              @sssoto17
/CONSTRAINTS.md         @sssoto17
/REVIEW.md              @sssoto17
/docs/adr/              @sssoto17
/docs/requirements/     @sssoto17
/docs/agents/           @sssoto17
/docs/diagrams/workflow.md @sssoto17
/skills-lock.json       @sssoto17
.gitattributes          @sssoto17
**/package.json         @sssoto17
/vercel.json            @sssoto17
/pnpm-workspace.yaml    @sssoto17
/pnpm-lock.yaml         @sssoto17
/supabase/config.toml   @sssoto17
/supabase/migrations/   @sssoto17
# Drizzle (#372): the schema the migrations are generated from (its RLS included), the client,
# drizzle-kit's config and the drift check. db/ holds the global setup of the tests that run
# against the stack too (db/tests/stackSetup.ts, #382), and their `db` project is in vitest.config.*.
/apps/web/src/server/store/schema.ts @sssoto17
/apps/web/src/server/db/ @sssoto17
/apps/web/drizzle.config.json @sssoto17
/supabase/drift.sh      @sssoto17

# Configs that can weaken a check (CONSTRAINTS.md, "Guarding the bar"), in any directory.
eslint.config.*         @sssoto17
tsconfig*.json          @sssoto17
vitest.config.*         @sssoto17
stryker.conf*           @sssoto17
stryker.config.*        @sssoto17
.gitleaks.toml          @sssoto17
.gitleaksignore         @sssoto17
osv-scanner.toml        @sssoto17
.semgrepignore          @sssoto17
lighthouserc.*          @sssoto17
.lighthouserc.*         @sssoto17
.fallowrc.json          @sssoto17
.fallowrc.jsonc         @sssoto17
fallow.toml             @sssoto17
.fallow.toml            @sssoto17
```

A pattern with no slash matches in any directory, as in `.gitignore`. The Stryker, Lighthouse and
Fallow names cover their usual config files. Check them against the files that land, since a config
under another name would go to the reviewer bot only.

GitHub reads CODEOWNERS from the PR's base branch, so a PR can't remove its own paths from this list
([about code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).

## A4. Issue forms

`.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: false
```

Each form sets its type label plus `triage`, and its native issue type with `type:` (#254, by the
mapping in `scripts/lib/issue-types.sh`); the area is added when the issue is evaluated
(`triage-labels.md`). Milestone and Project fields are set on the Project (auto-add puts the issue
there).

`.github/ISSUE_TEMPLATE/feature.yml`:

```yaml
name: Feature
description: New behaviour for the player, the admin or the API
labels: [feature, triage]
type: Feature
body:
  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: What changes for whom, and why now. Link the requirement (MUST-/SHOULD-…).
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      description: A list a reviewer can verify (a test, a command, a file, a number).
      value: |
        - [ ]
    validations: { required: true }
  - type: textarea
    id: context
    attributes:
      label: Context
      description:
        ADRs, glossary terms, code areas and issues to read first. Blockers go in native
        dependencies.
```

`.github/ISSUE_TEMPLATE/bug.yml`:

```yaml
name: Bug
description: Something that worked, or was specified, behaves wrongly
labels: [bug, triage]
type: Bug
body:
  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: What should be true once it's fixed.
    validations: { required: true }
  - type: textarea
    id: repro
    attributes:
      label: Steps to reproduce
      description:
        Include the farm seed or action log if the sim is involved, and the browser for UI bugs.
    validations: { required: true }
  - type: textarea
    id: expected
    attributes:
      label: Expected and actual
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      value: |
        - [ ] A regression test that fails before the fix and passes after
    validations: { required: true }
```

`.github/ISSUE_TEMPLATE/spike.yml`:

```yaml
name: Spike
description: Throwaway work that answers a question with measurements or a prototype
labels: [spike, triage]
type: Chore
body:
  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: The question, and the ADR or doc the answer lands in.
    validations: { required: true }
  - type: textarea
    id: rule
    attributes:
      label: Decision rule (fixed before measuring)
      description: What is measured, how, and which result picks which answer.
    validations: { required: true }
  - type: input
    id: timebox
    attributes:
      label: Timebox
      placeholder: e.g. one project day
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      value: |
        - [ ] Results and the decision recorded in <ADR/doc>
    validations: { required: true }
```

`.github/ISSUE_TEMPLATE/design.yml`:

```yaml
name: Design
description: Work whose output is decisions (a grill, an ADR, glossary terms, the spec)
labels: [design, triage]
type: Design
body:
  - type: textarea
    id: goal
    attributes:
      label: Goal
      description:
        The decisions to make, and the issues they block (add those as native dependencies).
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      description: Which files hold the decisions when it's done.
      value: |
        - [ ] Decision recorded in <ADR / GLOSSARY.md / spec.md>
    validations: { required: true }
  - type: textarea
    id: context
    attributes:
      label: Known constraints and context
```

`.github/ISSUE_TEMPLATE/chore.yml`:

```yaml
name: Chore
description: Upkeep with no new behaviour (tooling, config, hooks, dependencies, docs-only work)
labels: [chore, triage]
type: Chore
body:
  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: What changes and why it's worth doing now.
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      value: |
        - [ ]
    validations: { required: true }
```

`.github/ISSUE_TEMPLATE/idea.yml`:

```yaml
name: Idea
description: Wanted but not shaped enough to build. Never moves to Ready as an idea.
labels: [idea, triage]
type: Chore
body:
  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: The outcome you want, in a sentence or two.
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria (if known)
      description: Optional for an idea. Filled in when it's retyped or a design issue shapes it.
```

## A5. `SECURITY.md` (go-public, #38)

```markdown
# Security

Sunny Pastures is a student project (EK PBA Webudvikling, 2026–27). Only the latest deployed version
is supported.

## Reporting a vulnerability

Please don't open a public issue. Report it privately with "Report a vulnerability" on the
repository's Security tab.

Expect a reply within a few days. Cheating that works against the server (forged time, replayed or
invented actions) counts as a vulnerability.
```

## A6. `.github/release.yml` (M4)

```yaml
changelog:
  exclude:
    labels: [triage]
  categories:
    - title: Game and UI
      labels: ["area:ui", "area:sim"]
    - title: API and data
      labels: ["area:api", "area:db"]
    - title: Tooling and CI
      labels: ["area:ci-cd", "area:tools"]
    - title: Docs
      labels: ["area:docs"]
    - title: Other
      labels: ["*"]
```

A PR with several area labels is listed once, under the first category that matches. Dependabot PRs
stay in, so security bumps show in the notes.

## A7. `.github/dependabot.yml` (M3)

```yaml
version: 2
updates:
  - package-ecosystem: npm # pnpm uses the npm ecosystem
    directory: /
    schedule: { interval: weekly }
    versioning-strategy: increase # exact pins stay exact
    cooldown:
      default-days: 7 # matches minimumReleaseAge in pnpm-workspace.yaml
    groups:
      all-dev:
        dependency-type: development
    open-pull-requests-limit: 3
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
    cooldown:
      default-days: 7
```

**Applied 8 Nov, #92 (with #69):** `.github/dependabot.yml` is the draft above plus two keys on both
entries, deviations the admin decided on 8 Nov:

```yaml
labels: ["area:ci-cd", "review:admin"] # code-owned paths (triage-labels.md)
commit-message: { prefix: chore, include: scope } # chore(deps): / chore(deps-dev):
```

- `labels: ["area:ci-cd", "review:admin"]`: Dependabot's PRs touch `package.json`, the lockfile or
  `.github/`, which are `area:ci-cd` and code-owned. Without it, Dependabot would add its own
  `dependencies`, `javascript` and `github_actions` labels outside the taxonomy.
- `commit-message: { prefix: chore, include: scope }`: PR titles read `chore(deps): …` or
  `chore(deps-dev): …`, so they pass the planned `guard / pr-title`.

**Changed 16 Nov, #268:** the npm entry adds an `ignore` for `typescript` with
`update-types: ["version-update:semver-major"]`. Dependabot no longer proposes TypeScript majors,
inside the `all-dev` group (#262 bumped TypeScript 6 to 7 there) or alone; a major is upgraded by
hand.

**Changed 22 Nov, #268:** TypeScript 7 runs side by side with the TypeScript 6 API, so the ignore
lists all three names: `typescript` (an alias of `@typescript/typescript6`, the TS 6 API that
typescript-eslint and Next import), `typescript-7` (an alias of the npm package `typescript@7.0.2`,
the compiler behind `tsc`) and `@typescript/typescript6` (imported by name by the TS API tests and
the determinism gate). Whether Dependabot matches an `npm:` alias by its key or by the real package
name is unverified, so both names are listed.

## A8. Rulesets (JSON for `gh api --input`)

`ruleset-main.json`:

```json
{
	"name": "main",
	"target": "branch",
	"enforcement": "active",
	"conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
	"bypass_actors": [
		{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
	],
	"rules": [
		{ "type": "deletion" },
		{ "type": "non_fast_forward" },
		{
			"type": "pull_request",
			"parameters": {
				"required_approving_review_count": 0,
				"dismiss_stale_reviews_on_push": true,
				"require_code_owner_review": true,
				"require_last_push_approval": false,
				"required_review_thread_resolution": true,
				"allowed_merge_methods": ["merge", "squash"]
			}
		}
	]
}
```

`ruleset-prototype.json`:

```json
{
	"name": "prototype",
	"target": "branch",
	"enforcement": "active",
	"conditions": { "ref_name": { "include": ["refs/heads/prototype/*"], "exclude": [] } },
	"rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }]
}
```

`ruleset-production.json`:

```json
{
	"name": "production",
	"target": "branch",
	"enforcement": "active",
	"conditions": { "ref_name": { "include": ["refs/heads/production"], "exclude": [] } },
	"rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
```

`ruleset-tags.json`:

```json
{
	"name": "release tags",
	"target": "tag",
	"enforcement": "active",
	"conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
	"bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
	"rules": [
		{ "type": "creation" },
		{ "type": "update" },
		{ "type": "deletion" },
		{ "type": "non_fast_forward" }
	]
}
```

This is the ruleset as created at checklist step 3 (Q15): 0 required approvals, because nobody but
the admin could approve yet. At step 12, once the reviewer App works,
`"required_approving_review_count"` goes to 1; `"require_last_push_approval": true` (Q14) waits
until lanes stop pushing as the admin's account (#107; #336 moves only the PR's author; admin, 17
Nov 2026). From then on, one approval is required: the reviewer App's, or the admin's on
admin-review PRs (area 2). Code-owner review is on throughout. Neither App is in any bypass list
(#37). GitHub's docs don't say how `require_last_push_approval` behaves with 0 required approvals,
so it changes no earlier than step 12, and in fact only once pushes come from an App.

**Applied 8 Nov, #66; read back 12 Nov** (`gh api repos/sssoto17/sunny-pastures/rulesets/26810726`).
The rules match `ruleset-main.json` above: 0 required approvals and code-owner review on, until #68
raises the count. The differences:

- **The bypass actor.** `actor_id: 5`, `RepositoryRole`, `bypass_mode: pull_request` is the
  Repository admin role: the UI lists "Repository admin, For pull requests only", and the API
  returns `current_user_can_bypass: "pull_requests_only"` for the admin's account. This settles step
  3's _not re-checked_.
- **`required_reviewers: []`**, a default GitHub added. The Required reviewers rule names teams, and
  it "is not available on user-owned repositories as they do not contain teams"
  ([available rules, "Required reviewers"](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#required-reviewers),
  read 12 Nov). So it stays empty here.
- **`require_extra_approval_for_unattributed_changes: true`**, a default GitHub added. _Documented_
  (public preview): "When Copilot opens a pull request that isn't attributed to a person, the
  ruleset requires one more approval than the number you configured", and "This setting has no
  effect if the ruleset requires zero approvals"
  ([available rules, "Additional approval for unattributed Copilot pull requests"](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#additional-approval-for-unattributed-copilot-pull-requests),
  read 12 Nov). What it means here:
  - _Documented:_ no effect today, at 0 required approvals.
  - _Inference, unconfirmed until #68:_ probably no effect on `sunny-factory`'s PRs at 1 approval
    either. The docs name only Copilot opening a PR under its own App identity; they don't say
    whether another App's PR counts as unattributed. If it did, a factory PR would need two
    approvals from step 12, the reviewer App's alone wouldn't merge it, and every factory PR would
    wait for the admin. Dependabot's PRs are code-owned, so the admin approves them anyway. #68
    settles it with test (a) on a PR the factory App opened (as #101's run did with PR #199).
  - _Inference:_ none on the reviewer App, which approves PRs and never opens them, or on PRs that
    sessions open as `sssoto17`, a person.

When the CI/CD step's checks report, it adds this rule to `ruleset-main.json`, with the names the
step settles. Each check is pinned to GitHub Actions (`integration_id` 15368), so a commit status
made by hand can't satisfy it:

```json
{
	"type": "required_status_checks",
	"parameters": {
		"strict_required_status_checks_policy": false,
		"required_status_checks": [
			{ "context": "ci / typecheck", "integration_id": 15368 },
			{ "context": "guard / floor", "integration_id": 15368 },
			{ "context": "ci / test", "integration_id": 15368 }
		]
	}
}
```

(Three of the placeholders in area 2 are shown; the step lists all of them.)

**Applied 8 Nov, #40: the rule went into a ruleset of its own, not into `ruleset-main.json`** (the
admin's decision, 23:17 CET; why and the cost are in area 2). Read back on 12 Nov
(`gh api repos/sssoto17/sunny-pastures/rulesets/26816327`), as `ruleset-main-checks.json`:

```json
{
	"name": "main checks",
	"target": "branch",
	"enforcement": "active",
	"conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
	"bypass_actors": [],
	"rules": [
		{
			"type": "required_status_checks",
			"parameters": {
				"strict_required_status_checks_policy": false,
				"do_not_enforce_on_create": false,
				"required_status_checks": [
					{ "context": "ci / typecheck", "integration_id": 15368 },
					{ "context": "ci / lint", "integration_id": 15368 },
					{ "context": "ci / test", "integration_id": 15368 },
					{ "context": "guard / floor", "integration_id": 15368 }
				]
			}
		}
	]
}
```

No bypass actors: the API returns `current_user_can_bypass: "never"` for the admin's account, and
`GET …/rules/branches/main` lists `required_status_checks` from ruleset 26816327 and the other three
rules from 26810726. `do_not_enforce_on_create: false` is GitHub's default. Later required checks
are added to this ruleset, not to `main`.

---
status: proposed
---

# How the project uses GitHub

Sunny Pastures lives on GitHub: the code, the issues, the Project board and, from M3, CI and the
deploy hooks. Until now each piece was set up when it was first needed, and nothing protects
`main`. M2 starts on 9 Nov with the first production code in `packages/sim` and the factory, where
agents work `factory:ready` issues without the admin. Before that, this ADR settles how the repo,
the board and the platform are used, and in which order the admin turns things on.

This is a proposal. Nothing in it has been applied. The admin applies only what they approve, using
the checklist at the end. Files under `.github/` are a protected path, so their drafts sit in the
appendix and land in a later PR.

## How this was checked

The current state below was read on 7 Nov 2026 from the repo, `git log`, and the GitHub REST API
(read-only `GET` calls). Some things couldn't be read from this session. They are marked
**unread** and listed in Open questions.

- The repo API, rulesets, branch protection, labels, milestones, PRs, branches and tags were read.
- Environments, Actions permissions, secrets, Dependabot settings and webhooks were refused by the
  session's proxy (403). The Project (GraphQL) and the account's plan were not readable either.
- docs.github.com was blocked in this session. Feature availability was checked instead against
  the docs' source, the `github/docs` repository (`data/reusables/gated-features/*.md` and the
  articles named in each citation). Links point at the published pages. A claim marked
  *(not re-checked)* comes from memory of the docs and must be confirmed before it's applied.

**Checked locally on 7 Nov** (a second session on the admin's machine, `gh` with the `repo` and
`project` scopes, read-only `GET` and GraphQL queries only):

- Environments, Actions permissions, secrets, variables, Dependabot settings, webhooks,
  deployments and commit signatures were read from the REST API. Secrets and variables were
  listed by name and count only.
- The Project's workflows, views and fields were read through GraphQL.
- The account's plan couldn't be read by API: `gh api user --jq .plan.name` returns `null`,
  because the token lacks the `user` scope. The admin answered Q1 instead (below).
- docs.github.com, the `github/docs` source, GitHub's Terms of Service and Vercel's docs were
  read. Each marker that was resolved now carries its source and "checked 7 Nov". The markers
  left in place could not be confirmed from a primary source.

**The admin's answers, 7 Nov:**

- **Q1:** the account is on **GitHub Pro**, through a verified GitHub Education student account.
  The repo stays **private until about M3–M4**, then goes public (#38).
- **Q2:** the factory gets **its own identity**. How it reaches GitHub is spike #37 (area 2).
- **Q7 and Q8** are decided together when the repo goes public (#38).
- **Q9:** `area:tools` widens to cover all dev tooling (area 6).
- **Approvals:** PRs are reviewed the way people on GitHub review each other. A reviewer bot,
  its own GitHub App, **approves** a PR, which then auto-merges, or **requests changes**. The
  admin approves only sensitive paths (CODEOWNERS) and PRs an agent escalates with the label
  `review:admin`, for example a finished feature slice or a changed module interface (area 2).
- **Deploys:** once production is live, only a `v*` release tag ships to production, deployed by
  GitHub Actions; a merge to `main` reaches staging only. Bot-approved PRs keep auto-merging
  (area 4).
- **The merge guard** is for unattended sessions only, once #37 shows how to detect them;
  attended sessions are never blocked (area 2).

**The approval mechanics** were checked on 7 Nov against the `github/docs` source, the REST API
description (`github/rest-api-description`) and two community reports, each cited where it's
used in area 2. Whether a GitHub App's approval counts toward a required approval is not stated
in GitHub's docs; the checklist tests it once.

**GitHub Marketplace**, researched on 7 Nov from the vendors' pricing, terms and docs pages,
read-only. The summary is in area 9.

Areas 2–9 below were revised with these answers.

## The skill and AGENTS.md

Branching, commits, the PR flow, merge methods, versioning, tags, releases and the changelog
follow Addy Osmani's `git-workflow-and-versioning` skill (`.agents/skills/git-workflow-and-versioning/SKILL.md`,
cited below as "skill, *section*"). Where the skill and `AGENTS.md` disagree, `AGENTS.md` wins:

| # | Skill default | AGENTS.md rule | Resolution |
|---|---|---|---|
| C1 | Branches named `feature/…`, `fix/…`, `chore/…` (skill, *Branch Naming*) | One worktree per issue, named `<N>-<slug>` | The branch takes the worktree's name, `<N>-<slug>`. The type lives in the PR title, as `triage-labels.md` already says. |
| C2 | Worktrees beside the repo, `../project-feature-a` (skill, *Working with Worktrees*) | Worktrees under `.claude/worktrees/`; the main folder stays on `main` | `.claude/worktrees/<N>-<slug>`, already ignored by `.gitignore`. |
| C3 | Merge every branch within 1–3 days and delete it (skill, *Trunk-Based Development*, *Feature Branches*) | `prototype/*` branches are never merged | `prototype/*` is exempt from the lifetime and is kept as evidence. It is protected from deletion (area 2). |
| C4 | Pre-commit hygiene runs `npm test`, `npx tsc` and suggests husky with lint-staged (skill, *Pre-Commit Hygiene*) | pnpm only; ask before adding a dependency | `pnpm` equivalents. No husky or lint-staged unless the admin approves them as dependencies. CI is the gate. |
| C5 | The secret check is `git diff --staged \| grep -i "password\|secret\|api_key\|token"` (skill, *Pre-Commit Hygiene*) | Never print secret values | That grep prints the matching line, value and all. Use `git diff --staged \| grep -c -i -E '…'`: it prints a count, never the line. |
| C6 | The skill assumes a human reviewer approves every PR | `docs/diagrams/workflow.md`: "Every PR is merged by you, factory PRs included" | Superseded (area 2): a reviewer bot approves or requests changes, and the PR auto-merges on its approval; the admin approves sensitive paths and escalated PRs. `workflow.md` and `AGENTS.md` follow in a later PR (Consequences). |

One more departure is not an AGENTS.md conflict, but a repo decision that predates this ADR. The
skill warns that "squashing destroys the development narrative" (skill, *Common
Rationalizations*). `triage-labels.md` (#18) already makes the PR title the squash-commit message.
Area 3 keeps squash as the default and says why.

## 1. Git branching strategy

### Model

**Current state.** In effect trunk-based with short-lived branches, but without protection.
Of the 21 first-parent commits on `main`, 15 were pushed directly with no PR (for example
`8c6edbd` and `0231cdc` on 7 Nov). Six arrived through PRs (#3, #13, #14, #19, #26, #30). The
spike PRs (#20–#25, #27, #29) merged into `prototype/persistence`, which is never merged.

**Recommendation: adopt now. Trunk-based development with short-lived issue branches, and every
change to `main` through a PR.** `main` stays deployable: every merge deploys to staging, and
any commit on `main` can be tagged and shipped (area 4). A branch lives for one issue, which "fits one session" by the definition of ready,
so it lives hours to a day or two. This is the skill's recommended default (skill, *Trunk-Based
Development*). Incomplete player-facing work hides behind a flag rather than a long branch (skill,
same section), when it comes to that.

**Alternatives considered.**
- **GitHub flow** (branch, PR, merge to `main`, deploy). It is nearly the same thing. Trunk-based
  is named instead because it sets the lifetime limit and the "main is always deployable" rule
  that the factory needs.
- **git-flow** (`develop`, `release/*`, `hotfix/*`). Rejected: a long-lived `develop` is the
  "hidden cost" the skill warns about, and Vercel already gives each PR a preview, which is what a
  `develop` branch would be for.
- **Release branches for playtests.** Deferred: the skill accepts them "when you need to stabilize
  a release while main moves forward" (skill, *Trunk-Based Development*). A playtest runs on a
  tagged production deploy. If `main` must move during a playtest, a `release/v0.5` branch can be
  cut from the tag then.

### Branch names

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

- **Lifetime:** merge within 1–3 days (skill, *Feature Branches*). A branch older than 3 days is
  a sign the issue was too big: split it.
- **Updating from `main`:** merge `main` into the branch, or press GitHub's **Update branch**
  (a merge). A squash merge removes those merge commits from `main` anyway. Rebase only a branch
  no one else has fetched, and push it with `--force-with-lease`, never `--force`. Force-pushing
  a shared branch is a red flag in the skill (skill, *Red Flags*). The retro's stale local branch
  (15 commits behind) is avoided by always branching from `origin/main` after a fetch.
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

- Types: the skill's `feat`, `fix`, `refactor`, `test`, `docs`, `chore` (skill, *Descriptive
  Messages*), plus `spike` from `triage-labels.md`. A scope is optional: a package, an area or a
  doc (`sim`, `tracker`, `adr-0002`).
- One logical change per commit, about 100 lines, and over about 1,000 lines split it (skill,
  *Atomic Commits*, *Size Your Changes*). Refactors and features go in separate commits, ideally
  separate PRs (skill, *Keep Concerns Separate*).
- The PR title uses the same format. With squash merges it becomes the commit on `main`.

**Alternative considered:** free-form messages. Rejected: the PR-title check and the release notes
both read the prefix.

### Versioning, tags, releases and the changelog

**Current state.** No tags and no releases (`GET …/tags` and `…/releases` return empty).

**Recommendation: adopt at M4 (playable slice, 29 Nov).** Until something is deployed for people
outside the project, there is no consumer, and the skill ties versions to consumers (skill,
*Release & Versioning*). From M4 the playtesters and the examiners are consumers of a build.

- **SemVer, 0.x until hand-in.** One minor version per milestone that ships a build:
  `v0.4.0` (M4 playable slice), `v0.5.0` (M5 playtest 1), `v0.7.0` (M7 playtest 2 + freeze),
  `v1.0.0` (M9 hand-in). A fix during a playtest is a patch (`v0.5.1`). The minor number matches
  the milestone, so the tag says which milestone a build belongs to.
- **Annotated tags on `main`**, created by the admin at the milestone gate after `/ship` says go
  (`git tag -a v0.4.0 -m "…"`; skill, *Tag the release*). Tags are protected (area 2). **Pushing
  the tag is what ships it:** the `deploy` workflow sends a `v*` tag to production (area 4).
- **The tag is the source of truth** (skill, same section). `package.json` stays `private` with no
  hand-edited version. The app shows the version from the deploy's git ref.
- **A GitHub Release per tag**, with notes generated from `.github/release.yml` (appendix A6) and
  then edited by hand.
- **The changelog.** The skill wants a curated, human changelog grouped by Added / Changed / Fixed
  / Deprecated / Removed / Security, written with the change, not at release time (skill, *Keep a
  changelog written for humans*). Parallel factory PRs that all edit one `CHANGELOG.md` would
  conflict with each other all day. So each PR body has a **Changelog** line (player-facing
  impact, or "none"; appendix A2). The squash puts it into the commit on `main`. At the tag, the
  admin copies those lines into `CHANGELOG.md` under the version, grouped by impact, and into the
  Release. The entry is still written with the change, and the file still exists for readers.

**Alternatives considered.**
- **A tag per merge, or CalVer** (`2026.11.29`). Rejected: there's no consumer per merge, and a
  date says nothing about the milestone.
- **semantic-release or Changesets.** Rejected for now: a new dependency, and the skill says a
  changelog generated from raw commits "buries what matters".
- **No changelog, only Release notes.** Rejected: the report needs a readable history of what each
  playtest build changed, kept in the repo.

## 2. Rulesets and protection

**Current state.** Nothing protects anything. `GET …/rulesets` returns `[]`,
`GET …/branches/main/protection` returns 404 "Branch not protected", and `GET
…/rules/branches/main` returns `[]`. Anyone with write access, which includes every agent session,
can push to `main`, force-push it or delete it.

**The plan and the visibility (Q1, decided).** The account is on GitHub Pro (GitHub Education),
and the repo stays private until about M3–M4 (#38). Rulesets, protected branches and CODEOWNERS
work in private repos on GitHub Pro, Team or Enterprise
([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners);
checked 7 Nov against `github/docs` `gated-features/repo-rules.md`, `protected-branches.md`,
`code-owners.md`). So everything in this area works now. What only public visibility adds is in
areas 4 and 8.

**Recommendation: adopt now.** Rulesets, not classic branch protection: they can
be read by anyone with read access, several can stack, and they can target tags too
([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).

### Ruleset `main`

Target: the default branch. Enforcement: active.

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
| Bypass list | Repository admin, mode **"For pull requests only"** | The admin can merge a PR past a rule (a tier-H PR the admin wrote, or a red check during an outage) but can't push straight to `main`. Rulesets accept "Repository admins" as bypass actors with no organization condition; the "organization only" limit in the docs is for classic branch protection ([creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset), checked 7 Nov). |

**Placeholder required checks.** The names match the "Required check" column of
`CONSTRAINTS.md`'s "Enforced with numbers" table (on `main` since #45), which owns every
threshold. The bundle ratchet has no row in that table yet; it reports as `preview / bundle`.
The CI/CD step builds the checks (#40, #42).

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
| `guard / secrets` | the gitleaks CLI over the PR's commits (area 8) |
| `guard / code-scan` | Semgrep (area 8) |
| `preview / lighthouse`, `preview / axe`, `preview / bundle`, `preview / latency` | page performance, BASE-03 (axe), the bundle ratchet and BASE-04 (latency smoke), measured on the Vercel preview (below; #43) |
| `guard / pr-title` | the Conventional Commit prefix (`triage-labels.md`, automation candidate): a few lines of bash, no third-party action (area 9) |
| `guard / protected-paths` | fails an agent PR that touches `tests/acceptance/**` (MUST-15.2) |
| `guard / no-prototype` | fails a PR into `main` whose head is `prototype/*` (rulesets can't block a head branch) |

`ci / mutation` (Stryker) also runs and reports, but it is **not required**.

**Preview checks.** The `preview / …` checks measure the Vercel preview, so they start from
Vercel's deployment events. A PR that Vercel doesn't build would then never report, and a
required check that never reports blocks the merge. So each preview check also runs on the PR
itself. When no preview exists for the head commit (nothing deployable changed, or Vercel skipped
the build), it reports success and says "no preview, nothing to measure". The signal Vercel sends
for a skipped build is unverified until Vercel is connected (Q10). Previews sit behind Vercel's
Deployment Protection, so the checks send Vercel's automation bypass secret in the
`x-vercel-protection-bypass` header
([Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation),
checked 7 Nov). It's an Actions secret, set without echoing it (area 4). The preview checks
become required together with "Require deployments to succeed", at M4 (ruleset table above).

Every required check must report on **every** PR, so none of them may use a path filter: a check
that doesn't apply reports success and says why. A required check is matched by its **job name**,
not "workflow / job", so each job is named exactly as above, and no two jobs in any workflow share
a name ([troubleshooting rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules),
checked 7 Nov).

### Ruleset `prototype/*`

Target: `refs/heads/prototype/*`. Rules: restrict deletions, block force pushes. No PR
requirement, because M1 merged spike PRs into the prototype branch with custom merge subjects.
A prototype is evidence for an ADR (ADR-0001's results), so it must not vanish or be rewritten.
Merging it into `main` is blocked by `guard / no-prototype`.

### Ruleset `v*` tags

Target: tags matching `v*`. Rules: restrict creations, restrict updates, restrict deletions,
block force pushes. Bypass: Repository admin, **always**. Only the admin cuts a release; a tag
never moves once it exists (skill, *Tag the release*). A `v*` tag deploys to production (area 4),
so this ruleset guards production too. Until #37, every session holds this bypass (below).

### Ruleset `production`

Target: `refs/heads/production`, the branch Vercel treats as production so that `main` deploys
as staging (area 4). Rules: restrict creations, restrict updates, restrict deletions. No bypass:
nobody pushes it, and production ships only through the `deploy` workflow.

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
4. **Not OK:** the bot submits **Request changes**, with its blocking findings as line comments.
   The factory fixes them and pushes. The push dismisses any earlier approval, and the bot
   reviews again.
5. **Needs the admin:** an agent adds the label `review:admin` (below). The bot reviews but doesn't
   approve, and the PR waits for the admin.

| Need | Native GitHub feature |
|---|---|
| Nothing merges without an approval | `main` ruleset: **1** required approval |
| "Request changes" blocks the merge | Built in: "If someone chooses the **Request changes** option in a review, then that person must approve the pull request before the pull request can be merged" ([available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging), checked 7 Nov) |
| A new push needs a new review | Dismiss stale approvals when new commits are pushed |
| Sensitive paths need the admin | CODEOWNERS plus "Require review from Code Owners": the bot's approval meets the count, but only `@sssoto17` can meet code-owner review |
| Findings block until handled | Required conversation resolution: open line comments hold the merge |
| Reviews go somewhere | They *are* the PR's reviews: verdicts, summaries and line comments stay on the PR as the record, and as report data |
| Merge without a human | Auto-merge, turned on by the bot when it approves (area 3) |

**Two kinds of PR need the admin.** Below, "tier H" means either kind: a PR that waits for the
admin's approval.

- **Sensitive paths (CODEOWNERS, appendix A3):** `tests/acceptance/**` (MUST-15.1); `.github/**`,
  `.claude/**`, `.agents/**`; `AGENTS.md`, `CLAUDE.md`, `CONSTRAINTS.md`; `docs/adr/**`,
  `docs/requirements/**`; every `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and
  `vercel.json`; the configs that can weaken a check; migrations and RLS. GitHub enforces these:
  without the admin's approval, the PR doesn't merge.
- **Escalated PRs:** any agent, the factory or the reviewer bot, may add the label
  **`review:admin`** to a PR outside those paths (the admin's choice, 7 Nov). Escalate when a PR
  wraps up a feature slice, or changes a module's public interface (for example the exports of
  `packages/sim`, or an API contract), so the admin keeps ownership of how a module turns out.
  The reviewer bot may also escalate on its own judgement. **The bot never approves a PR that
  carries `review:admin`**, so with 1 required approval, the PR waits for the admin's. If the
  label arrives after the bot approved, the bot's review job runs again on the `labeled` event,
  dismisses its own approval and turns auto-merge off. Only the admin removes the label. The
  exact criteria live in `CONSTRAINTS.md` (#47, whose scope changes from tier numbers to these
  criteria and the size at which the bot asks for a split).
  - **Why a label and not "request review":** until #37, every agent acts as the admin, so the
    admin is the PR's author, and GitHub doesn't request a review from a PR's own author. That's
    widely reported as an API error; it isn't in the docs or tested here. The request would fail
    quietly, the bot would see no request and approve. A label works the same before and after
    #37. After #37, an agent may also request the admin's review, but the label stays the signal
    the bot checks.
  - Like the other safeguards before #37, nothing on GitHub stops an agent removing the label;
    that's held by instructions.

**The reviewer bot is its own GitHub App** (the admin's choice, 7 Nov), for example
`sunny-reviewer[bot]`, used from Actions. It runs Claude with the repo's review skills
(`code-review`, the standards and spec axes). It is a separate identity from the PR's author,
so its approval is not a self-approval, even while the factory still acts as the admin
(until #37). Its private key is an environment secret, handed only to the review job. It's set up
alongside the factory's App (#37), which also settles how Claude is billed in CI.

- **Does an App's approval count?** GitHub's docs say required approvals come from "reviewers
  with write permissions"
  ([about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-pull-request-reviews-before-merging),
  checked 7 Nov). They don't say so for Apps outright, and a community report says an App's
  approval counts only when it has `contents: write`
  ([discussion #211598](https://github.com/orgs/community/discussions/211598); unverified). So
  the App gets `pull_requests: write`, `contents: read` first, and the checklist's test PR shows
  whether its approval counts. If it doesn't, `contents: write` is the next step.
- **What it reads is untrusted.** The bot feeds text that the PR wrote to a model, so a PR could
  try to talk it into approving. It runs on `pull_request_target`, from `main`'s copy of the
  workflow, never runs PR code, and can't approve tier-H paths away. The required checks still
  run whatever it says.
- **Blocking and non-blocking findings.** Blocking findings are line comments plus Request
  changes. Suggestions go in the review's summary, so they don't hold the merge through
  conversation resolution.
- **Only this App approves.** Every other app keeps auto-approve off: CodeRabbit's
  `@coderabbitai approve`, Greptile's auto-approve, Renovate's `autoApprove`, "Copilot approvals".
  "Allow GitHub Actions to create and approve pull requests" stays off (area 8), so no other
  workflow can approve. Only `@sssoto17` is a code owner. This supersedes the Marketplace
  research's catch-all `* @sssoto17`, which would have sent every PR to the admin.

**A weakened bar is blocked, or goes to the admin (decided 7 Nov).** The ways a bar gets lowered
are listed once, in `CONSTRAINTS.md`, "Guarding the bar". `guard / floor` fails a PR that weakens
the bar, unless the same PR adds an Exceptions row to `CONSTRAINTS.md`. That file is code-owned,
so the PR then needs the admin's approval. One rule, with no commit-message escape hatch.

**Tuning** (the self-improving loop, `docs/diagrams/workflow.md`):

- log every revert of a bot-approved PR, with its paths and cause, as data for the report;
- when a bad bot approval happens twice, move the paths to CODEOWNERS or sharpen the
  escalation criteria (AGENTS.md);
- when escalated PRs keep coming back unchanged from the admin, loosen the criteria.

### The factory's identity (Q2)

**Decided:** the factory gets its own identity, so code-owner review and the tiers see a factory
PR as someone else's. How that identity reaches GitHub is spike #37. What's already known, from
the admin's earlier research (summarised in #37):

- A cloud session always acts as its owner. The cloud GitHub proxy swaps every credential for the
  owner's token, so a machine user's or an App's token set in a cloud session is ignored.
- GraphQL is closed in cloud sessions.

So the identity has to be a **GitHub App used from Actions**, on GitHub-hosted runners (minutes
cost money while the repo is private and are free once it's public, area 9) or on a self-hosted
runner. #37 decides which. An App needs no seat and no second account. It doesn't need to be a
code owner, since its PRs are what the admin approves. Its PRs start CI normally. A PR opened with
`GITHUB_TOKEN` would not: its runs wait for someone to approve them
([triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow),
`data/reusables/actions/actions-do-not-trigger-workflows.md`, checked 7 Nov).

**Until #37 lands, every session acts as `sssoto17`.** Cloud and local sessions alike, factory
or not, use the admin's account, so they hold the admin's "For pull requests only" bypass too.

- **Tier H is then held by instructions only.** GitHub doesn't let an author approve their own
  PR, so a tier-H PR merges only by bypass, and any session can use that bypass. An agent could
  merge its own change to `tests/acceptance/`, `.claude/` or the dependencies. GitHub can't tell
  that merge from the admin's.
- **Still better than today.** With the rulesets on, a direct push, a force-push and a merge with
  a red check are all blocked. The hole left is a deliberate bypass merge. Auto-merge doesn't use
  the bypass list, so a tier-H PR with auto-merge on waits for an approval and never merges by
  itself. A public reproduction shows this: a Repository admin in the bypass list turned on
  auto-merge, and the PR stayed at "Review required" until approved, while a direct merge went
  through ([community discussion #208718](https://github.com/orgs/community/discussions/208718),
  24 Sep 2026, read 7 Nov). Not stated in GitHub's docs.
- **The reviewer bot works unchanged:** it's a separate identity from the author, so its approval
  counts (area 2). Only the admin's own approval is blocked, on sensitive and escalated PRs.
- `guard / protected-paths` can't tell an agent from the admin by author, so it reads the
  `Co-Authored-By: Claude` / `Claude-Session:` trailers that agents add by instruction. With the
  App, it checks the author.

**A merge guard for unattended sessions only, once #37 shows how to detect them** (the admin's
decision, 7 Nov). A blanket guard is not wanted: attended sessions are never blocked, because
the admin already meets enough stops and prompts. If a guard exists, it is a `PreToolUse` hook in
the style of `block-branch-switch.sh` (#16) that applies only to unattended (factory) sessions and
denies:

- `gh pr merge`, including `--admin` and `--auto`;
- `gh api` calls to `…/pulls/N/merge`;
- turning on auto-merge (`gh api graphql` with `enablePullRequestAutoMerge`);
- the GitHub MCP server's merge tool, through a matcher on the tool's name;
- pushing a `v*` tag, which now ships to production (area 4).

Bot-approved PRs merge through auto-merge, which the reviewer App turns on in Actions, where the
hook doesn't apply. Like #16, it stops the honest mistake, not a determined workaround: a raw
`curl` or a script would get past a command pattern. **Unverified:** how a hook tells an
unattended session from an attended one (`permission_mode` in the hook input, an environment
variable such as `CLAUDE_CODE_REMOTE`, a routine against an interactive session), and whether
project hooks run in cloud sessions at all. Both are being researched and belong to #37. No issue
is filed for the guard now.

**The honest limit, until #37.** On GitHub an agent *is* the admin: same account,
same rights. A session could bypass-merge a tier-H PR or edit a ruleset. Only the agents'
instructions and the permission classifier stop that, not GitHub. Once the App lands, only the
admin's account can approve or bypass.

**MUST-15.1** ("CODEOWNERS entry and a ruleset on `main` requiring code-owner review") is met as
written once A3 and the `main` ruleset are in place.

**Alternatives considered.**
- **Classic branch protection.** Rejected: one rule per branch pattern, no tag targets, and
  rulesets replace it in GitHub's docs.
- **Bypass mode "Always" for the admin.** Rejected: it would let any session (same account) push
  straight to `main`, which is what happened 15 times so far.
- **No protection, rely on discipline.** Rejected: the factory removes the admin from the loop
  until merge, and a mistake that happens twice must become a check (AGENTS.md).
- **The admin approves every PR** (this ADR's first draft). Rejected by the admin: the admin
  becomes the factory's bottleneck.
- **Two tiers: the admin's paths, and auto-merge for everything else.** Rejected by the admin:
  too much would merge with no review at all.
- **Three tiers, with the agent's verdict as a required check** (this ADR's second draft: a
  `review / agent` check, a `guard / tier` check sorting PRs, and a no-review lane for small
  docs and CSS changes). Replaced by the admin: it removed the approval step. A real approval and
  Request changes are native, read like a conversation between teammates, and need neither
  custom check.
- **Copilot code review as the approving bot.** "Copilot approvals" is documented to count toward
  required approvals, but it needs a Copilot plan, spends AI credits and Actions minutes, and
  gives less control over what it checks. The admin chose an own App running the repo's skills.
- **`github-actions[bot]` as the approving bot** (`GITHUB_TOKEN`, with "Allow GitHub Actions to
  create and approve pull requests" on). No App to register, but then any workflow could
  approve, which GitHub's docs flag as a risk.
- **A reviewer machine user.** Native approvals, but it uses up the one free machine account the
  terms allow and needs a long-lived token. An App does the same without either.
- **A catch-all `* @sssoto17` in CODEOWNERS** (the Marketplace research). Superseded: it sends
  every PR to the admin.
- **A machine user for the factory** (the first draft's option a). The terms allow one, but a
  cloud session swaps its token for the owner's (#37), so an App from Actions does the same job
  without a second account
  ([Terms of Service, B. Account Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#b-account-terms),
  checked 7 Nov).

## 3. Merge methods

**Current state.** All three methods are enabled. Merge commits were used for #3, #26 and #30.
#13, #14 and #19 landed as single commits with one parent (squash; #19 shows `(#19)` in its
subject). Squash commits take the PR title for single-commit PRs and the commit messages as body
(`squash_merge_commit_title: COMMIT_OR_PR_TITLE`, `squash_merge_commit_message: COMMIT_MESSAGES`).
Merge commits are titled "Merge pull request #N from …" (`merge_commit_title: MERGE_MESSAGE`).
Auto-merge is off. "Always suggest updating branches" is on.

| | Merge commit | Squash | Rebase |
|---|---|---|---|
| History on `main` | Every branch commit, plus a merge commit. Readable with `git log --first-parent`. | One commit per PR, titled with the PR title. | Every commit, linear, no PR boundary. |
| The spike's evidence trail | Kept: the order of commits shows a rule was fixed before data existed (ADR-0001's pre-registration). | Lost on `main`. The PR keeps its commits on GitHub. | Kept, but rewritten: new SHAs and commit dates, so the trail is weaker. |
| Revert one PR | `git revert -m 1 <merge>` | `git revert <sha>` | Revert each commit, and find them first. |
| Agent WIP commits | All land on `main`. | Collapsed. | All land. |
| Fits the skill | Keeps atomic commits (skill, *Atomic Commits*). | The skill warns that squashing "destroys the development narrative". | Keeps atomic commits. |

**Recommendation: adopt now. Allow squash and merge commits; disable rebase. Squash is the
default.**

- **Squash for issue PRs** (almost all of them). One issue is one logical change of about
  100–300 lines, which is the skill's own size for a commit (skill, *Size Your Changes*). Agents
  commit save points as they work (skill, *The Save Point Pattern*), and those save points don't
  belong on `main` one by one. The PR keeps them on GitHub. The PR title becomes the commit
  (`triage-labels.md`), and per-PR revert is one command. This is where the proposal departs
  from the skill's "prefer clean incremental commits": the narrative stays in the PR and the
  issue, linked from the squash commit by `(#N)`.
- **Merge commits for evidence PRs**: a spike's results, an ADR whose decision rule was fixed
  before its data, or any PR whose commit order is itself the evidence. The PR body says
  "merge commit" and why.
- **Rebase merge: disabled.** It rewrites SHAs and dates, which weakens the evidence trail, and
  it loses the PR boundary for reverts.
- **Commit titles:** set both squash and merge commits to use the **PR title** and the **PR body**
  (`squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`,
  `merge_commit_title=PR_TITLE`, `merge_commit_message=PR_BODY`). Then `git log --first-parent
  --oneline main` reads as one Conventional Commit per PR, whichever method was used, and the PR
  body's `Closes #N`, verification and Changelog line land in git.
- **Linear history** is not required, because of the merge-commit exception. `--first-parent` is
  the readable view.
- **Auto-merge: turn on at repo level once the required checks exist and the reviewer App
  reviews, not before.** On a private repo it needs Pro, which the account has
  ([auto-merge](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)).
  Bot-approved PRs merge this way (area 2). Without required checks, an approved PR would merge
  before CI had run.
  - **Who turns it on: the reviewer App, when it approves.** Turning on auto-merge is GraphQL-only
    (`enablePullRequestAutoMerge`; the REST description has no endpoint for it, checked 7 Nov).
    GraphQL is closed in cloud sessions (#37), but not in Actions, where the App runs. The method
    is the one the PR template's "Merge method" line names: squash by default, a merge commit for
    evidence PRs.
  - **Sensitive and escalated PRs:** the admin approves, then merges or turns on auto-merge,
    keeping the choice of method. While the factory acts as the admin (until #37), the admin
    can't approve its PRs and merges them by bypass.
  - Auto-merge ignores the bypass list (area 2), so it never merges a PR that still lacks the
    admin's approval.
- **Merge queue: not available.** It exists only for organization-owned repos (public, or private
  on Enterprise Cloud)
  ([merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
  This repo belongs to a user.
- **Update branch: keep on** (merge-based). It's how an agent or the admin brings a stale PR up
  to date without force-pushing.

**Alternatives considered.**
- **Squash only, with linear history.** Simplest, and enforceable. Rejected because the next spike
  (or a playtest analysis) would lose its evidence trail on `main`.
- **Merge commits only.** Keeps everything, but every agent save point lands on `main`, and the
  first-parent subjects are "Merge pull request…" unless the title setting changes.
- **Rebase only.** Rejected above.

## 4. Environments

**Current state.** No environments, no secrets and no variables (checked 7 Nov: `GET
…/environments`, `…/actions/secrets`, `…/dependabot/secrets` and `…/actions/variables` each
return a count of 0). No workflows exist (`list_workflows` returns 0), so nothing deploys from
Actions. Vercel isn't connected yet: the repo has no deployments and no webhooks, and no PR has a
commit status or check run (checked 7 Nov on #19, #26, #30 and #35). Vercel and the hosted
Supabase projects don't exist yet (`docs/requirements/spec.md`, MUST-17).

**What GitHub offers on this plan.** Environments, environment secrets and deployment branches in
a private repo need Pro, Team or Enterprise. On Free, Pro and Team, required reviewers and wait
timers work **only in public repos**
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
- Vercel reports back to GitHub without any GitHub-side setup. It uses GitHub's Deployments API,
  so its preview deployments show in GitHub. By default each deployed commit also gets a commit
  status, and each PR gets a comment with its preview URL
  ([Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github), checked 7 Nov). The docs
  don't give the names of the GitHub environments those deployments use. Check them once Vercel
  is connected (Q10).

### Only a release tag ships to production (decided 7 Nov)

The admin's decision: once production is live, **a merge to `main` no longer deploys to
production. Only a `v*` release tag does, and GitHub Actions deploys it.** Tier-M PRs auto-merge
on an agent's review (area 2), so with deploy-on-merge, playtesters could get a change no human
had looked at. With deploy-on-tag, the admin's look at staging before tagging is the gate to
production. MUST-17.2 changes to match, in a later PR (Consequences).

| Where | Deployed by | Data |
|---|---|---|
| Each PR | Vercel's Git integration, as a preview (MUST-17.3) | staging Supabase |
| `main` | Vercel's Git integration, as a preview branch with its own fixed staging domain | staging Supabase |
| A `v*` tag on `main` | The `deploy` workflow in Actions | production Supabase |

- **`main` becomes staging.** Vercel lets a branch be a "preview phase" with its own domain and
  its own variables ([Git deployments, "Multiple preview phases"](https://vercel.com/docs/git),
  checked 7 Nov). For `main` to deploy as a preview, Vercel's production branch must be another
  branch: `production`, which nobody pushes (a ruleset blocks it, A8), with
  `"git": { "deploymentEnabled": { "production": false } }` in `vercel.json` as a backstop.
  That option takes branch names and turns off Vercel's deployments for them
  ([Git configuration](https://vercel.com/docs/project-configuration/git-configuration), checked
  7 Nov). *Not verified:* that Vercel accepts a production branch that never receives a push.
  Check when Vercel is connected (Q10). If it doesn't, set `deploymentEnabled` to false for
  `main` and have Actions deploy staging too. A merge that auto-merge makes may not start
  workflows (area 3), so that fallback needs the factory App's token.
- **Production deploys from a tag, in Actions.** The `deploy` workflow runs on `push` of tags
  `v*`, in the GitHub environment `production`, whose deployment policy admits only tags
  matching `v*` (the REST API takes `"type": "tag"` in a deployment policy, checked 7 Nov). It:
  1. checks out the tag, and fails unless the tagged commit is on `main`;
  2. runs the production migrations (the tool is settled at M3), so the schema ships with its
     code;
  3. runs `vercel pull --environment=production`, `vercel build --prod` and
     `vercel deploy --prebuilt --prod`, Vercel's documented pattern for Actions
     ([Using GitHub Actions with Vercel](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel),
     checked 7 Nov).
- **Who can ship.** Only the admin creates `v*` tags (the tag ruleset, area 2). Until #37, every
  session acts as the admin, so that holds by instructions only, like tier H. A guard for
  unattended sessions (area 2) should cover tag pushes too.
- **Rollback** is Vercel's Instant Rollback in the dashboard. A fix ships as a patch tag
  (`v0.5.1`, area 1).

**Recommendation.**

- **GitHub environment `production`: adopt at M4**, before the first tag deploys (checklist).
  Deployment policy: tags `v*` only. It holds `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID` and the production Supabase credentials. Vercel's guide stores them as
  repository secrets; environment secrets are stricter (below).
- **No `staging` GitHub environment** while Vercel deploys staging and holds its variables.
  Adopt one only if Actions runs staging migrations or deploys (the fallback above).
- **Required reviewers and wait timers** aren't available on a private repo on Pro (above). When
  the repo goes public (#38), add the admin as required reviewer on `production`, with "prevent
  self-review" off, since the admin pushes the tag that starts the deploy.
- **Environment secrets, not repo secrets, for anything that can reach production.** A repo
  secret is readable by any workflow run in the repo, including a run on an agent's PR branch,
  whose workflow file the PR itself can change. An environment secret is handed only to a job that
  names the environment, and the deployment policy limits `production` to `v*` tags
  ([deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
- **CI needs no secrets for MUST-17.1.** The acceptance tests run on a throwaway Supabase stack
  inside the runner.
- **Secrets are set without echoing them.** `gh secret set NAME --env production` prompts for the
  value without showing it. Never pass a value on the command line or print it (AGENTS.md).
  `.env.example` lists every name with a placeholder (MUST-17.4).

**Alternatives considered.**
- **Every merge to `main` deploys production** (MUST-17.2 as written, and this ADR's first draft,
  through Vercel's Git integration). Rejected by the admin: with bot-approved PRs auto-merging, nothing
  would stand between an agent-reviewed change and the players.
- **A `production` branch that Vercel deploys, moved to each tag by the admin.** No token in
  GitHub, but migrations would need their own trigger on that branch, and the order (migrate,
  then deploy) would rest on two systems. The admin chose Actions for control over that order.
- **A staged production build, promoted by hand.** Vercel builds `main` as production without
  serving it, and the admin promotes it
  ([promoting deployments](https://vercel.com/docs/deployments/promoting-a-deployment), checked
  7 Nov). Rejected: a staged build runs with production variables, so it can only be checked
  against production data, and migrations run before anyone has looked.
- **A `preview` GitHub Environment.** Skipped: Vercel's Preview scope is the preview environment.

## 5. The Project board and status automation

**Current state.** The Project (user project 3) has the fields in `issue-tracker.md`: Status,
Track, Mode, Size, Priority, Week. A new Project starts with "Item closed → Done" and "Pull
request merged → Done" turned on
([built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)).
Read through GraphQL on 7 Nov (`viewer.projectV2(number: 3) { workflows { name enabled } views
{ name layout filter … } }`):

- **All 8 workflows the API lists are on:** Auto-add sub-issues to project, Auto-add to project,
  Auto-archive items, Auto-close issue, Item added to project, Item closed, Pull request linked to
  issue, Pull request merged. The API doesn't expose a workflow's filter or the Status it sets.
- **Auto-add also adds PRs today.** All 12 closed and 8 open issues are on the Project, and so
  are 9 PRs. Eight of them (#23, #24, #25, #26, #27, #29, #30, #35) became items in the same
  minute they were opened.
- **No item is archived yet**, although Auto-archive is on.
- Views: see "Views" below.

### Built-in workflows

The workflow names below are the ones the API returns for this Project (checked 7 Nov). The docs
page doesn't name the workflows. Two rows (Item reopened, Code changes requested / Code review
approved) are names the API didn't return. If the Workflows page doesn't offer them, skip those
rows *(not re-checked in the UI)*.

| Workflow | Recommendation | Why |
|---|---|---|
| Auto-add to project | **On**, filter `is:issue` | On today, and it adds PRs too (above), so the filter changes. Every issue belongs on the Project (`issue-tracker.md`). Issues only: the issue is the work item, and a PR card would duplicate it. Free allows 1 auto-add workflow, Pro 5 ([adding items automatically](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)). Agents still add the item explicitly, and #32's script should treat "already on the Project" as success. |
| Item added to project | **On**, Status = Backlog | Matches "agents create issues in Backlog". On today; check in the UI that it sets Backlog. |
| Item reopened | **On**, Status = Backlog | A reopened issue isn't automatically the focus. Not in the API's list for this Project. |
| Item closed | **On**, Status = Done | `issue-tracker.md`: "In review → Done: the admin merged the PR, the issue closes, and the Project moves it." With the tiers, the merge may be the admin's or auto-merge's; the move is the same. On today. |
| Pull request merged | On (harmless) | Once auto-add takes issues only, PRs aren't added, so it rarely fires. |
| Pull request linked to issue | **Off for now** (on today) | It would set In review when the PR opens, but In review means "PR open *and* checks green". Revisit with #17. |
| Code changes requested / Code review approved | Off | Every PR now gets reviews from the reviewer bot; a review is not a Status change, and In review already means "PR open and checks green" (area 2). Not in the API's list for this Project. |
| Auto-close issue (Status set to Done closes the issue) | **Off** (on today) | Done must come from a merge or an explicit close, not a drag. |
| Auto-add sub-issues to project | On (on today) | Workstream sub-issues belong on the board. |
| Auto-archive items | **Off** (on today) | Closed items are the history the report draws on. Views filter them out instead ([archiving](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/archiving-items-automatically) archives existing matches immediately). |

### Who sets each Status

| Move | Set by | Stays manual? |
|---|---|---|
| → Backlog | The auto-add / item-added workflows | — |
| Backlog → Ready | **The admin**, always | Yes. Ready is the admin's chosen focus (`issue-tracker.md`). No automation ever sets Ready. |
| Ready → In progress | The session that starts the work, through #32's script, when it creates the branch | Automatable later with #17 (a `create` event Action; it needs a token with the `project` scope, because `GITHUB_TOKEN` can't edit a user-owned Project). |
| In progress → In review | The session, when the PR is open with `Closes #N` and checks are green | Later: an Action on `check_suite` completion, same token. Not before CI exists. |
| In review → Done | The built-in "Item closed" workflow, after the merge (auto-merge on the bot's approval, or the admin's merge for tier H) closes the issue | — |
| Any → Backlog | The admin, or an agent that finds the issue isn't ready (with a `blocked:*` label) | Yes. |

Mode stays in step with `factory:ready` by hand until the "Mode ↔ `factory:ready` sync" candidate
in `triage-labels.md` reaches 3 repetitions.

### Views

| View | Layout | Filter / grouping |
|---|---|---|
| This week (board) | Board by Status | `week:@current`; Done shows only items updated in the last 7 days |
| Roadmap | Roadmap | Group by Milestone, dates from Week |
| Week | Table | Group by Week (iteration), sort by Priority |
| Factory | Table | `mode:Factory` or `label:factory:ready`, Status ≠ Done |
| Blocked | Table | `label:blocked:*` |
| Triage | Table | `label:triage` |

**Views today** (read 7 Nov). Three of the six above already exist:

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

**Current state.** 19 labels exist, and their names and colours match `triage-labels.md` exactly
(7 `area:*`, 3 `blocked:*`, 6 types, `triage`, `factory:ready`). GitHub's default labels were
removed. No `wayfinder:*` labels exist yet, as the doc says. PR area labels are set by hand
(the retro counts 2+ repetitions).

**Labels as code: skip for now.** `triage-labels.md` is the source of truth, and the labels match
it today. A sync action would be a new dependency for 19 labels that rarely change. Adopt a
`gh label`-based script if the labels drift from the doc twice.

**Path labeler: adopt with the CI/CD step** (the retro's decision 5). The config in appendix A1
maps paths to `area:*` exactly as `triage-labels.md` defines them. The action is
`actions/labeler`, pinned to a commit SHA:

```yaml
- uses: actions/labeler@bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13 # v7.0.0
```

Checked on 7 Nov: tag `v7.0.0` (and the moving `v7`) points at commit
`bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13`, committed on 16 Jul 2026, 114 days ago. v7 changes
nothing in inputs or behaviour from v6 ("Migrated to ESM internally"), runs on `node24`, and uses
the v5+ config format (`changed-files` with `any-glob-to-any-file`). The Release was published on
21 Jul 2026, 109 days before 7 Nov, so it passes the 7-day rule (Q6, checked 7 Nov:
`gh api repos/actions/labeler/releases/tags/v7.0.0 --jq .published_at`; `git/ref/tags/v7.0.0`
and `git/ref/tags/v7` both still point at `bf12e9b…`). The previous release, `v6.2.0`, is commit
`b8dd2d9…` (6 Jul 2026, published 9 Jul 2026).

The labeler's limits:
- `tests/acceptance/` and `prototypes/<name>/` take the area of what they test, which a path
  can't say. They get no label from the labeler; the author adds one.
- `area:db` covers "the Drizzle schema, migrations, RLS". Those paths don't exist yet. The
  config guesses `apps/web/drizzle/**` and `apps/web/src/server/db/**`; fix them at M3. A schema
  file under `src/server/db/` gets both `area:api` and `area:db`, which is what "one area per area
  touched" means.
- `sync-labels` stays off, so the labeler adds and never removes. A label the admin removed by
  hand comes back only if new matching files are pushed.

**Q9, decided 7 Nov:** `area:tools` widens to all dev tooling: `tools/`, `scripts/`, `.claude/`
and `.agents/`. `area:ci-cd` keeps `.github/`, deploy config and root config. This PR updates the
table in `triage-labels.md` and the labeler config (A1) to match.

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

**Current state.** None exist. The community profile reports 14% health: no README, no
CONTRIBUTING, no issue or PR template, no licence.

| File | Recommendation | Why |
|---|---|---|
| Issue forms per type (`.github/ISSUE_TEMPLATE/*.yml`) | **Adopt** at M2 (appendix A4) | Each form asks for a goal and "Acceptance criteria", rule 2 of the definition of ready. It sets the type label and `triage`. Agents file through `gh issue create --body`, which bypasses forms, so the forms help the admin's web filing and show agents the expected body ([issue forms syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)). |
| `ISSUE_TEMPLATE/config.yml` | **Adopt**, blank issues **off** | Every issue needs a type. The setting affects only the web UI, not the API or `gh`. |
| PR template | **Adopt** at M2 (appendix A2) | Matches the skill's change summary (skill, *Change Summaries*: changes made, things not touched, concerns) and adds `Closes #N`, verification, protected paths, screenshots and the Changelog line (area 1). |
| CODEOWNERS | **Adopt** at M2 (appendix A3) | Defines tier H: the `main` ruleset requires the code owner's approval on these paths (area 2, MUST-15.1). Works on a private repo on Pro. |
| SECURITY.md | **Adopt** at go-public (#38, appendix A5) | From M4 the game is public on Vercel, and players and testers need a way to report a hole that isn't a public issue. While the repo is private, nobody outside can read the file. Once public, it points to private vulnerability reporting, so no email address is needed (Q8). |
| CONTRIBUTING.md | **Skip** | `AGENTS.md` and `docs/agents/` are the contributor guide, and they're the ones agents read. A second guide would drift. |
| README.md | **Adopt now**, as a separate docs issue | No README exists; the repo page is blank for examiners. Not a `.github/` file and not protected, so it doesn't wait for the `.github/` PR. Out of scope here. |
| `.github/release.yml` | **Adopt** at M4 (appendix A6) | Groups generated release notes by area label and leaves out chores ([generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)). |
| Discussions category forms | **Skip** | Discussions stay off (area 9). |
| Saved replies | **Skip** | They're per user account, not per repo, and solo review replies are rare ([saved replies](https://docs.github.com/en/get-started/writing-on-github/working-with-saved-replies/about-saved-replies)). |
| LICENSE | **At go-public (#38), Q7** | Chosen when the repo goes public, after checking EK's rules on student work. With none, all rights are reserved. |
| CODE_OF_CONDUCT.md, FUNDING.yml | Skip | No community and no funding. |
| `CITATION.cff` | Skip; reconsider at M8 | Only if the report wants the repo cited in a standard form. |
| Issue types | Skip | An organization feature; labels carry the type here. The docs describe issue types only per organization, set by organization owners ([managing issue types](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-types-in-an-organization)), and GraphQL returns `issueTypes: null` for this repo (checked 7 Nov). |
| Autolinks | Skip | Nothing external to link to (and Pro-only on private repos). |

## 8. Security and dependencies

**Current state.** Code scanning is off (`GET …/code-scanning/default-setup`: "not enabled").
Private vulnerability reporting returns 404. Checked 7 Nov: Dependabot alerts are off
(`GET …/vulnerability-alerts` returns 404), Dependabot security updates are off
(`…/automated-security-fixes`: `enabled: false`), and the repo's `security_and_analysis` field is
`null`, so no secret scanning setting exists for it.

What each feature needs, from `github/docs` `data/reusables/gated-features/` (re-read 7 Nov; every
row below matches the source):

| Feature | Private repo, user-owned | Public repo |
|---|---|---|
| Secret scanning | **Not available** (needs Secret Protection on an org, or Enterprise Managed Users) | Free, runs automatically |
| Push protection | Not available | On for users by default |
| Dependabot alerts | Available | Available |
| Dependabot security and version updates | Available | Available |
| Code scanning (CodeQL) | **Not available** (needs Code Security on an org) | Free |
| Dependency review | Not available | Free |
| Private vulnerability reporting | **Not available** | Free |

Pro doesn't change the private column for these features. Only visibility does. **Q1 is
decided:** private on Pro until about M3–M4, then public (#38). So rulesets, CODEOWNERS and
environments work now, and every row above that says "not available" arrives at go-public. Until
then, CI checks fill the gap: `guard / secrets` and `ci / audit` below.

**Recommendations.**

- **Secret scanning and push protection: adopt at go-public (#38).** Until then: the local
  safeguards (the `UserPromptSubmit` hook, `.gitignore` for `.env*`, the count-only staged-diff
  check in C5), plus **the gitleaks CLI as the required check `guard / secrets`**, adopted with
  the CI/CD step (#42). It runs `gitleaks git --redact --no-banner` over the PR's commit range
  (`--log-opts="<base>..<head>"`), in a checkout with the full history fetched. `detect` and
  `protect` have been deprecated since v8.19.0
  ([gitleaks README](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md), v8.30.1,
  checked 7 Nov). `--redact` keeps any secret it finds out of the log. The CLI is MIT-licensed
  and is downloaded from its release and checked against the published checksums, with no
  third-party action (Marketplace research, area 9). Before the switch, the same CLI scans the
  full history (#38).
- **The pnpm 12 lockfile limits Dependabot here** (checked 7 Nov). "When pnpm writes
  `pnpm-lock.yaml` as two YAML documents, the dependency graph does not detect the dependencies in
  that file. This is the default format for pnpm 12 projects that pin a pnpm version. Dependabot
  version updates still work, but Dependabot alerts and Dependabot security updates are not
  created for those dependencies"
  ([supported ecosystems, "pnpm"](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories#pnpm)).
  This repo pins `pnpm@12.15.0` in `package.json`, and its `pnpm-lock.yaml` already has two
  documents (two `---` separators; the first holds the pinned pnpm itself). So alerts and
  security updates below won't cover the npm dependencies while that format holds. Version
  updates will.
- **`pnpm audit --audit-level=high` as the required check `ci / audit`: adopt with the CI/CD step
  (decided 7 Nov).** It reads pnpm's own lockfile, so it covers what the dependency graph can't.
  It's part of pnpm, so it adds no dependency and no action. No `--fix` in CI. Its advisory
  source isn't named in its help text (not verified). **osv-scanner** stays only if #42 proves it
  reads the lockfile's second document, which holds the dependencies. The first holds only pnpm
  itself.
- **Semgrep as the required check `guard / code-scan`: adopt with the CI/CD step (#42).** Like
  gitleaks, it needs an "Allowed actions" entry or a checksum-verified download, and so does
  osv-scanner if it's kept.
- **Dependabot alerts: adopt now.** Free on private repos. No noise until there are dependencies.
  For npm dependencies, see the pnpm 12 limit above.
- **Dependabot security updates: adopt at M2**, when `packages/sim` brings dev dependencies.
  Security updates ignore cooldowns
  ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown)),
  so a fix can be younger than 7 days, and `pnpm install` will refuse it under
  `minimumReleaseAge`. That's intended: the PR shows the alert, and the admin decides. The
  setting is never lowered (AGENTS.md). For npm dependencies, see the pnpm 12 limit above.
- **Dependabot version updates: adopt at M3**, only with `cooldown: default-days: 7` (matching
  `minimumReleaseAge`), `versioning-strategy: increase` (exact pins stay exact), weekly, grouped,
  for the `npm` ecosystem (pnpm v7–v12 are listed; support for pnpm 11 and 12 arrived on 20 Oct
  2026) and `github-actions` (it updates the version comment of a SHA-pinned action when the
  comment is on the same line)
  ([supported ecosystems](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories),
  checked 7 Nov). Dependabot's PRs come from `dependabot[bot]`, a separate identity, and pass the
  same required checks. They change `package.json` or the lockfile, so they're tier H, and the
  admin approves them (area 2). Dependabot never adds a dependency, so the "ask
  before adding" rule isn't touched. Draft in appendix A7.
- **Code scanning (CodeQL default setup): adopt at go-public (#38).** Not available while
  private. Whether Semgrep stays the required code scan and CodeQL runs as advice, or the other
  way round, is decided at go-public (Q13).
- **Private vulnerability reporting: adopt at go-public (#38)**; `SECURITY.md` points to it, so
  no contact address is needed (Q8).
- **Dependency review: skip while the lockfile is pnpm 12's two-document format**, even once
  public. It reads the same dependency graph that can't see that lockfile, so it would miss the
  npm dependencies (an inference from the dependency-graph limit, not tested). #38 lists it; drop
  it there or revisit if the format changes.
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
  - Allowed actions: **"Allow sssoto17, and select non-sssoto17, actions and reusable
    workflows"**, with GitHub-created actions allowed and an explicit list for the rest (for
    example `supabase/setup-cli@*`, `pnpm/action-setup@*`) as the CI/CD step adds them. Today
    it's "local only", which blocks GitHub-authored actions such as `actions/checkout` and
    `actions/labeler`, so this must change before the first workflow runs.
  - **Every action pinned to a full commit SHA with a version comment**, as above. Turn on
    "Require actions to be pinned to a full-length commit SHA". The setting exists (the REST
    field `sha_pinning_required`, off today;
    [REST: Actions permissions](https://docs.github.com/en/rest/actions/permissions), checked
    7 Nov). The 7-day rule applies to actions too: pin a release at least 7 days old.
  - `pull_request_target` only for jobs that never run PR code: the labeler and the reviewer
    App's review job. The review job holds the App's key and feeds text the PR wrote to a model,
    so its guard against prompt injection is designed with it (area 2).

**Alternatives considered.**
- **Go public now**, for free scanning from M2. Rejected by the admin (Q1): the repo stays
  private until about M3–M4. The CI checks above cover the gap until then.
- **Renovate** instead of Dependabot. Rejected: a GitHub App with its own config and permissions,
  for the same job. Dependabot is built in and has the cooldown option.
- **Disabling Dependabot security updates** to respect the 7 days strictly. Rejected: the admin
  should see the fix and decide; refusing it silently hides a known vulnerability.

## 9. Everything else on the platform

| Feature | Decision | Reason |
|---|---|---|
| **Actions** in general | **Adopt** with the CI/CD step | MUST-17.1. The pipeline's design is that step's job, not this ADR's. This ADR sets the permissions it runs under (area 8) and the checks' names (area 2). Cost: a private repo draws on a monthly included compute amount, now given in US dollars, not minutes ($12 on Free, $18 on Pro). Standard GitHub-hosted runners are free in public repos ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), checked 7 Nov). **Until go-public, the factory spends that $18 a month.** Stryker, the Lighthouse runs, Semgrep and the acceptance stack on every factory PR need an estimate or a cap before unattended factory work starts. `CONSTRAINTS.md` adds a cost criterion to #40. |
| **Releases** | **Adopt** at M4 | Area 1: one per shipped milestone tag. |
| **Insights** | **Use**, read-only | Pulse, commit and PR graphs feed the report's process chapter. On a private repo the graphs need Pro (`gated-features/repository-insights.md`). |
| **Pages** | Skip | Vercel hosts the game; the docs live in the repo. Off today. |
| **Wiki** | Skip (off today) | Docs belong in `docs/`, versioned with the code, where agents read them. |
| **Discussions** | Skip (off today) | Solo project. Playtest feedback goes through forms into `triage` (`docs/diagrams/workflow.md`). |
| **Codespaces / dev container** | Defer; reconsider if the examiners need to run the project | Local WSL plus cloud sessions cover the admin. A dev container would pin Node 24, pnpm and the Supabase CLI for a reader. |
| **GitHub Packages** | Skip | Nothing is published; `packages/sim` is a workspace package. |
| **Copilot code review** | Skip | The reviewer is an own App running the repo's skills (area 2). "Copilot approvals" stays off: an approval from it would count toward the required approval ([Copilot code review](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review), checked 7 Nov). |
| **Copilot cloud agent** | Skip | The factory is Claude Code (#37). |
| **Notifications** | Adopt | Watch the repo as "Participating and @mentions" plus Actions failures, so CI failures on factory PRs reach the admin. A user setting. |
| **Topics** | Adopt now | None set. Suggested: `idle-game`, `typescript`, `nextjs`, `supabase`, `deterministic-simulation`, `bachelor-project`. |
| **Description** | Keep | Already set and accurate. |
| **Social preview** | At go-public (#38) | Only shown for public repos. |
| **A container for the load test and CI** | Out of scope | Not a GitHub feature. Design issue #39 (M3). |

### GitHub Marketplace

Researched on 7 Nov from each vendor's pricing, terms and docs pages, and each action's releases
(read-only; nothing installed). Every third-party action also needs "Allowed actions" widened
(area 8) and a SHA pin at least 7 days old.

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

| Pattern | Where | Why |
|---|---|---|
| Trunk-based development | Area 1 | `main` always deployable; short branches limit merge risk (skill). |
| Policy as code | Rulesets, CODEOWNERS, `labeler.yml`, `dependabot.yml`, `release.yml` | The rules live in versioned config that the platform enforces, instead of in memory. |
| Peer review by a bot | The reviewer App approves or requests changes; code-owner review and escalation bring in the admin (area 2) | Reviews read like a conversation on the PR, and the admin's attention goes where it counts. |
| Quality gate | Required checks pinned to Actions (area 2) | A change reaches `main` only through named checks, whoever approved it. |
| Least privilege | Read-only `GITHUB_TOKEN`, environment secrets scoped to `main`, admin bypass for PRs only | Each actor gets only the rights its job needs. |
| Convention over configuration | `<N>-<slug>` branches, Conventional Commit titles | Tools (#17's parser, the PR-title check, release notes) can rely on the shape. |
| Single source of truth | Tags for versions, `triage-labels.md` for labels, the issue for Status | One place to change; the others read from it. |
| Release gate | A `v*` tag deploys production; `main` deploys staging (area 4) | Merging and shipping are separate decisions, so auto-merge can't reach the players. |

The main alternatives are recorded per area. The ones that shaped the whole proposal:

- **Who gates a PR:** the admin on every PR, auto-merge on everything outside the admin's paths,
  three tiers with the agent's verdict as a check, or **a reviewer bot that approves or requests
  changes, with the admin on sensitive and escalated PRs** (area 2). The admin chose the last.
- **One GitHub identity for everyone** (today) against **a factory App from Actions** (area 2, Q2,
  #37). Until #37 lands, tier H rests on the admin's bypass and the agents' instructions.
- **Deploy on merge** against **deploy on a release tag** (area 4). The admin chose the tag, so
  bot-approved PRs can auto-merge to `main` without reaching the players.
- **Private on Pro now, public at M3–M4** (Q1, #38) against **public now**. It decides when
  GitHub's scanning arrives; CI checks cover the gap.
- **Squash-only with linear history** against **squash plus merge commits** (area 3). The
  evidence trail tipped it.

## Consequences

- Once the `main` ruleset is on, **nothing reaches `main` without a PR**, including the
  coordinating session's retros and rule edits, which were pushed directly until now (15 of 21
  commits). Retros merge on the reviewer bot's approval. Rule edits (`AGENTS.md`, `CLAUDE.md`)
  are tier H.
- Required checks can't be added until CI reports them. Until the CI/CD step, the ruleset blocks
  direct pushes, force-pushes and deletion and requires code-owner review on tier H, and
  auto-merge stays off.
- **The admin is no longer the merge gate for every PR, but is the gate to production.**
  Bot-approved PRs merge without the admin and reach staging only. Production changes only when the
  admin pushes a `v*` tag (area 4). Bad auto-merges are caught on staging and by the tuning loop
  (area 2), and their reverts are report data.
- **Production deploys need a token in GitHub:** `VERCEL_TOKEN` and the production Supabase
  credentials live in the `production` environment, which only `v*` tags can use (area 4).
- **Knock-on edits, for later PRs (not made here):**
  - `docs/diagrams/workflow.md`: "Every PR is merged by you, factory PRs included" and the
    "review and merge" step become the tiers (C6).
  - `docs/agents/issue-tracker.md`: "In review → Done: the admin merged the PR" becomes "the PR
    merged".
  - `docs/requirements/spec.md`, MUST-17.2: "A merge to `main` deploys to Vercel production"
    becomes "a `v*` release tag on `main` deploys to Vercel production on the hosted Supabase
    project; a merge to `main` deploys to staging" (area 4). `docs/requirements/` is tier H.
  - `AGENTS.md`: a short rule on reviews. Agents never merge, never turn on auto-merge by hand,
    never bypass a ruleset, never remove `review:admin`, and add it when a PR wraps up a feature
    slice or changes a module's interface; the admin merges tier H in the UI.
  - `CONSTRAINTS.md`: its line "ADR-0002 owns the mechanism: the `guard / tier` check and which
    tiers may auto-merge" follows the new model, and #47's scope changes to the escalation
    criteria and the split size.
- MUST-15.1 is met as written once CODEOWNERS (A3) and the `main` ruleset are in place. **Until
  #37, tier H is held by instructions only:** every session acts as `sssoto17` and holds the
  bypass (area 2). The App closes that gap; a guard for unattended sessions only would narrow it
  once #37 shows how to detect them.
- **Rollout order** (checklist): rulesets now, with the bypass → the reviewer App, and its test
  PR → auto-merge only after the required checks exist and the App reviews → unattended factory work only once #37 gives the
  factory its own identity, or shows how to guard unattended sessions. Attended sessions are
  never blocked.
- `CONSTRAINTS.md` owns the escalation criteria and the split size (#47) and the list of ways a
  bar gets lowered ("Guarding the bar"). This ADR owns the mechanism.
- **Actions cost.** While private, the checks draw on Pro's included compute, about $18 a month
  (area 9). The heavy checks (Stryker, Lighthouse, Semgrep, the acceptance stack) need an
  estimate or a cap before the factory runs unattended; `CONSTRAINTS.md` adds the criterion to
  #40.
- **Ratchets can drift** while "branches up to date" is off: two PRs can each pass the bundle or
  coverage ratchet and together go past it. Accepted: the next PR's run catches it (area 2).
- `.github/` files (templates, CODEOWNERS, labeler, the review workflow, Dependabot, release
  notes) land in later PRs by the admin, because `.github/` is tier H.
- #32's script must treat "already on the Project" as success while auto-add is on.
- The PR template's Changelog line is the input for `CHANGELOG.md` at each tag from M4.
- Go-public (#38) brings scanning, CodeQL, private vulnerability reporting, `SECURITY.md`, the
  licence and the environment reviewer, after a full-history secret scan.

## Open questions for the admin

Q1–Q9 are answered or decided (see "How this was checked"). Q10 waits for Vercel, Q11 for #47,
Q12 for the CI/CD step and Q13 for go-public.

1. **Q1, plan and visibility.** *Decided 7 Nov:* GitHub Pro (GitHub Education); private until
   about M3–M4, then public (#38).
2. **Q2, factory identity.** *Decided 7 Nov:* its own identity, a GitHub App used from Actions.
   Where it runs is spike #37 (area 2).
3. **Q3, Project state.** *Answered.* All 8 built-in workflows the API lists are on, including
   Auto-archive, Auto-close issue and Pull request linked to issue, which this ADR turns off.
   Auto-add is on and adds PRs as well as issues; its filter isn't readable through the API.
   Seven views exist; This week, Roadmap and Triage match this ADR (area 5).
4. **Q4, Actions and Dependabot settings.** *Answered.* Actions enabled, allowed actions "local
   only", SHA pinning not required, default token permissions read, Actions can't create or
   approve PRs. Dependabot alerts off, security updates off. Note the pnpm 12 lockfile limit on
   alerts and security updates (area 8).
5. **Q5, environments and secrets.** *Answered.* No environments, no repo or Dependabot secrets,
   no Actions variables. Cloud-session commits are signed (verified); local commits aren't
   (area 2).
6. **Q6, labeler release date.** *Answered.* v7.0.0 was published on 21 Jul 2026, 109 days ago,
   and the tag still points at `bf12e9b…` (area 6).
7. **Q7, licence.** *Decided at go-public (#38)*, after checking EK's rules on student work.
8. **Q8, security contact.** *Decided:* none needed. At go-public, `SECURITY.md` points to
   private vulnerability reporting (#38).
9. **Q9, `.agents/` and dev tooling.** *Decided 7 Nov:* `area:tools` covers `tools/`,
   `scripts/`, `.claude/` and `.agents/` (area 6; updated in `triage-labels.md` and A1).
10. **Q10, Vercel's GitHub deployments.** *Open until Vercel is connected.* Vercel isn't connected
    yet (no deployments, webhooks, statuses or checks on 7 Nov). Vercel's docs confirm it uses
    GitHub's Deployments API and posts a commit status per deployment (area 4). Once connected,
    check the names it uses on PRs before deciding on "Require deployments to succeed". Also
    check that Vercel accepts `production` as its production branch with no pushes, so `main`
    deploys as staging (area 4), and what it reports when it skips a preview build (area 2).
11. **Q11, the escalation criteria.** *In #47.* When an agent adds `review:admin`, and
    the size at which the bot asks for a split, in `CONSTRAINTS.md`. The sensitive paths are A3.
12. **Q12, the reviewer bot.** *Decided 7 Nov:* its own GitHub App running Claude with the repo's
    review skills (area 2). Whether its approval counts with `contents: read` is tested once
    (checklist); how Claude is billed in CI is #37.
13. **Q13, Semgrep or CodeQL as the required code scan.** *At go-public (#38).* Semgrep is
    required from the CI/CD step; when CodeQL becomes available, one of them stays required and
    the other runs as advice (area 8).

## Admin checklist

In order. **[.github]** marks a change that is a file under `.github/`, for a later PR, not this
one. Every `gh api` call below writes a setting and prints no secret. Run them from the main folder
outside the sandbox (`docs/agents/sandbox.md`). Q1 and Q2 are decided, so nothing waits on them.

1. **Merge settings** (area 3). UI: Settings → General → Pull Requests. Auto-merge stays off
   until step 12.
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
3. **Ruleset `main`** (area 2), with code-owner review and stale-approval dismissal on. UI:
   Settings → Rules → Rulesets → New branch ruleset. The JSON is in appendix A8 (`actor_id: 5`
   is the Repository admin role *(not re-checked: the REST reference doesn't list role IDs;
   GitHub's own rulesets in `github/docs` use `actor_id: 5`, `RepositoryRole` for their bypass,
   checked 7 Nov)*; check the bypass list in the UI after creating it).
   ```sh
   gh api -X POST repos/sssoto17/sunny-pastures/rulesets --input ruleset-main.json --jq '.id'
   ```
4. **Ruleset `prototype/*`** and **ruleset `v*` tags** (appendix A8), same call with their files.
   From here until #37, every session holds the bypass the `main` ruleset gives the admin
   (area 2).
5. **Project workflows** (area 5). UI only: the Project → ⋯ → Workflows. All 8 are on today
   (7 Nov). Turn off Auto-archive items, Auto-close issue and Pull request linked to issue; set
   auto-add's filter to `is:issue` (it adds PRs today); check that Item added to project sets
   Backlog. Turn on Item reopened only if the page offers it.
6. **Project views** (area 5). UI only: the Project → New view. This week, Roadmap and Triage
   exist; add Week, Factory and Blocked, and the 7-day limit on Done in This week.
7. **Dependabot alerts** now (area 8); off today. They won't cover npm dependencies while the
   lockfile uses pnpm 12's two-document format (area 8). UI: Settings → Code security →
   Dependabot alerts.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/vulnerability-alerts --silent
   ```
8. **Actions permissions** (area 8), before the first workflow. UI: Settings → Actions → General.
   Today (7 Nov) allowed actions is "local only" and SHA pinning isn't required; the token
   default (read) and the PR-approval setting (off) already match, so the third call only
   confirms them.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions --silent \
     -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions/selected-actions --silent \
     -F github_owned_allowed=true -F verified_allowed=false
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions/workflow --silent \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
   ```
9. **[.github] The templates PR** (M2): `ISSUE_TEMPLATE/*.yml` and `config.yml` (A4),
   `pull_request_template.md` (A2), `CODEOWNERS` (A3), with the tier-H list from #34. The admin's
   PR, not an agent's. Then **test tier H once**: open a throwaway PR that changes one line of
   `AGENTS.md`, check that the merge box asks for the code owner's review, and close the PR
   unmerged. That confirms code-owner review on this repo (area 2).
10. **M2: Dependabot security updates** (area 8); off today. Same pnpm 12 limit as alerts.
    UI: Settings → Code security.
    ```sh
    gh api -X PUT repos/sssoto17/sunny-pastures/automated-security-fixes --silent
    ```
11. **No unattended factory work until #37** (area 2). Until #37 gives the factory its own
    identity, or shows how a hook can tell an unattended session from an attended one, the
    factory runs only with the admin watching. If a guard for unattended sessions follows, the
    admin adds it under `.claude/hooks/` and registers it in `.claude/settings.json`, which
    sessions can't write. Attended sessions are never blocked.
12. **CI/CD step:** **[.github]** `labeler.yml` and its workflow (A1); the CI workflows and the
    review workflow (area 2). Register the reviewer App (with #37's factory App): permissions
    `pull_requests: write`, `contents: read`; its key as an environment secret. **Test it once:**
    on a throwaway PR outside CODEOWNERS, check that its approval satisfies the required
    approval. If it doesn't, raise it to `contents: write` and test again. Create the label
    (`gh label create review:admin --color C5DEF5 --description "Needs the admin's review"`). Add the
    required checks to the `main` ruleset as they start reporting, each with GitHub Actions as
    its source (Settings → Rules → the ruleset → Require status checks; A8). At M4, the preview
    checks need Vercel's automation bypass secret as an Actions secret (area 2), set with
    `gh secret set` so it's never shown. Turn on auto-merge **only once** the required checks
    report and the reviewer App's approval is shown to count:
    ```sh
    gh api -X PATCH repos/sssoto17/sunny-pastures --silent -F allow_auto_merge=true
    ```
13. **M3:** **[.github]** `dependabot.yml` (A7). The `production` environment waits for step 15.
    A `staging` environment only if Actions runs staging migrations or deploys (area 4).
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
    - In Vercel: the production branch set to `production`, `main` given the staging domain and
      the staging variables. UI: the Vercel project → Settings → Environments.
    - `vercel.json` with `deploymentEnabled` off for `production`, in a PR of the admin's
      (`vercel.json` is tier H, A3).
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

"area:ui":        # apps/web/ outside src/server/: pages, components, client state
  - changed-files:
      - any-glob-to-any-file:
          - "apps/web/*"
          - "apps/web/!(src)/**"
          - "apps/web/src/*"
          - "apps/web/src/!(server)/**/!(route.*)"

"area:api":       # apps/web/src/server/, route handlers
  - changed-files:
      - any-glob-to-any-file:
          - "apps/web/src/server/**"
          - "apps/web/src/app/**/route.{ts,tsx,js}"

"area:sim":
  - changed-files:
      - any-glob-to-any-file: "packages/sim/**"

"area:db":        # supabase/, the Drizzle schema, migrations, RLS (Drizzle paths: fix at M3)
  - changed-files:
      - any-glob-to-any-file:
          - "supabase/**"
          - "apps/web/drizzle/**"
          - "apps/web/src/server/db/**"
          - "**/drizzle.config.*"

"area:ci-cd":     # .github/, deploy config, root config
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

"area:tools":     # all dev tooling: tools/, scripts/, .claude/, .agents/
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
  pull_request_target:          # config read from main; never checks out PR code
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

```markdown
<!-- Title: <type>(<scope>): <summary>, e.g. feat(sim): ripen crops by elapsed time.
     The title and this body become the commit on main. -->

Closes #

## What and why

<!-- One logical change. What it does, and why this way. -->

## Changes made

- `path`: what changed

## Not touched (intentionally)

- `path`: why it's out of scope

## How it was verified

<!-- Commands run and their result. Paste output with secrets masked. -->

- [ ] `pnpm …`

## Review

<!-- ADR-0002, area 2. The reviewer bot reviews every PR. -->

- [ ] Touches a path in CODEOWNERS, and the admin asked for it: <!-- which, and where they asked -->
- [ ] Wraps up a feature slice or changes a module's interface: labelled `review:admin`

## Concerns

<!-- Assumptions to confirm, risks, follow-ups. "None" is an answer. -->

## Screenshots

<!-- UI changes: before and after, desktop and phone width (BASE-02). Delete otherwise. -->

## Changelog

<!-- One line of player-facing impact, starting with Added / Changed / Fixed / Removed / Security,
     or "none". Copied into CHANGELOG.md at the next tag. -->

## Merge method

<!-- Squash (default). Merge commit only for evidence PRs: say why. -->
```

## A3. `.github/CODEOWNERS`

```
# Tier H (ADR-0002, area 2): a PR that touches any of these needs the admin's approval,
# because the main ruleset requires code-owner review. Tuned with CONSTRAINTS.md (#34).
# Only @sssoto17 is a code owner; never add a bot or an app.
/tests/acceptance/      @sssoto17
/.github/               @sssoto17
/.claude/               @sssoto17
/.agents/               @sssoto17
/AGENTS.md              @sssoto17
/CLAUDE.md              @sssoto17
/CONSTRAINTS.md         @sssoto17
/docs/adr/              @sssoto17
/docs/requirements/     @sssoto17
**/package.json         @sssoto17
/vercel.json            @sssoto17
/pnpm-workspace.yaml    @sssoto17
/pnpm-lock.yaml         @sssoto17
/supabase/config.toml   @sssoto17
/supabase/migrations/   @sssoto17
# Drizzle migrations and RLS: add the folder at M3, when it exists.

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
Fallow names cover their usual config files. Check them against the files that land, since a
config under another name would go to the reviewer bot only.

GitHub reads CODEOWNERS from the PR's base branch, so a PR can't remove its own paths from tier H
([about code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).

## A4. Issue forms

`.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: false
```

Each form sets its type label plus `triage`; the area is added when the issue is evaluated
(`triage-labels.md`). Milestone and Project fields are set on the Project (auto-add puts the issue
there).

`.github/ISSUE_TEMPLATE/feature.yml`:

```yaml
name: Feature
description: New behaviour for the player, the admin or the API
labels: [feature, triage]
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
      description: ADRs, glossary terms, code areas and issues to read first. Blockers go in native dependencies.
```

`.github/ISSUE_TEMPLATE/bug.yml`:

```yaml
name: Bug
description: Something that worked, or was specified, behaves wrongly
labels: [bug, triage]
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
      description: Include the farm seed or action log if the sim is involved, and the browser for UI bugs.
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
body:
  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: The decisions to make, and the issues they block (add those as native dependencies).
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

Sunny Pastures is a student project (EK PBA Webudvikling, 2026–27). Only the latest deployed
version is supported.

## Reporting a vulnerability

Please don't open a public issue. Report it privately with "Report a vulnerability" on the
repository's Security tab.

Expect a reply within a few days. Cheating that works against the server (forged time, replayed
or invented actions) counts as a vulnerability.
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

A PR with several area labels is listed once, under the first category that matches. Dependabot
PRs stay in, so security bumps show in the notes.

## A7. `.github/dependabot.yml` (M3)

```yaml
version: 2
updates:
  - package-ecosystem: npm            # pnpm uses the npm ecosystem
    directory: /
    schedule: { interval: weekly }
    versioning-strategy: increase     # exact pins stay exact
    cooldown:
      default-days: 7                 # matches minimumReleaseAge in pnpm-workspace.yaml
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
        "required_approving_review_count": 1,
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
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

One approval is required: the reviewer App's, or the admin's on sensitive and escalated PRs
(area 2). Neither App is in any bypass list (#37).

When the CI/CD step's checks report, it adds this rule to `ruleset-main.json`, with the names
the step settles. Each check is pinned to GitHub Actions (`integration_id` 15368), so a commit
status made by hand can't satisfy it:

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

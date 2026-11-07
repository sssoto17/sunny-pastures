---
status: proposed
---

# How the project uses GitHub

Sunny Pastures lives on GitHub: the code, the issues, the Project board and, from M3, CI and the
deploy hooks. Until now each piece was set up when it was first needed, and nothing protects
`main`. M2 starts on 9 Nov with the first production code in `packages/sim` and the factory, where
agents work `factory:ready` issues without the admin. Before that, this ADR settles how the repo,
the board and the platform are used, and in which order the admin turns things on.

This is a proposal. Nothing in it has been applied. The admin applies only what he approves, using
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
| C6 | "Only the admin merges" isn't in the skill; it assumes a reviewer approves | Only the admin merges PRs to `main` | The admin's merge is the review gate (area 2). |

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
change to `main` through a PR.** `main` stays deployable (MUST-17.2 deploys every merge to
production). A branch lives for one issue, which "fits one session" by the definition of ready,
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
  (`git tag -a v0.4.0 -m "…"`; skill, *Tag the release*). Tags are protected (area 2).
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

**First: the plan and the visibility.** The repo is **private**. Rulesets, protected branches and
CODEOWNERS work in private repos only on GitHub Pro, Team or Enterprise
([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).
On GitHub Free they work only in public repos. The account's plan couldn't be read. The GitHub
Student Developer Pack includes Pro *(not re-checked)*. This is **open question Q1**, and it
decides much of this ADR (see area 8 for what public visibility adds).

**Recommendation: adopt now (if Q1 allows).** Rulesets, not classic branch protection: they can
be read by anyone with read access, several can stack, and they can target tags too
([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).

### Ruleset `main`

Target: the default branch. Enforcement: active.

| Rule | Setting | Why |
|---|---|---|
| Restrict deletions | on | `main` can't be deleted. |
| Block force pushes | on | History on `main` is never rewritten (skill, *Red Flags*). |
| Require a pull request before merging | on, **0** required approvals | Every change goes through a PR, so CI runs on it (MUST-17.1). Approvals: see below. |
| ↳ Require conversation resolution | on | An open review thread blocks the merge. It turns `code-review` findings left as comments into a gate. |
| ↳ Allowed merge methods | merge, squash | Area 3. |
| Require status checks to pass | **added later**, when CI reports them | Placeholders below. A required check that never reports blocks every merge, so none are added before the CI/CD step. |
| ↳ Require branches to be up to date | off for now | With parallel factory PRs and no merge queue (area 3), strict mode means updating and rerunning CI after every merge. Turn on if a broken `main` from two green PRs happens twice (the self-improving rule). |
| Require linear history | **off** | Area 3 keeps merge commits for evidence PRs. |
| Require signed commits | off | Agent commits from cloud sessions may not be signed *(unread)*. It would block them for little gain in a solo repo. |
| Require deployments to succeed | off; revisit at M4 | Could require the Vercel preview to deploy before merge. |
| Bypass list | Repository admin, mode **"For pull requests only"** | The admin can merge a PR past a rule (for example, a red check on a docs-only PR during an outage) but can't push straight to `main`. |

**Placeholder required checks** (names fixed by the CI/CD step; thresholds from `CONSTRAINTS.md`, #34):

| Placeholder | Covers |
|---|---|
| `ci / typecheck` | MUST-17.1 |
| `ci / lint` | MUST-17.1, plus any lint thresholds in `CONSTRAINTS.md` |
| `ci / test` | unit and property tests, coverage threshold (MUST-17.1) |
| `ci / determinism` | the determinism gate (MUST-17.1) |
| `ci / acceptance` | acceptance tests on a throwaway stack (MUST-15.3, MUST-17.1) |
| `guard / protected-paths` | fails an agent PR that touches `tests/acceptance/**` (MUST-15.2) or another protected path |
| `guard / pr-title` | the Conventional Commit prefix (`triage-labels.md`, automation candidate) |
| `guard / no-prototype` | fails a PR into `main` whose head is `prototype/*` (rulesets can't block a head branch) |

### Ruleset `prototype/*`

Target: `refs/heads/prototype/*`. Rules: restrict deletions, block force pushes. No PR
requirement, because M1 merged spike PRs into the prototype branch with custom merge subjects.
A prototype is evidence for an ADR (ADR-0001's results), so it must not vanish or be rewritten.
Merging it into `main` is blocked by `guard / no-prototype`.

### Ruleset `v*` tags

Target: tags matching `v*`. Rules: restrict creations, restrict updates, restrict deletions,
block force pushes. Bypass: Repository admin, **always**. Only the admin cuts a release; a tag
never moves once it exists (skill, *Tag the release*).

### Gating factory PRs without approvals

Required approvals can't work here. **Every PR so far was opened by `sssoto17`**, including the
ones agents wrote, because agents act through the admin's account. GitHub doesn't let an author
approve their own PR, so one required approval would block every PR, and the admin would bypass
every time.

So a factory PR is gated by:

1. **Required checks** (when CI exists): the five `ci / …` checks and the `guard / …` checks.
2. **The admin's merge.** Only the admin merges. Auto-merge stays off at repo level (area 3), so
   no session can queue a merge for later.
3. **Conversation resolution.** Review findings left as threads block the merge until resolved.

**The honest limit.** On GitHub, an agent *is* the admin: same account, same token rights. A ruleset
can't tell them apart. "Only the admin merges" and "agents don't bypass" are enforced by the
agents' instructions and the permission classifier, not by GitHub. The ruleset still stops the
mechanical mistakes: a direct push, a force-push, a merge with a red check.

**Does CODEOWNERS add anything?** Not with one account. "Require review from Code Owners" would
need an approval the author can't give. MUST-15.1 asks for exactly that ("CODEOWNERS entry and a
ruleset on `main` requiring code-owner review"), which can't be met as written. This is **open
question Q2**. Two ways out:

- **(a) A separate factory identity** *(recommended at M2 if the admin accepts a second account)*.
  The factory works as a machine user (or a GitHub App) with the Write role. Then the `main`
  ruleset can require 1 approval and code-owner review, with the admin role in the bypass list
  "for pull requests only". A factory PR can't merge until the admin approves or bypasses it.
  The admin's own PRs merge by bypass. MUST-15.1 and "only the admin merges" become real GitHub
  rules, and `guard / protected-paths` can test "is the author the factory?" instead of guessing
  from a branch name. Cost: a second account, its token as a secret in the factory's environment,
  and setup time. GitHub's terms allow one free machine account per person *(not re-checked)*.
- **(b) Keep one identity** and amend MUST-15.1 to "a CI check plus the admin's merge enforce it".
  `guard / protected-paths` then can't tell an agent from the admin by author, so it needs another
  signal: the `Co-Authored-By: Claude` / `Claude-Session:` trailers on the PR's commits, which
  agents add by instruction. Weaker, but no new account.

Either way, CODEOWNERS is still worth adding as a file (appendix A3): it documents the protected
paths in the place GitHub reads, and it starts enforcing the moment option (a) is chosen.

**Alternatives considered.**
- **Classic branch protection.** Rejected: one rule per branch pattern, no tag targets, and
  rulesets replace it in GitHub's docs.
- **Bypass mode "Always" for the admin.** Rejected: it would let any session (same account) push
  straight to `main`, which is what happened 15 times so far.
- **No protection, rely on discipline.** Rejected: the factory removes the admin from the loop
  until merge, and a mistake that happens twice must become a check (AGENTS.md).

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
- **Auto-merge: keep off.** On a private repo it needs Pro
  ([auto-merge](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)).
  More to the point, any session could enable it on a PR, and the PR would merge without the admin.
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

**Current state.** **Unread** (the proxy refused `GET …/environments`). No workflows exist
(`list_workflows` returns 0), so nothing deploys from Actions. Vercel and the hosted Supabase
projects don't exist yet (`docs/requirements/spec.md`, MUST-17).

**What GitHub offers on this plan.** Environments, environment secrets and deployment branches in
a private repo need Pro, Team or Enterprise. On Free, Pro and Team, required reviewers and wait
timers work **only in public repos**
([managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments);
gating text in `github/docs` `data/reusables/gated-features/environments.md`).

**Vercel covers most of MUST-17 by itself** *(not re-checked: Vercel's docs weren't read here)*.
Its Git integration builds a preview for every PR and deploys `main` to production, and it keeps
its own environment variables per scope (Production, Preview, Development). So:

- **MUST-17.2** (merge to `main` deploys production) and **MUST-17.3** (each PR gets a preview
  on the staging Supabase project) are Vercel settings: production variables point at the
  production Supabase project, preview variables at staging. No GitHub Environment is needed.
- Vercel reports its deployments back to GitHub as deployments named after its environments, so
  they show on the PR without any GitHub-side setup *(not re-checked)*.

**Recommendation.**

- **Skip GitHub Environments while only Vercel deploys.** Duplicating Vercel's variables in GitHub
  would be two copies of each secret.
- **Adopt at M3** (first migrations against a hosted Supabase project), *if* Actions runs the
  migrations or anything else that needs deploy credentials:
  - `staging`: deployment branches = any branch; holds the staging project's credentials.
  - `production`: deployment branches = `main` only; holds the production project's credentials.
  - Required reviewers and wait timers: not available on a private repo (above). If the repo goes
    public (Q1), add the admin as required reviewer on `production`, with "prevent
    self-review" off, since he triggers the merge himself.
- **Environment secrets, not repo secrets, for anything that can reach production.** A repo
  secret is readable by any workflow run in the repo, including a run on an agent's PR branch,
  whose workflow file the PR itself can change. An environment secret is handed only to a job that
  names the environment, and the deployment branch policy limits `production` to `main`
  ([deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
- **CI needs no secrets for MUST-17.1.** The acceptance tests run on a throwaway Supabase stack
  inside the runner.
- **Secrets are set without echoing them.** `gh secret set NAME --env production` prompts for the
  value without showing it. Never pass a value on the command line or print it (AGENTS.md).
  `.env.example` lists every name with a placeholder (MUST-17.4).

**Alternatives considered.**
- **GitHub Actions deploys to Vercel** (Vercel CLI with a token) instead of Vercel's Git
  integration. Rejected for now: more secrets and more pipeline for the same result. Left to the
  CI/CD step if Actions must deploy in a fixed order (migrate, then deploy).
- **A `preview` GitHub Environment.** Skipped: Vercel's Preview scope is the preview environment.

## 5. The Project board and status automation

**Current state.** The Project (user project 3) has the fields in `issue-tracker.md`: Status,
Track, Mode, Size, Priority, Week. The built-in workflows, views and their filters are **unread**
(GraphQL is blocked here). On 6 Nov a new issue was already on the Project when an agent tried to
add it, which suggests the auto-add workflow is on. A new Project starts with "Item closed → Done"
and "Pull request merged → Done" turned on
([built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)).

### Built-in workflows

The workflow names below are from memory of the Project's Workflows page *(not re-checked)*;
only the two defaults, auto-add and auto-archive were checked against the docs.

| Workflow | Recommendation | Why |
|---|---|---|
| Auto-add to project | **On**, filter `is:issue` | Every issue belongs on the Project (`issue-tracker.md`). Issues only: the issue is the work item, and a PR card would duplicate it. Free allows 1 auto-add workflow, Pro 5 ([adding items automatically](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)). Agents still add the item explicitly, and #32's script should treat "already on the Project" as success. |
| Item added to project | **On**, Status = Backlog | Matches "agents create issues in Backlog". |
| Item reopened | **On**, Status = Backlog | A reopened issue isn't automatically the focus. |
| Item closed | **On**, Status = Done | "In review → Done: the admin merged the PR, the issue closes, and the Project moves it." |
| Pull request merged | On (harmless) | PRs aren't added, so it rarely fires. |
| Pull request linked to issue | **Off for now** | It would set In review when the PR opens, but In review means "PR open *and* checks green". Revisit with #17. *(Workflow name not re-checked.)* |
| Code changes requested / Code review approved | Off | No reviews in a solo repo (area 2). |
| Auto-close issue (Status set to Done closes the issue) | Off | Done must come from a merge or an explicit close, not a drag. |
| Auto-add sub-issues to project | On, if offered | Workstream sub-issues belong on the board. *(Not re-checked.)* |
| Auto-archive items | **Off** | Closed items are the history the report draws on. Views filter them out instead ([archiving](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/archiving-items-automatically) archives existing matches immediately). |

### Who sets each Status

| Move | Set by | Stays manual? |
|---|---|---|
| → Backlog | The auto-add / item-added workflows | — |
| Backlog → Ready | **The admin**, always | Yes. Ready is the admin's chosen focus (`issue-tracker.md`). No automation ever sets Ready. |
| Ready → In progress | The session that starts the work, through #32's script, when it creates the branch | Automatable later with #17 (a `create` event Action; it needs a token with the `project` scope, because `GITHUB_TOKEN` can't edit a user-owned Project). |
| In progress → In review | The session, when the PR is open with `Closes #N` and checks are green | Later: an Action on `check_suite` completion, same token. Not before CI exists. |
| In review → Done | The built-in "Item closed" workflow, after the admin's merge closes the issue | — |
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

The workflow doc already refers to the "This week" board, so that view probably exists **(unread)**.

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
the v5+ config format (`changed-files` with `any-glob-to-any-file`). The Release page's publish
date couldn't be read (the API and github.com pages were refused here), so **Q6** asks the admin
to confirm it's older than 7 days. The previous release, `v6.2.0`, is commit `b8dd2d9…`
(6 Jul 2026).

The labeler's limits:
- `tests/acceptance/` and `prototypes/<name>/` take the area of what they test, which a path
  can't say. They get no label from the labeler; the author adds one.
- `area:db` covers "the Drizzle schema, migrations, RLS". Those paths don't exist yet. The
  config guesses `apps/web/drizzle/**` and `apps/web/src/server/db/**`; fix them at M3. A schema
  file under `src/server/db/` gets both `area:api` and `area:db`, which is what "one area per area
  touched" means.
- `sync-labels` stays off, so the labeler adds and never removes. A label the admin removed by
  hand comes back only if new matching files are pushed.

The globs were checked with `minimatch` 9.0.9 (the matcher the action uses, with `dot: true`)
against sample paths: a route handler `apps/web/src/app/api/action/route.ts` gets only `area:api`,
`apps/web/src/app/page.tsx` only `area:ui`, `.claude/settings.json` `area:ci-cd`, and
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
| CODEOWNERS | **Adopt** (appendix A3) | Documents protected paths. Enforces only with option (a) in area 2. Needs Pro on a private repo. |
| SECURITY.md | **Adopt** at M4 (appendix A5) | From M4 the game is public on Vercel. Players and testers need a way to report a hole that isn't a public issue. |
| CONTRIBUTING.md | **Skip** | `AGENTS.md` and `docs/agents/` are the contributor guide, and they're the ones agents read. A second guide would drift. |
| README.md | **Adopt now**, as a separate docs issue | No README exists; the repo page is blank for examiners. Not a `.github/` file and not protected, so it doesn't wait for the `.github/` PR. Out of scope here. |
| `.github/release.yml` | **Adopt** at M4 (appendix A6) | Groups generated release notes by area label and leaves out chores ([generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)). |
| Discussions category forms | **Skip** | Discussions stay off (area 9). |
| Saved replies | **Skip** | They're per user account, not per repo, and solo review replies are rare ([saved replies](https://docs.github.com/en/get-started/writing-on-github/working-with-saved-replies/about-saved-replies)). |
| LICENSE | **Open question Q7** | Needed only if the repo goes public. With none, all rights are reserved. |
| CODE_OF_CONDUCT.md, FUNDING.yml | Skip | No community and no funding. |
| `CITATION.cff` | Skip; reconsider at M8 | Only if the report wants the repo cited in a standard form. |
| Issue types | Skip | An organization feature; labels carry the type here *(not re-checked)*. |
| Autolinks | Skip | Nothing external to link to (and Pro-only on private repos). |

## 8. Security and dependencies

**Current state.** Code scanning is off (`GET …/code-scanning/default-setup`: "not enabled").
Private vulnerability reporting returns 404. Dependabot alerts, security updates and secret
scanning settings are **unread** (403 or absent from the repo API).

What each feature needs, from `github/docs` `data/reusables/gated-features/`:

| Feature | Private repo, user-owned | Public repo |
|---|---|---|
| Secret scanning | **Not available** (needs Secret Protection on an org, or Enterprise Managed Users) | Free, runs automatically |
| Push protection | Not available | On for users by default |
| Dependabot alerts | Available | Available |
| Dependabot security and version updates | Available | Available |
| Code scanning (CodeQL) | **Not available** (needs Code Security on an org) | Free |
| Dependency review | Not available | Free |
| Private vulnerability reporting | **Not available** | Free |

Pro doesn't change the private column for these features. Only visibility does. So Q1 is really
two choices: **(A) public**, which unlocks every row above plus rulesets and CODEOWNERS on Free;
or **(B) private on Pro**, which gets rulesets, CODEOWNERS and environments but none of the
scanning. If the school's rules allow a public repo during assessment, (A) gives the stronger
setup for free. History would need a secret scan before the switch (Q1).

**Recommendations.**

- **Secret scanning and push protection: adopt the moment the repo is public.** While private,
  the safeguards stay local: the `UserPromptSubmit` hook, `.gitignore` for `.env*`, and the
  count-only staged-diff check (C5). A CI secret scanner (for example gitleaks) is a new
  dependency, so it's for the admin to approve in the CI/CD step.
- **Dependabot alerts: adopt now.** Free on private repos. No noise until there are dependencies.
- **Dependabot security updates: adopt at M2**, when `packages/sim` brings dev dependencies.
  Security updates ignore cooldowns
  ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown)),
  so a fix can be younger than 7 days, and `pnpm install` will refuse it under
  `minimumReleaseAge`. That's intended: the PR shows the alert, and the admin decides. The
  setting is never lowered (AGENTS.md).
- **Dependabot version updates: adopt at M3**, only with `cooldown: default-days: 7` (matching
  `minimumReleaseAge`), `versioning-strategy: increase` (exact pins stay exact), weekly, grouped,
  for the `npm` ecosystem (pnpm; v12 support is listed for pnpm *(version gate not re-checked)*)
  and `github-actions` (it keeps SHA pins with their version comments up to date *(not
  re-checked)*). Dependabot's PRs come from `dependabot[bot]`, a separate identity, and pass the
  same required checks; the admin merges them. Dependabot never adds a dependency, so the "ask
  before adding" rule isn't touched. Draft in appendix A7.
- **Code scanning (CodeQL default setup): adopt at M2 if public**, when TypeScript lands in
  `packages/sim`; it becomes a required check then. Skip if private (not available).
- **Private vulnerability reporting: adopt if public**; SECURITY.md points to it. If private,
  SECURITY.md points to a contact address (Q8).
- **Actions permissions** (all **unread**; set before the first workflow lands):
  - Default `GITHUB_TOKEN` permissions: **read** repository contents. Each workflow raises only
    what it needs per job (`pull-requests: write` for the labeler).
  - "Allow GitHub Actions to create and approve pull requests": **off**. It's off by default for a
    personal repo
    ([Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).
    Check it's still off.
  - Allowed actions: **"Allow sssoto17, and select non-sssoto17, actions and reusable
    workflows"**, with GitHub-created actions allowed and an explicit list for the rest (for
    example `supabase/setup-cli@*`, `pnpm/action-setup@*`) as the CI/CD step adds them.
  - **Every action pinned to a full commit SHA with a version comment**, as above. If the
    settings page offers "Require actions to be pinned to a full-length commit SHA", turn it on
    *(not re-checked)*. The 7-day rule applies to actions too: pin a release at least 7 days old.
  - `pull_request_target` only for the labeler, which never checks out PR code.

**Alternatives considered.**
- **Stay private with no scanning and no plan.** Rejected only if Q1 allows something better. The
  local safeguards are real, but nothing on GitHub catches a pushed secret.
- **Renovate** instead of Dependabot. Rejected: a GitHub App with its own config and permissions,
  for the same job. Dependabot is built in and has the cooldown option.
- **Disabling Dependabot security updates** to respect the 7 days strictly. Rejected: the admin
  should see the fix and decide; refusing it silently hides a known vulnerability.

## 9. Everything else on the platform

| Feature | Decision | Reason |
|---|---|---|
| **Actions** in general | **Adopt** with the CI/CD step | MUST-17.1. The pipeline's design is that step's job, not this ADR's. This ADR sets the permissions it runs under (area 8) and the checks' names (area 2). Minutes: private repos have a monthly quota by plan; public repos don't use it on standard runners *(not re-checked)*. |
| **Releases** | **Adopt** at M4 | Area 1: one per shipped milestone tag. |
| **Insights** | **Use**, read-only | Pulse, commit and PR graphs feed the report's process chapter. On a private repo the graphs need Pro (`gated-features/repository-insights.md`). |
| **Pages** | Skip | Vercel hosts the game; the docs live in the repo. Off today. |
| **Wiki** | Skip (off today) | Docs belong in `docs/`, versioned with the code, where agents read them. |
| **Discussions** | Skip (off today) | Solo project. Playtest feedback goes through forms into `triage` (`docs/diagrams/workflow.md`). |
| **Codespaces / dev container** | Defer; reconsider if the examiners need to run the project | Local WSL plus cloud sessions cover the admin. A dev container would pin Node 24, pnpm and the Supabase CLI for a reader. |
| **GitHub Packages** | Skip | Nothing is published; `packages/sim` is a workspace package. |
| **Copilot code review, Copilot agent** | Skip | The workflow uses Claude Code skills for review; two reviewers would duplicate findings. |
| **Notifications** | Adopt | Watch the repo as "Participating and @mentions" plus Actions failures, so CI failures on factory PRs reach the admin. A user setting. |
| **Topics** | Adopt now | None set. Suggested: `idle-game`, `typescript`, `nextjs`, `supabase`, `deterministic-simulation`, `bachelor-project`. |
| **Description** | Keep | Already set and accurate. |
| **Social preview** | Skip while private | Only shown for public repos. Reconsider with Q1. |

## Patterns and alternatives considered

| Pattern | Where | Why |
|---|---|---|
| Trunk-based development | Area 1 | `main` always deployable; short branches limit merge risk (skill). |
| Policy as code | Rulesets, CODEOWNERS, `labeler.yml`, `dependabot.yml`, `release.yml` | The rules live in versioned config that the platform enforces, instead of in memory. |
| Quality gate | Required checks + the admin's merge | A change reaches `main` only through named checks and one human decision. |
| Least privilege | Read-only `GITHUB_TOKEN`, environment secrets scoped to `main`, admin bypass for PRs only | Each actor gets only the rights its job needs. |
| Convention over configuration | `<N>-<slug>` branches, Conventional Commit titles | Tools (#17's parser, the PR-title check, release notes) can rely on the shape. |
| Single source of truth | Tags for versions, `triage-labels.md` for labels, the issue for Status | One place to change; the others read from it. |

The main alternatives are recorded per area. The ones that shaped the whole proposal:

- **One GitHub identity for everyone** (today) against **a separate factory identity** (area 2,
  Q2). It decides whether "only the admin merges" is a GitHub rule or an instruction.
- **Private on Pro** against **public on Free** (Q1). It decides whether scanning exists.
- **Squash-only with linear history** against **squash plus merge commits** (area 3). The
  evidence trail tipped it.

## Consequences

- Once the `main` ruleset is on, **nothing reaches `main` without a PR**, including the
  coordinating session's retros and rule edits, which were pushed directly until now (15 of 21
  commits). They become small docs PRs that the admin merges. That's more steps per day, and the
  price of a protected `main`.
- Required checks can't be added until CI reports them. Until the CI/CD step, the ruleset blocks
  direct pushes, force-pushes and deletion, and nothing else.
- If Q2 stays at one identity, "only the admin merges" remains an instruction, and MUST-15.1 must
  be reworded in `docs/requirements/spec.md`.
- `.github/` files (templates, CODEOWNERS, labeler, Dependabot, release notes) land in one later
  PR by the admin, because `.github/` is a protected path for agents.
- #32's script must treat "already on the Project" as success while auto-add is on.
- The PR template's Changelog line is the input for `CHANGELOG.md` at each tag from M4.
- If the repo goes public, the history should be scanned for secrets first, and a licence chosen.

## Open questions for the admin

1. **Q1, plan and visibility.** Is the account on GitHub Pro (for example through the Student
   Developer Pack)? May the repo be public during the project and the assessment? Without Pro or
   public visibility, rulesets, CODEOWNERS, environments and auto-merge don't work at all. If it
   goes public: scan the history for secrets first (secret scanning will also run on push).
2. **Q2, factory identity.** One account for everyone (MUST-15.1 reworded), or a machine user /
   GitHub App with the Write role for the factory (MUST-15.1 met with required code-owner review)?
3. **Q3, Project state.** Which built-in workflows and views are on today? Is auto-add on, with
   which filter? (Not readable here.)
4. **Q4, Actions and Dependabot settings.** Current default token permissions, allowed actions,
   the PR-approval setting, Dependabot alerts and security updates. (Not readable here.)
5. **Q5, environments and secrets.** Do any environments, repo secrets or variables exist? (Not
   readable here.) Does the agents' cloud environment sign commits?
6. **Q6, labeler release date.** Confirm on github.com/actions/labeler/releases that v7.0.0 was
   published at least 7 days ago (its commit is from 16 Jul 2026).
7. **Q7, licence** if the repo goes public.
8. **Q8, security contact** for SECURITY.md if the repo stays private.
9. **Q9, `.agents/`.** `triage-labels.md` gives `area:ci-cd` to `.github/`, `.claude/` and root
   config, but doesn't name `.agents/` (the vendored skills). Add it there? The labeler config
   follows the doc, so it leaves `.agents/` unlabelled until then.
10. **Q10, Vercel's GitHub deployments.** Once Vercel is connected, check that previews and
    production show as deployments on PRs (area 4), before deciding on "Require deployments to
    succeed".

## Admin checklist

In order. **[.github]** marks a change that is a file under `.github/`, for the later PR, not this
one. Every `gh api` call below writes a setting and prints no secret. Run them from the main folder
outside the sandbox (`docs/agents/sandbox.md`), after Q1 is settled.

1. **Decide Q1 and Q2.** Plan: github.com → Settings → Billing and plans. Visibility: repo →
   Settings → General → Danger Zone → Change visibility.
2. **Merge settings** (area 3). UI: Settings → General → Pull Requests.
   ```sh
   gh api -X PATCH repos/sssoto17/sunny-pastures --silent \
     -F allow_squash_merge=true -F allow_merge_commit=true -F allow_rebase_merge=false \
     -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
     -f merge_commit_title=PR_TITLE -f merge_commit_message=PR_BODY \
     -F allow_auto_merge=false -F allow_update_branch=true -F delete_branch_on_merge=true
   ```
3. **Topics** (area 9). UI: repo home → About → gear.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/topics --silent \
     -f 'names[]=idle-game' -f 'names[]=typescript' -f 'names[]=nextjs' \
     -f 'names[]=supabase' -f 'names[]=deterministic-simulation' -f 'names[]=bachelor-project'
   ```
4. **Ruleset `main`** (area 2). UI: Settings → Rules → Rulesets → New branch ruleset. The JSON
   is in appendix A8 (`actor_id: 5` is the Repository admin role *(not re-checked)*; check the
   bypass list in the UI after creating it).
   ```sh
   gh api -X POST repos/sssoto17/sunny-pastures/rulesets --input ruleset-main.json --jq '.id'
   ```
5. **Ruleset `prototype/*`** and **ruleset `v*` tags** (appendix A8), same call with their files.
6. **Project workflows** (area 5). UI only: the Project → ⋯ → Workflows. Turn on or off as in the
   table; set auto-add's filter to `is:issue`.
7. **Project views** (area 5). UI only: the Project → New view.
8. **Dependabot alerts** now (area 8). UI: Settings → Code security → Dependabot alerts.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/vulnerability-alerts --silent
   ```
9. **Actions permissions** (area 8), before the first workflow. UI: Settings → Actions → General.
   ```sh
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions --silent \
     -F enabled=true -f allowed_actions=selected
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions/selected-actions --silent \
     -F github_owned_allowed=true -F verified_allowed=false
   gh api -X PUT repos/sssoto17/sunny-pastures/actions/permissions/workflow --silent \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
   ```
10. **If public:** secret scanning and push protection, private vulnerability reporting.
    UI: Settings → Code security.
    ```sh
    gh api -X PATCH repos/sssoto17/sunny-pastures --silent \
      -f 'security_and_analysis[secret_scanning][status]=enabled' \
      -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
    gh api -X PUT repos/sssoto17/sunny-pastures/private-vulnerability-reporting --silent
    ```
11. **[.github] The templates PR** (M2): `ISSUE_TEMPLATE/*.yml` and `config.yml` (A4),
    `pull_request_template.md` (A2), `CODEOWNERS` (A3). The admin's PR, not an agent's.
12. **M2: Dependabot security updates** (area 8). UI: Settings → Code security.
    ```sh
    gh api -X PUT repos/sssoto17/sunny-pastures/automated-security-fixes --silent
    ```
13. **M2, if public: CodeQL default setup.** UI: Settings → Code security → Code scanning.
    ```sh
    gh api -X PATCH repos/sssoto17/sunny-pastures/code-scanning/default-setup --silent -f state=configured
    ```
14. **CI/CD step:** **[.github]** `labeler.yml` and its workflow (A1); the CI workflows; then add
    the required checks to the `main` ruleset as they start reporting (Settings → Rules → the
    ruleset → Require status checks).
15. **M3:** **[.github]** `dependabot.yml` (A7). Environments `staging` and `production`, if
    Actions needs deploy credentials (area 4). UI: Settings → Environments.
    ```sh
    gh api -X PUT repos/sssoto17/sunny-pastures/environments/production --silent \
      -F 'deployment_branch_policy[protected_branches]=false' \
      -F 'deployment_branch_policy[custom_branch_policies]=true'
    gh api -X POST repos/sssoto17/sunny-pastures/environments/production/deployment-branch-policies \
      --silent -f name=main
    gh secret set SUPABASE_ACCESS_TOKEN --env production   # prompts; the value is never shown
    ```
16. **M4:** **[.github]** `release.yml` (A6); `SECURITY.md` (A5); the first tag `v0.4.0` and its
    Release; `CHANGELOG.md`.

---

# Appendix: drafts

Drafts only. They land under `.github/` in the admin's PR (checklist 11, 14–16).

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

"area:ci-cd":     # .github/, .claude/, root config
  - changed-files:
      - any-glob-to-any-file:
          - ".github/**"
          - ".claude/**"
          - "package.json"
          - "pnpm-workspace.yaml"
          - "pnpm-lock.yaml"
          - "skills-lock.json"
          - ".nvmrc"
          - ".gitignore"
          - ".env.example"

"area:tools":
  - changed-files:
      - any-glob-to-any-file: "tools/**"

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

## Protected paths

- [ ] This PR touches none of: `tests/acceptance/`, `.github/`, config files, `AGENTS.md`, `CONSTRAINTS.md`
- [ ] It touches one, and the admin asked for it: <!-- which, and where he asked -->

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
# Protected paths (docs/agents/issue-tracker.md, "factory:ready"). Enforced only if the
# main ruleset requires code-owner review (ADR-0002, area 2, option a).
/tests/acceptance/      @sssoto17
/.github/               @sssoto17
/.claude/               @sssoto17
/AGENTS.md              @sssoto17
/CLAUDE.md              @sssoto17
/CONSTRAINTS.md         @sssoto17
/package.json           @sssoto17
/pnpm-workspace.yaml    @sssoto17
/pnpm-lock.yaml         @sssoto17
/supabase/config.toml   @sssoto17
```

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

## A5. `SECURITY.md` (M4)

```markdown
# Security

Sunny Pastures is a student project (EK PBA Webudvikling, 2026–27). Only the latest deployed
version is supported.

## Reporting a vulnerability

Please don't open a public issue. Report it privately:
<!-- public repo: --> use "Report a vulnerability" on the repository's Security tab.
<!-- private repo: --> write to <security contact address, Q8>.

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
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
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

With option (a) in area 2, `ruleset-main.json` changes to `"required_approving_review_count": 1`
and `"require_code_owner_review": true`, and the factory's account stays out of the bypass list.

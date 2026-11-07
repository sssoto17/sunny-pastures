# Research: factory and reviewer identity, costs and Claude's terms for CI

Research ticket #60, feeding the decision in spike #37 ("where the factory runs, and as which GitHub
identity") and ADR-0002 area 2 ("The factory's identity", "Approvals"), area 9, Consequences
("Claude cost per review") and Admin checklist step 12. Researched on 7 Nov 2026 from primary
sources. **No recommendation:** choosing is #37's grilling.

Every claim is marked:

- **[D]** Documented: a primary source says it; the URL follows, all checked 2026-11-07.
- **[R]** Repo record: this repo, an issue or ADR-0002 says it.
- **[I]** Inference: my reasoning from the documented facts, not stated anywhere.

The options, as #37 names them:

- **(a)** a GitHub App, from Actions on GitHub-hosted runners;
- **(b)** a GitHub App, from Actions on a self-hosted runner;
- **(c)** a Claude Code self-hosted environment;
- **(d)** our own dispatcher running `claude -p`.

For comparison, the status quo is **(0)**: cloud sessions and routines on an Anthropic-hosted
environment, acting as `sssoto17`.

## Summary

| | (a) App, GitHub-hosted | (b) App, self-hosted runner | (c) self-hosted environment | (d) own dispatcher |
|---|---|---|---|---|
| GitHub identity | `<app-slug>[bot]` [D] | `<app-slug>[bot]` [D] | The session owner (`sssoto17`) through Anthropic's git proxy; an own bot only if the runner image mints the credentials [D] | Whatever token the dispatcher hands out, so `<app-slug>[bot]` with an App token [I] |
| Compute while private | Pro's $18 a month included, then $0.006/min on Linux 2-core [D] | Runner minutes free [D]; the host is ours | Our host; no GitHub minutes [I] | Our host [I] |
| Compute once public | Standard runners free [D] | Free, but GitHub says self-hosted runners "should almost never be used for public repositories" [D] | Same as private [I] | Same as private [I] |
| Available to us | Yes [I] | Yes [I] | **No on a personal plan:** Team/Enterprise public beta [D] | Yes [I] |
| Repo hooks run | Yes: `claude-code-action` loads user, project and local settings by default [D, source]; `claude -p` without `--bare` runs them [D] | Same as (a) | Yes, in a one-repo session, plus the runner host's hooks [D] | Yes without `--bare`; no with `--bare` [D] |
| Database per job | Fresh VM per job [D]; Docker service containers on Ubuntu runners [D] | Docker must be installed [D]; clean state only if we make each runner ephemeral [D] | One container or VM per session, `--capacity 1` [D] | Ours to build [I] |
| Secrets live in | Actions secrets and variables [D] | Actions secrets, delivered to our host at job time [I] | The runner image or host; no network secrets [D] | Our host [I] |
| Claude billing | `setup-token` (subscription) or API key [D] | Same as (a) | The seat's subscription usage [D] | `setup-token` or API key [D] |

The terms section below applies to every option that bills Claude through a subscription token.

## Corrections to what #37 records

Three of #37's "already known" points (from the admin's research of 20–23 Oct) need an update:

1. **Starting a cloud session.** #37: "There's no way to start a cloud session on an
   Anthropic-hosted environment except through a routine." The docs now list `claude --cloud
   "<task>"` from a terminal, follow-ups with `claude -p "<msg>" --cloud <session-id>` "from a CI
   script", and an API trigger on a scheduled task (an HTTP POST with a bearer token) [D,
   [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web),
   [scheduled tasks](https://code.claude.com/docs/en/routines)]. All of them need a claude.ai
   login and act as the owner, so this doesn't change the identity finding [D, same pages].
   `claude -p` rejects `--cloud` with a task description, so whether `claude --cloud "<task>"`
   runs unattended from a script isn't stated [D, [headless](https://code.claude.com/docs/en/headless)];
   untested [I].
2. **A token set in a cloud session.** #37 found that a PAT, an invalid token and no token all
   came back as the owner. The current docs say: "If you set a token, it passes through to the
   container unchanged, so your scripts and GitHub's `gh` CLI use it directly", while git
   credentials are "a scoped credential, which the proxy verifies and swaps for your actual GitHub
   token", and GraphQL is refused "regardless of the credentials you supply"
   [D, [cloud environments, GitHub proxy](https://code.claude.com/docs/en/cloud-environments)].
   The docs don't say whether the proxy replaces a token you set on REST calls. The two accounts
   conflict for `gh api` with a set token; git pushes are swapped either way. Worth one re-test
   before #37 relies on it [I].
3. **Hooks in cloud sessions** (#37's 7 Nov comment). Answered below, under "Hooks": the repo's
   `.claude/settings.json` hooks **do** run in a cloud session with one repository, and don't run
   in a session with several repositories or in a project's cloud thread [D].

Also new: the cloud GitHub proxy "rejects branch deletions and pushes of anything other than a
branch, such as a tag" [D, cloud environments]. So no cloud session or routine can push a `v*`
tag today, which closes one of ADR-0002's four instruction-only gaps for cloud sessions (not for
local ones) [I].

## Facts common to all options

### GitHub Apps

- An App's installation token comes from `actions/create-github-app-token` (client ID as an Actions
  variable, the private key as a secret) [D,
  [App in Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow)].
  The token "expires after 1 hour", is revoked in the action's `post` step unless
  `skip-token-revoke` is set, and so can't be passed to another job; `permission-<name>` inputs
  narrow it below the installation's permissions [D,
  [create-github-app-token README](https://github.com/actions/create-github-app-token)].
- "GitHub Apps are not tied to a user account and do not consume a seat", use short-lived tokens,
  and their rate limit scales with the number of repositories [D,
  [deciding when to build an App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)].
- **PRs, reviews, comments, labels** made with the installation token show the App as the actor,
  `<app-slug>[bot]` [I, from the README's bot-user example and GitHub's statement that Apps
  "indicate that the action was performed by the app"; the docs don't spell out the `[bot]` login
  for PR authorship].
- **Commits** carry whatever `user.name`/`user.email` git is configured with. The README's example
  sets `<app-slug>[bot]` and `<id>+<app-slug>[bot]@users.noreply.github.com`, with the ID from
  `gh api "/users/<app-slug>[bot]" --jq .id` [D, README]. The pusher is the App [I].
- **Verified commits:** a bot's commit is marked verified only when made through the API "as the
  GitHub App or bot" with "no custom author information, custom committer information, and no
  custom signature information", such as the Commits API [D,
  [commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)].
  So a plain `git push` from a runner gives unsigned commits [I]. `claude-code-action` offers
  `use_commit_signing` (signs through GitHub's API, no rebasing) or `ssh_signing_key` with
  `bot_id`/`bot_name` [D,
  [action inputs](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md)].
- **Workflows run on its pushes and PRs.** Events from `GITHUB_TOKEN` don't create runs (PRs it
  opens wait in "approval-required"); an App installation token or a PAT does trigger them [D,
  [triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)].
- **Tag pushes:** an App with `contents: write` can push a tag where the rulesets allow it [I].
  GitHub Apps are eligible bypass actors on a ruleset, with "Always allow" or "For pull requests
  only" [D,
  [creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)].
  A tag pushed with the App token would start the `deploy` workflow; one pushed with
  `GITHUB_TOKEN` wouldn't [I, from the trigger rule above]. ADR-0002 keeps tag pushes with the
  admin, so the App would stay off the `v*` ruleset's bypass list [R, ADR-0002 area 4].
- **Changing `.github/workflows/`** needs the App's Workflows permission; the permissions reference
  lists it on the contents and refs endpoints but doesn't say how it applies to `git push` [D,
  [permissions for Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)].
  `.github/**` is code-owned anyway [R, ADR-0002 A3].
- The repo is user-owned, so the admin registers the App on their own account [R, #37].

### Actions billing

- Private repos draw on a monthly included amount in dollars: **$18 on Pro** (plus 1 GB artifact
  storage, 10 GB cache per repo), $12 on Free [D,
  [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)].
- Linux 2-core x64 costs **$0.006 a minute**, so $18 is about **3,000 Linux 2-core minutes** a month
  [D for the rate; I for the division].
- Without a payment method, "usage is blocked once you consume the included compute usage"; with
  one, budgets limit it, with alerts at 90% and 100% [D, Actions billing].
- **Free:** "Standard GitHub-hosted runners in public repositories" and "Self-hosted runners".
  Public usage doesn't reduce the included amount [D, Actions billing].
- **Self-hosted charge, postponed:** GitHub announced on 16 Dec 2025 a $0.002/min platform charge
  on self-hosted runners in private repos from 1 Mar 2026, then postponed it; the roadmap item was
  closed as not planned [D,
  [changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/),
  [roadmap #1197](https://github.com/github/roadmap/issues/1197)]. The billing page lists
  self-hosted runners as free today [D]. A revival would bill (b) while private [I].
- Each Claude run in Actions spends both runner minutes and Claude usage [D,
  [Claude Code GitHub Actions, "Manage costs"](https://code.claude.com/docs/en/github-actions)].

### How Claude is billed in CI

| Credential | What it is | Billing | Terms |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | A one-year OAuth token that "can only make model requests", for "CI pipelines, scripts, or other environments where interactive browser login isn't available"; needs Pro, Max, Ultra, Team or Enterprise [D, [authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)] | The subscription's usage: "runs use your Claude subscription instead of API billing" [D, GitHub Actions page] | Consumer Terms on Pro/Max/Ultra; Commercial Terms on Team/Enterprise [D, [legal](https://code.claude.com/docs/en/legal-and-compliance)] |
| `ANTHROPIC_API_KEY` from the Claude Console | A static key | Per token: Sonnet 5.5 $2 in / $10 out per MTok, Opus 5.5 $4 / $20, Haiku 5.5 $0.10 / $0.50 (prompts up to 100k) [D, [pricing](https://platform.claude.com/docs/en/about-claude/pricing)] | Commercial Terms [D, legal] |
| Workload identity federation | The action trades the workflow's OIDC token for API access through a Console service account; no stored secret; needs `id-token: write` [D, GitHub Actions page] | API billing [I] | Commercial Terms [I] |

- The action takes `claude_code_oauth_token` or `anthropic_api_key`. For a secret shared across
  repositories, the docs advise an API key, "since an OAuth token is tied to the subscription of
  the person who ran `claude setup-token`" [D, GitHub Actions page].
- Precedence: `ANTHROPIC_API_KEY` beats `CLAUDE_CODE_OAUTH_TOKEN`; in `-p` mode the API key "is
  always used when present" [D, authentication].
- `--bare` doesn't read `CLAUDE_CODE_OAUTH_TOKEN` and skips hooks, so a bare run needs an API key
  [D, authentication; [headless](https://code.claude.com/docs/en/headless)]. The headless page says
  `--bare` "will become the default for `-p` in a future release" [D].
- `--output-format json` reports `total_cost_usd`, a client-side estimate [D, headless].

**What the terms say** (quotes, checked 7 Nov; the reading of them is the admin's):

- Consumer Terms (effective 8 Oct 2025), section 3: you may not "access the Services through
  automated or non-human means, whether through a bot, script, or otherwise", "Except when you are
  accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it" [D,
  [consumer terms](https://www.anthropic.com/legal/consumer-terms)].
- Section 2: "You may not share your Account login information, Anthropic API key, or Account
  credentials with anyone else" [D, consumer terms].
- Claude Code's legal page: OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max,
  Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude
  Code and other native Anthropic applications". "Advertised usage limits for Pro, Max, and Ultra
  plans assume ordinary, individual usage of Claude Code and the Agent SDK." Developers building
  products "should use API key authentication", and may not "route requests through Free, Pro, Max,
  or Ultra plan credentials on behalf of their users". It does not prevent "an end user from
  signing in to the unmodified Claude Code binary with their own Claude subscription" [D,
  [legal](https://code.claude.com/docs/en/legal-and-compliance)].
- Anthropic's docs document the subscription token for exactly this use: `setup-token` "for CI
  pipelines and scripts", and `claude_code_oauth_token` as an input of Anthropic's own GitHub
  Action [D, authentication; GitHub Actions page].
- The Agent SDK note ("Anthropic does not allow third party developers to offer claude.ai login or
  rate limits for their products") is about products for other users [D,
  [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)]. The factory serves
  only the admin's own repo [I].

What the documents leave open [I]:

- Whether the documented `setup-token` CI use counts as "where we otherwise explicitly permit it"
  for an **unattended, always-on** factory and reviewer. The docs say how to do it, not how much of
  it is "ordinary, individual usage".
- With an API key, the automated-access exception applies outright and the Commercial Terms govern.
- After go-public, fork PRs don't receive secrets [D, GitHub Actions page: "GitHub withholds
  secrets from runs triggered by fork pull requests"], so no outside contributor runs Claude on the
  admin's token [I].
- A subscription token shares the plan's limits with the admin's own sessions: cloud sessions
  "share rate limits with all other Claude and Claude Code usage within your account" [D, cloud
  sessions]. That a `setup-token` run draws on the same pool is my reading of "runs use your Claude
  subscription" [I].

### Hooks

| Where Claude runs | Repo `.claude/settings.json` hooks | Source |
|---|---|---|
| Cloud session, one repository, Anthropic-hosted | **Run** | [D, [cloud environments](https://code.claude.com/docs/en/cloud-environments): "Your repo's `.claude/settings.json` hooks and permission rules — Yes, in a session with one repository"] |
| Cloud session, several repositories | Don't run | [D, same; [settings](https://code.claude.com/docs/en/settings#settings-in-cloud-sessions)] |
| A project's cloud thread | Don't run | [D, same] |
| Routine (scheduled task) | A routine runs as a cloud session, so the cloud-session rows apply [I, from "scheduled and triggered runs each run as a cloud session", cloud sessions page] |
| Self-hosted environment | Repo hooks, plus hooks seeded from the runner host's `~/.claude/` and the runner image's managed settings [D, cloud environments] |
| `claude-code-action` | Run: the action defaults `settingSources` to `["user", "project", "local"]` unless `claude_args` passes `--setting-sources` [D, source: `base-action/src/parse-sdk-options.ts`, commit `115e0b2c4922`, 6 Nov 2026] |
| `claude -p` | Run, "even in a folder you've never trusted"; not with `--bare` [D, headless] |

- Detecting where a hook runs: `CLAUDE_CODE_REMOTE` is `true` in a cloud session VM and "never
  `true` locally" [D, cloud environments]; `CLAUDE_CODE_REMOTE_SESSION_ID` holds the session ID
  [D, same]. In Actions, `GITHUB_ACTIONS` and `CI` are `true` [D,
  [variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)].
  I found no documented variable that tells a routine run from an attended cloud session [I: not
  found, not proven absent].
- So ADR-0002's merge guard for unattended sessions can run in a one-repo cloud session, and could
  key on `CLAUDE_CODE_REMOTE` (cloud against local); telling a routine from an attended cloud
  session stays open [I].
- Hooks defined in agent frontmatter in cloud runs: #37 found they're skipped [R]; not re-checked.
- On `pull_request_target`, if a job checks out the PR head and runs Claude there, the PR's own
  `.claude/settings.json` hooks run with the job's secrets [I, from the default above]. GitHub
  warns that such workflows "must not explicitly check out untrusted code" [D,
  [secure use](https://docs.github.com/en/actions/reference/security/secure-use)]. ADR-0002's
  reviewer never runs PR code [R], so it would need `--setting-sources user` or a checkout of
  `main` [I].

### The acceptance stack

- The local stack is the Supabase CLI wrapped by `pnpm db:start` (`supabase/db.sh`) [R]. "That
  stack runs in Docker containers, so you need a container runtime installed first"; an
  experimental native runtime exists for runners without one [D,
  [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)].
- Docker service containers: "GitHub creates a fresh Docker container for each service" and
  "destroys the service container when the job completes"; GitHub-hosted runners must be Ubuntu,
  and a self-hosted runner "must use a Linux machine" with Docker installed [D,
  [service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers)].

## (a) A GitHub App, from Actions on GitHub-hosted runners

- **Identity:** the App on PRs, reviews, comments and labels; commits as configured, pushed by the
  App; triggers CI (above) [D/I as marked there]. With `claude-code-action`, omitting
  `github_token` makes it act as the official **Claude GitHub App** (`claude[bot]`), whose
  permission set includes Workflows write, Actions write and Repository hooks write; "If your
  organization requires only the permissions the Claude Code GitHub Action uses, create a custom
  GitHub App" [D, GitHub Actions page]. Our own App means passing the
  `create-github-app-token` output as `github_token` [D, action inputs].
- **Cost while private:** runner minutes from the $18; every factory job and every reviewer run
  counts [D]. Nothing is measured yet: `CONSTRAINTS.md` has the CI-time criterion, to be measured
  in #40's first week [R].
- **Cost once public:** standard runners free [D]. Claude usage is billed the same either way [I].
- **Hooks:** run (table above). Each job is a fresh VM, so hooks and settings come only from the
  checkout [I, from "each GitHub-hosted runner is a new virtual machine" [D,
  [GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)]].
- **Database per job:** a fresh VM per job [D] with Docker for service containers on Ubuntu [D];
  `supabase start` in the job [I].
- **GraphQL:** open from Actions (ADR-0002 already relies on it for `resolveReviewThread`) [R]. So
  the factory could write Project fields from a job [I].
- **Secrets:** the App's private key as an Actions or environment secret, its client ID as a
  variable [D]; the Claude credential as a secret [D]. Environment secrets keep the key to one job
  [R, ADR-0002 area 2].
- **Who can trigger:** the action refuses bot actors unless listed in `allowed_bots`, and on issue
  and PR events needs a triggering user with write access [D, GitHub Actions page]. A factory App
  that should trigger the reviewer job must be in the reviewer's `allowed_bots` [I].
- **What the admin sets up:** register the App (permissions), install it on the repo, store key and
  client ID, store the Claude credential, add `anthropics/claude-code-action` to "Allowed actions"
  with a SHA pin at least 7 days old [R, ADR-0002 area 8: allowed actions is "local only" today,
  `github_owned_allowed=true` covers `actions/create-github-app-token`], write the workflows
  (`.github/` is code-owned, so the admin's PR) [R].

## (b) A GitHub App, from Actions on a self-hosted runner

- **Identity:** as (a) [I].
- **Cost while private:** runner minutes free [D]; the host is ours (a fixed-price host, #37) [R].
  The postponed $0.002/min charge would change that if revived [D/I above].
- **Cost once public:** free in minutes, but GitHub says self-hosted runners "should almost never be
  used for public repositories on GitHub", because "any user can open pull requests against the
  repository and compromise the environment" [D,
  [secure use](https://docs.github.com/en/actions/reference/security/secure-use)]. Self-hosted
  runners "can be persistently compromised by untrusted code in a workflow" [D, same]. Limiting
  the runner to jobs that fork PRs can't reach is a design question for #37 [I].
- **Hooks:** as (a); the host's own `~/.claude/` would also load unless the job sets
  `--setting-sources` [I, from the action's default including `user`].
- **Database per job:** Linux with Docker installed [D]. Self-hosted runners "Don't need to have a
  clean instance for every job execution" [D,
  [self-hosted runners](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)].
  Just-in-time runners "perform at most one job before being automatically removed", but
  "Re-using hardware to host JIT runners can risk exposing information from the environment", so
  "Use automation to ensure the JIT runner uses a clean environment" [D, secure use]. #37 adds:
  one Docker daemon per job, and the load VM must stay clean for measurements [R].
- **Secrets:** as (a) in GitHub; they reach our host while a job runs [I].
- **What the admin sets up:** everything in (a), plus the host, the runner registration (JIT
  through the REST API), the automation that gives each job a clean environment, Docker, and
  keeping it apart from the load-test VM [D/R as above].

## (c) A Claude Code self-hosted environment

- **Availability:** "public beta on Team and Enterprise plans", off by default; an Owner turns on
  "Allow self-hosted environments", which needs cloud sessions enabled [D,
  [self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)]. **A
  personal plan (Pro, Max, Ultra) can't use it** [D]. The docs point Pro, Max and Ultra users to
  Remote Control for "your own always-on machine" [D, same]. Team is "for teams of 2 to 150", from
  $20 a seat a month billed annually ($25 monthly) [D, [pricing](https://claude.com/pricing)], so
  at least two seats [I].
- **Identity** depends on how the runner gets git credentials [D,
  [deploy, Configure git](https://code.claude.com/docs/en/self-hosted-environments-deploy)]:
  - `--configure-git`: commits as `Claude <noreply@anthropic.com>`, SSH-signed by Anthropic's
    signing service, with a `Co-authored-by:` trailer for the session's creator; push credentials
    still come from the image;
  - Anthropic git proxy: for a user's session, Anthropic "uses the GitHub OAuth token stored for
    the session's creator", so the admin; github.com only, `--capacity 1`;
  - own git config in the image: "for example to commit under your own bot identity"; the docs
    advise minting "a short-lived, least-scoped token per session from your wrapper script" rather
    than baking a credential into the image.

  So an App identity is possible only with the third route, a wrapper that mints an installation
  token per session [I]. Routines on a self-hosted runner that push with deployment credentials
  are "checked against those instead" of the connected GitHub access [D, scheduled tasks].
- **GraphQL and tags:** the 403 on GraphQL and the tag-push refusal are properties of Anthropic's
  proxy [D]; with own credentials neither applies [I].
- **Cost:** sessions "consume your organization's Claude Code usage the same way" as hosted ones
  [D]; compute is our host [I]; no GitHub minutes [I]. Plus the Team seats [I].
- **Hooks:** repo hooks in a one-repo session, plus the host's `~/.claude/` and the image's managed
  settings [D].
- **Database per job:** "Run each runner process in a fresh container or VM that's destroyed when
  the process exits, with `--capacity 1`"; Anthropic publishes no runner image [D, deploy page].
  Docker inside that container is ours to solve [I].
- **Secrets:** on our host or image; "A self-hosted environment doesn't have network secrets" [D,
  cloud environments]. The runner registers with an environment key, "Shown once at environment
  creation" [D].
- **What the admin sets up:** a Team organization, cloud sessions and self-hosted environments
  turned on, an environment, a runner image and host, git configuration (and the token-minting
  wrapper for an App identity), and the App [D/I as above].

## (d) Our own dispatcher running `claude -p`

- **Identity:** whatever credentials the dispatcher gives the process: `GH_TOKEN` and git config
  from an App installation token gives `<app-slug>[bot]` [I]. Outside Actions there is no
  `create-github-app-token`, so the dispatcher signs a JWT with the App key and asks for an
  installation token itself (not fetched here) [I].
- **Cost:** our host [I]; Claude through `setup-token` or an API key [D].
- **Hooks:** run without `--bare`; with `--bare` they don't, and `CLAUDE_CODE_OAUTH_TOKEN` isn't
  read [D, headless]. If `--bare` becomes the `-p` default as announced, the dispatcher must opt out
  to keep the hooks [I].
- **Database per job:** ours to build, for example one container per job with its own Docker
  daemon [I].
- **Secrets:** on our host [I].
- **Terms:** the unmodified binary with the admin's own subscription is explicitly not prevented
  [D, legal]; the automated-access clause question above applies [I].
- **What the admin sets up:** the host, the dispatcher (how it learns of work: polling or a
  webhook), the App, the Claude credential, per-job isolation [I].

## The reviewer App (ADR-0002 Q12, "Claude cost per review")

- Same mechanics as (a) or (b): its own App token passed as `github_token`, Claude via
  `claude_code_oauth_token` or `anthropic_api_key` [D]. Without `github_token`, reviews would come
  from `claude[bot]`, the official App, not `sunny-reviewer[bot]` [D].
- The documented review example runs a skill as the `prompt` and posts inline comments only when
  `--allowedTools` names `mcp__github_inline_comment__create_inline_comment` [D, GitHub Actions
  page]. Submitting an Approve or Request changes review isn't in that example; the bot's workflow
  would call the REST reviews endpoint with the App token [I].
- **Cost per review, illustrative only** [I, arithmetic on documented prices, nothing measured]: a
  run that reads 50,000 input tokens and writes 3,000 costs about $0.13 on Sonnet 5.5 ($0.10 +
  $0.03) or $0.26 on Opus 5.5 by API key. A multi-turn agentic review rereads context each turn,
  mostly at cache-read prices ($0.10 / $0.20 per MTok). ADR-0002 runs the bot on every push,
  `labeled` event and "Update branch" [R]. On a subscription token, the same runs count against the
  admin's plan limits instead [I].
- Anthropic's managed "Code Review" product is a separate feature that needs the official App [D,
  GitHub Actions page]; not researched further.

## On #37's review-request question (7 Nov comment)

Only partly in scope here. Once the factory's PRs come from the App, the admin is not their author,
so a review request to `sssoto17` is possible [I]. PRs from attended sessions still come from
`sssoto17` under every option here, since only the factory moves to the App [R, ADR-0002 "The honest
limit"]. Reading "was the admin's review ever requested" from the review history rather than the
current request list was not researched.

## Not confirmed

- Whether a token set in a cloud environment is replaced on REST calls (correction 2): needs one
  test.
- Whether `claude --cloud "<task>"` runs unattended from a script.
- A documented way to tell a routine run from an attended cloud session.
- Whether frontmatter hooks are still skipped in cloud runs.
- How the Workflows permission applies to `git push` of workflow files.
- The admin's Claude plan isn't recorded in the repo; #37 calls it "a personal plan" [R].
- Real runner minutes and Claude tokens per factory job and per review: nothing runs yet (#40).
- Whether the self-hosted runner charge comes back.

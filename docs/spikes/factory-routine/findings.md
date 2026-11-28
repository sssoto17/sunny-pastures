# Findings: the factory as a routed Claude routine

Spike #705: prove the risky parts of the factory redesign the admin settled on 28 Nov 2026 (D1-D16
in the issue; recorded in ADR-0012), against the decision rule fixed before measuring. Run on 28 Nov
2026 from a cloud lane session (Claude Code 2.1.332, Ubuntu 24.04, 4 vCPUs, 16 GB). That session's
environment is a lane's, **not the factory's future environment**: the routine and its environment
don't exist yet, and only the admin can create them (`admin-setup.md`, beside this file).

Each check below has a verdict: **pass**, **fail**, **pass on prior evidence** (the planned probe
couldn't run, and earlier runs answer the question) or **waiting on admin setup**. A check that
waits lists the exact steps and the evidence a later session must record here.

<!-- prettier-ignore -->
| Check | Verdict | Evidence |
|---|---|---|
| 1. A fire from an Actions runner starts a session | waiting on admin setup | the routine, its token and a fire step on `main` don't exist yet |
| 2. The session's `factory-done` starts `sweep.yml` | waiting on admin setup | half shown: a cloud session's `repository_dispatch` starts a workflow ([46182591111](https://github.com/sssoto17/sunny-pastures/actions/runs/46182591111)); `sweep.yml` has no `factory-done` trigger yet |
| 3. A `sunny-reviewer` review fires `pull_request_review` | pass on prior evidence | the probe PR was refused (below); 70 `pull_request_review` runs of `code-owned.yml` with actor `sunny-reviewer[bot]`, 22-23 Nov |
| 4. A routine session can push under `.github/workflows/` | pass (cloud session) | commit `7a03dff` pushed to `throwaway/705-review-probe` |
| 5. The environment runs the Supabase stack and Playwright Chromium | partly: the stack yes, the pinned Chromium no | below; the factory's setup script must add five things |
| 6. The #605 retry ends with a PR or a `FACTORY stopped:` reason | waiting on admin setup | needs the routine and `/factory` |
| 7. The Stop hook refuses a #605-shaped run | pass | `.claude/hooks/factory-stop-check.test.sh`: 27 passed, 0 failed |

**What the rule says now.** Checks 1, 2 and 6 decide the runtime. None has failed; all three wait on
the admin's setup. Until they run, `factory.yml` stays, and the Stop-hook check (7) ships either
way, as the rule says. The runtime-independent parts (routing, modes, personas, caps, improvement
loop) go ahead as the build tickets under #58.

## 1. Fire from an Actions runner: waiting on admin setup

**Why it can't run yet.** The fire endpoint takes a per-routine bearer token that only the admin can
generate, in the claude.ai UI, and a runner can only hold it as an environment secret, which only
the admin can set. The step that fires must run from `main` (the secret's environment admits `main`
only), so it needs a merged workflow.

**What the docs say** (read 28 Nov 2026):
[routines-fire](https://platform.claude.com/docs/en/api/claude-code/routines-fire),
[routines](https://code.claude.com/docs/en/routines.md).

- `POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire`, where the id is
  prefixed `trig_`. Headers: `Authorization: Bearer <token>` (prefixed `sk-ant-oat01-`),
  `anthropic-version` (any from `2023-06-01`; the example uses `2026-10-21`),
  `Content-Type: application/json`. `anthropic-beta: experimental-cc-routine-2026-04-01` is
  accepted, not required.
- Body: `{"text": "<at most 65,536 characters>"}`, optional. The text reaches the session wrapped in
  a `<routine-fire-payload>` block marked as untrusted, and Claude acts on it only when the
  routine's saved prompt says to. So the saved prompt must name the block (`admin-setup.md`, step
  3).
- `200 OK` with
  `{"type": "routine_fire", "claude_code_session_id": "session_…", "claude_code_session_url": "https://claude.ai/code/session_…"}`.
  It returns once the session is created and doesn't wait for it. Errors use the Anthropic envelope:
  400 (bad version, text too long, routine paused), 401, 403, 404, 429 (with `Retry-After`),
  500, 503.
- No idempotency key: a retried fire starts a second session. The sweep must not retry a fire that
  may have reached the server (a timeout), or single-flight breaks.
- Limits: 30 fires an hour per routine (shared with **Run now**), 100 API fires an hour per account.
  D16's one run at a time stays far below.
- The token is scoped to one routine and grants no read access. Generating a new one revokes the
  old.
- Risk from the Billetto factory's spec
  (`docs/superpowers/specs/2026-10-11-software-factory-design.md`, "Where it runs"): since 31 Oct
  "the fire endpoint now refuses a routine token from a cloud session with restricted network
  access" (anthropics/claude-code#106400). Our fire comes from an Actions runner, not a cloud
  session, so D2's design avoids it; the routine's own wake-up is a `repository_dispatch` (check 2),
  never a fire.

**Steps for the later session**, once `admin-setup.md` steps 1-5 are done:

1. Merge a `workflow_dispatch` probe on `main` (code-owned, `review:admin`): one job in environment
   `factory-routine`, `permissions: {}`, that POSTs `{"text": "probe 705"}` with
   `curl -sS -o body -w '%{http_code}'`, prints the status code and the body with
   `jq '{type, claude_code_session_id, claude_code_session_url}'`, and never echoes the token. The
   build ticket "the sweep fires the routine" can carry it as its first commit.
2. Dispatch it once. The routine's saved prompt treats `probe <N>` as "reply `PROBE ok`, change
   nothing, send `factory-done`" (`admin-setup.md`, step 3).

**Evidence to record here:** the probe's run URL, the HTTP status, the response body's three fields
(the session id may be shown; the token never), and the session URL showing the run started. **Fails
if** the status isn't 200 or no session starts within 2 minutes; record the error envelope.

## 2. `factory-done` wakes the sweep: waiting on admin setup

**Shown already.** A cloud session on the admin's account can send `repository_dispatch` and it
starts a workflow: this spike's `scripts/open-pr.sh` call sent `open-pr` and started
[46182591111](https://github.com/sssoto17/sunny-pastures/actions/runs/46182591111) (event
`repository_dispatch`, actor `sssoto17`). Lanes have done the same for every PR since #336. GitHub
runs a `repository_dispatch` workflow from the default branch only.

**Not shown.** That a session the routine started can send it (the routine uses the same GitHub
proxy as a lane, so this is expected), and that `sweep.yml` reacts: it has no `factory-done` trigger
yet, and a branch can't add one, since the event runs `main`'s copy.

**Steps:** merge `repository_dispatch: types: [factory-done]` on `sweep.yml` (the build ticket "the
sweep's triggers and order"), then run check 1's probe; its routine sends `factory-done` as its last
step (`gh api repos/sssoto17/sunny-pastures/dispatches -f event_type=factory-done`). **Evidence:**
the sweep run's URL with event `repository_dispatch` and its `SWEEP` line.

## 3. A `sunny-reviewer` review fires `pull_request_review`: pass on prior evidence

**The probe, as briefed, couldn't open.** The branch `throwaway/705-review-probe` (commit `7a03dff`,
adding `.github/workflows/probe-705.yml`: `pull_request_review: [submitted]`, `permissions: {}`, one
step echoing the review's author and state) pushed fine. `scripts/open-pr.sh` sent the dispatch, and
`open-pr.yml` refused it, run
[46182591111](https://github.com/sssoto17/sunny-pastures/actions/runs/46182591111):

```text
##[error]the branch 'throwaway/705-review-probe' isn't a lane branch (<N>-<slug> or claude/<name>)
```

The brief fixed both the branch name and `open-pr.sh`, which accept no common name, and this session
may push only to its own branch and the one the brief named. So no PR opened, no review came, and
nothing waited the 30 minutes. Opening it another way (`gh pr create` or a REST POST as the admin)
would bypass the rule `open-pr.sh` exists for, so it wasn't tried.

**The prior evidence answers the question.** Until #633 (`edff017`, 23 Nov) removed the trigger,
`code-owned.yml` ran on `pull_request_review`. Of its newest 100 such runs, 70 have actor and
triggering actor `sunny-reviewer[bot]`
(`gh api "repos/sssoto17/sunny-pastures/actions/workflows/code-owned.yml/runs?event=pull_request_review&per_page=100"`,
read 28 Nov). For example,
[45241456042](https://github.com/sssoto17/sunny-pastures/actions/runs/45241456042) (event
`pull_request_review`, success, 18:43:47 UTC on 23 Nov) follows `sunny-reviewer[bot]`'s review
6027429326 on PR #634 (state `COMMENTED`, 18:43:44). Reviews in the window are `COMMENTED`, or
dismissed with their first state hidden, so none shows `CHANGES_REQUESTED` by name; the event fires
on every submitted review, and D11's filter on `changes_requested` belongs in the sweep's job.
GitHub's rule that events made with `GITHUB_TOKEN` start no runs doesn't touch the reviewer, which
posts with its App's installation token.

**Left for the admin:** the branch `throwaway/705-review-probe` still exists. The cloud proxy
refuses branch deletions ("the proxy rejects branch deletions", cloud-environments docs, "GitHub
proxy"; here `HTTP 403` on `git push origin :refs/heads/throwaway/705-review-probe`). Delete it in
the UI. If the admin wants the probe itself, rename it `claude/705-review-probe` and open it.

## 4. A push under `.github/workflows/`: pass, from a cloud session

The push of `7a03dff` (a new `.github/workflows/probe-705.yml`) to `throwaway/705-review-probe` was
accepted (`* [new branch]`), so the GitHub proxy and the admin's connected credential allow a
workflow change. A routine runs on the same proxy and credential (routines docs, "Repositories and
branch permissions"), so D14 holds as written: code-owned paths, workflows included, are allowed and
held by code-owner review. Two proxy limits the design must respect: it refuses branch deletions and
tag pushes, and it doesn't limit which branch a push updates (rulesets do).

## 5. The Supabase stack and Playwright Chromium: the stack yes, the pinned browser no

In this session's environment, in order:

1. `pnpm db:start` failed at once: `supabase/db.sh: line 32: supabase: command not found`. Docker's
   client is installed, but no daemon ran:
   `failed to connect to the docker API at unix:///var/run/docker.sock`.
2. `dockerd` started by hand in the background was ready in under 30 s (Docker 29.9.3, overlayfs).
3. The Supabase CLI 2.122.0, fetched as `.github/actions/supabase-cli` does (GitHub release, SHA-256
   checked: `OK`), onto `PATH`.
4. `pnpm db:start`: 1 min 57 s cold, 12 containers, keys hidden by `db.sh`. `pnpm db:status`:
   exit 0. `pnpm db:reset` and `pnpm db:env` succeeded. The image pulls worked from this
   environment; the Billetto spec warns that public.ecr.aws and Docker Hub hit rate limits from the
   shared cloud IP, so the factory's environment should pull from ghcr.io
   (`pkg-containers.githubusercontent.com`).
5. `pnpm --filter @sunny-pastures/web build`: passed.
6. Playwright: the repo pins `@playwright/test` 1.65.1, which wants Chromium build 1255; the
   environment carries 1243. `playwright install chromium` was refused by the network policy:
   `request blocked: no rule or allowlist entry allows host "cdn.playwright.dev"`.
7. With build 1243 standing in for 1255, `playwright test --project chromium-desktop` on
   `e2e/farm.test.ts` launched Chromium and loaded the page, then failed: "Your farm could not be
   loaded". The build lacked `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
   which `ci / ui` reads from `.env`; this unattended session's permission check denied the command
   that read them, so the UI test's pass wasn't reached.

**Verdict:** Docker and the stack work once the daemon and the CLI are there; Chromium runs; the
pinned browser can't be installed under this network policy. The factory's setup script adds what
this lacked (`admin-setup.md`, step 2): the daemon started per session, the pinned CLI, the pinned
Chromium with `cdn.playwright.dev` and `playwright.download.prss.microsoft.com` allowed, and a repo
script that builds the app for the stack from `.env`, so no agent reads `.env` by hand (a build
ticket). The later session reruns this check in the factory's environment and records it here.

## 6. The #605 retry: waiting on admin setup

**Steps:** once the routine exists (`admin-setup.md`) and `/factory` has its minimal form (the build
ticket "the `/factory` command"), the admin re-labels #605 `factory:ready` after removing
`factory:failed`, and the later session fires the routine with text `issue 605` (from check 1's
probe workflow, or **Run now** with that text). **Evidence:** the session URL; either the PR opened
as `sunny-factory[bot]` (its number, and `user.login` from
`gh api repos/sssoto17/sunny-pastures/pulls/<N> --jq .user.login`) or the `FACTORY stopped:` comment
on #605; and the run's Stop-hook refusals, if any, from the transcript. **Fails if** the run ends
`FACTORY ready` with no PR, or ends with no `FACTORY` line.

## 7. The Stop-hook check: pass

`.claude/hooks/factory-stop-check.mjs`, a `Stop` command hook in `.claude/settings.json`. When the
last line of the final message that starts with `FACTORY ` starts with `FACTORY ready`, it returns
`{"decision": "block", "reason": …}` unless the named branch exists, has commits beyond
`origin/main` and the tree is clean. It acts only in a factory run: `GITHUB_ACTIONS=true` with
`GITHUB_WORKFLOW=factory` (today's `factory.yml`) or `FACTORY_RUN=1` (the routine's environment).
Why a command hook in Node, and the alternatives: ADR-0012, section 7.

```text
$ bash .claude/hooks/factory-stop-check.test.sh
factory-stop-check.test.sh: 27 passed, 0 failed
```

The #605 fixture is a clone whose `main` is 2 commits past `origin/main` with no
`605-chicken-pen-feed-eggs` branch, and a transcript holding the denied chained
`pnpm boundaries; git switch -c 605-…; git commit …` with the Fallow gate's error, ending
`FACTORY ready: 605-chicken-pen-feed-eggs`. The hook blocks with "branch 605-chicken-pen-feed-eggs
doesn't exist (HEAD is main, 2 commits past origin/main)", the fix (`git branch <N>-<slug>`) and the
way out (`FACTORY stopped: <reason>`). Two mutants each turn tests red: dropping the branch check (4
fail) and acting outside a factory run (5 fail).

**Under today's `factory.yml`.** The hook needs no workflow change: the Claude step runs
`claude-code-action`, which loads the project's settings and their hooks, with
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which strips credentials only, so `GITHUB_ACTIONS` and
`GITHUB_WORKFLOW` reach the hook (the coordinator hook already reads `GITHUB_ACTIONS` there). The
run's CLI is 2.1.325 (run 45928803367's log), whose Stop input carries `last_assistant_message`; the
hook falls back to the transcript when it doesn't. A block costs turns from `--max-turns`, and
Claude Code ends the turn itself after 8 blocks in a row with no tool call between them. **Not yet
seen in a live run:** the first factory run after the merge shows it.

## Build tickets

Filed in Backlog under #58 on 28 Nov 2026, each with a proposed type, Priority, Size and Week in its
body (the cloud proxy refused the Project, so each carries `triage` until `scripts/issue-fields.sh`
runs from a local session):

- M5 Playtest 1, since checks 1, 2 and 6 run on them: #706 (the sweep fires the routine, wakes on
  `factory-done`), #707 (`/factory`, issue mode), #708 (`factory-route.mjs`).
- Tooling backlog: #709 (personas), #710 (the sweep's triggers and order), #711 (revise and conflict
  modes), #712 (caps, Risk section, acceptance-path hook), #713 (improvement loop), #714 (build for
  the stack, Playwright pin check), #715 (retire `factory.yml`, after checks 1, 2 and 6).

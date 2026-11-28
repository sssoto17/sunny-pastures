---
status: proposed
---

# The factory as a routed Claude routine

The factory (ADR-0002, area 2, "What the factory is") stopped three times on one class of failure:
#646, #659, and #605's run
[45928803367](https://github.com/sssoto17/sunny-pastures/actions/runs/45928803367) on 27 Nov. Each
time the agent ended `FACTORY ready`, and a later job on another runner found the branch missing.
Every factory bug so far (#582, #635, #646, #659) sits at a seam between the agent and the runner
harness that `factory.yml` builds around it: the hand-off bundle, the dependency broker, the
read-only token, the actor check. Cloud lanes, which push and open their own PRs through
`scripts/open-pr.sh`, haven't hit these, and they made 49 of the last 60 merged PRs.

This ADR records the redesign the admin settled in a grill on 28 Nov 2026 (decisions D1-D16, in
spike #705's body): the factory moves from `factory.yml` on a GitHub-hosted runner to a Claude Code
routine, the sweep stays the only dispatcher, and the routing is code. It amends ADR-0002's identity
decision (ADR-0002, area 2, "The factory's identity"; here, section 6). **Status: proposed.** The
runtime (sections 1 and 6) is adopted only if spike #705's checks 1, 2 and 6 pass
(`docs/spikes/factory-routine/findings.md`); if 1, 2 or 6 fails, `factory.yml` stays and gains only
the Stop-hook check (section 7). Sections 2-5 and 7 don't depend on the runtime and go ahead either
way, as the build tickets under #58.

## Patterns

- **Command composition** (Osmani, `agent-skills`, `docs/agents.md`: "the user (or a slash command)
  is the orchestrator"): one repo command, `/factory`, composes the existing commands and skills
  (triage, `/plan`, `/build`, a `/ship`-style review) in the main session. Personas never call
  personas, and subagents only check.
- **Parallel fan-out** (`/ship`): the review personas run in one turn as parallel, read-only,
  foreground subagents, and the main session merges their reports into one go/no-go.
- **Routing table as a deterministic state machine** (D8): a script with no model maps the event,
  the labels and the touched paths to the required steps; the run's mode and its steps are states,
  and the Stop hook checks the run against the route. The `factory:*` labels stay the issue's state
  machine (ADR-0002, "The factory sweep, built").
- **Dispatcher with single-flight** (D16): the sweep alone decides what runs, one run at a time,
  under a concurrency group, with `factory:working` set before it fires, and it recomputes the order
  at each dispatch rather than keeping a queue.

## 1. Runtime and trigger (D2, D16)

- **A Claude Code routine with its own cloud environment, `sunny-factory`.** Its setup script is the
  one place for the factory's tools: Node and pnpm (Corepack, pinned), Supabase CLI 2.122.0,
  Playwright Chromium, and the network allowlist they need
  (`docs/spikes/factory-routine/admin-setup.md`). The environment sets `FACTORY_RUN=1`, which scopes
  the factory's hooks (section 7).
- **The sweep fires it.** `sweep.yml` stays the only dispatcher. From the runner it calls
  `POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire` with only `<mode> <N>` as
  `text`. The routine has no GitHub trigger and no schedule, so no run starts that the sweep didn't
  choose. The fire token is a secret in the environment `factory-routine`, which only `main` may
  use. A fire has no idempotency key, so the sweep never retries one that may have reached the
  server.
- **Risk: a sweep that a PR event starts may not reach the token.** A `pull_request_review` run
  (D11) runs on the PR's ref, not `main`, so the `factory-routine` environment, which admits `main`
  only, would refuse it the secret. The likely fix: route the review event onto `main` through
  `repository_dispatch` or `workflow_run` (both run `main`'s copy) and fire from there. #710 must
  solve it (#716 review).
- **The routine wakes the sweep.** Its last step sends `repository_dispatch: factory-done`.
- **Limits (D16):** one run at a time; the open-PR cap stays 4, and a PR run (revise, conflict) is
  exempt; `FACTORY_ENABLED` stays the kill switch, read before the fire.

## 2. Events and order (D9, D11)

- **Triggers of `sweep.yml`:** `issues: labeled` with `factory:ready`;
  `pull_request_review: submitted` when the review requests changes; `push` to `main`, which scans
  each factory PR's `mergeable`; `repository_dispatch: factory-done`; and the hourly schedule, which
  is also the stale check. The `pull_request_review` event reaches the fire step only through `main`
  (section 1, the risk on the token).
- **Order:** PRs before issues. Among PRs, conflicts before revisions. Among issues: Priority, then
  Week, then Size (S, M, L), with no open native blocker and no `blocked:*` label. The sweep
  recomputes the order at each dispatch, so no queue label exists.

## 3. Routing and modes (D3, D4 in D5, D5, D6, D8, D11, D12, D15)

- **Code decides the route (D8).** `factory-route.mjs`, with no model, picks the required steps from
  the event, the type and area labels and the touched paths, and runs again after the build, when
  the paths are known. The agent may add verification, never skip a required step.
- **Issue mode, triage (D3):** only an issue whose decisions are made enters. An open decision ends
  the run with `FACTORY stopped: needs decision: <question>`, the question posted on the issue, and
  a `blocked:*` label. The run never waits for an answer.
- **Issue mode, the cycle (D5; D4 has no item of its own in #705's body: it is folded in here, as D5
  amends D4):** the routine runs `/factory issue <N>`: triage, `/plan`, `/build auto`, then the
  fan-out of Osmani's personas `code-reviewer`, `security-auditor` and `test-engineer` (with
  `accessibility-auditor` and `web-performance-auditor` on UI), copied into `.claude/agents/`,
  read-only by their tool lists, and given `REVIEW.md` and `CONSTRAINTS.md`. Then the merge and
  go/no-go, Required findings back to `/build`, then `scripts/open-pr.sh`.
- **The plan (D6)** and its todo live in one `**Factory plan**` comment on the issue, edited in
  place, never in git.
- **Revise mode (D11):** acts only on unresolved threads and review bodies from `sunny-reviewer` and
  the admin since the last round, never on anyone else's text (the repo is public). It ends with one
  plain PR comment mapping each finding to its commit. No thread replies or resolves:
  `block-thread-resolve.sh` stays, and the reviewer resolves its own threads on re-review.
- **Conflict mode (D12):** merge `origin/main` in (no rebase, no force-push), resolve, push. No
  in-run review or tests, unless a code hunk's resolution is neither side verbatim: then
  `check:fast` and the related unit tests. A lockfile is regenerated. A conflict plus changes
  requested is one revise run.
- **The starting route table (D15).** Rows add up:

<!-- prettier-ignore -->
| Diff touches | Required steps | Personas |
|---|---|---|
| any code | `check:fast`, `test:related` | code-reviewer |
| docs only | `format:md` | code-reviewer |
| `packages/sim/**` | `check:task` | + test-engineer |
| UI | + Playwright Chromium, a screenshot as visual proof | + accessibility-auditor, web-performance-auditor |
| server, db, api, `supabase/` | + `db:start`, `db:check`, `test:acceptance` (read-only) | + security-auditor, test-engineer |
| `.github/**`, `scripts/**` | + workflow lint, `.github/scripts/tests` | + security-auditor |

## 4. Gates and limits (D1, D2, D7, D10, D14)

- **The boundary (D1):** from `factory:ready` to ready-to-merge.
- **The approval that counts (D2)** stays the CI reviewer (`review.yml`, `REVIEW.md`). In-run review
  is a pre-check.
- **Escalation (D10):** the `CONSTRAINTS.md` escalation rows decide `review:admin`. The factory
  writes a "Risk" section into the PR body and may add `review:admin`, never remove it.
- **Caps (D7):** 2 in-run review rounds, after which the PR opens with the open findings under
  Concerns; 2 CI-reviewer fix rounds per PR, counted in the plan comment; 3 hours per run, after
  which the sweep marks `factory:failed` with the session URL. At a cap: `review:admin`, one comment
  naming the findings, and the slot frees.
- **Paths (D14):** code-owned paths, `.github/workflows/` included, are allowed and held by
  code-owner review; spike check 4 showed a cloud session may push a workflow change.
  `tests/acceptance/**` stays forbidden, by a `PreToolUse` hook backed by `guard / acceptance`.

## 5. The improvement loop (D13)

- Every run writes a `Report` block in the plan comment: mode, route, steps, added steps, rounds,
  caps, denials with their reasons, stop reason, wall time.
- The sweep appends stops, caps, timeouts and failures to the Retro inbox (#55), and flags a class
  seen twice (`AGENTS.md`, "A mistake that happens twice").
- The factory never edits its own command, routes, hooks or personas during a run.
- The metric: admin touches per merged factory PR.

## 6. Identity: amends ADR-0002 (#705, "Runtime and trigger", the Identity item; untagged)

ADR-0002 (area 2, "The factory's identity", decided 8 Nov in #37) gave the factory its own App,
`sunny-factory`, running from Actions, so that GitHub sees a factory PR as someone else's, with a
read-only `GITHUB_TOKEN` and a publish job on a runner that never ran the model. **Amended:**

- **The PR opens as `sunny-factory[bot]`** through `scripts/open-pr.sh` → `open-pr.yml`, as every
  lane's does since #336 and as the Billetto factory's `factory-open-pr.yml` does. The admin stays a
  reviewer of the PR, not its author, so code-owner review and `review:admin` work unchanged.
- **Commits and pushes are the admin's account,** as a cloud lane's are: a routine acts through the
  admin's connected GitHub identity (what a routine does through it "appears as you", routines
  docs). The commits are no longer `sunny-factory[bot]`'s, so the sweep's provenance test (a factory
  PR is one with at least one commit by the App's bot user) needs a new marker; the build ticket for
  the sweep picks one (the branch's `<N>-` prefix with the plan comment, or a commit trailer).
- **The read-only token GitHub enforced** is replaced by deny rules and hooks: the session holds the
  admin's write access, so `.claude/settings.json`'s deny rules, `block-thread-resolve.sh`, the
  acceptance-path hook and the Stop hook are what hold it. ADR-0002's "The honest limit" now covers
  the factory too: any session on the admin's account is the admin to GitHub, so these are standards
  plus checks, not a boundary. The boundary that remains is GitHub's: rulesets on `main`, code-owner
  review, `guard / code-owned` and the reviewer App.
- **What goes:** `factory.yml`'s hand-off bundle, the dependency broker (#635), the publish job and
  `allowed_bots` (#582), once the routine runs (a build ticket retires `factory.yml`).

**Alternatives the admin rejected:**

- **A routine on a GitHub label trigger** (the Billetto factory: "Issue: Labeled" with
  `factory:ready`). Each added label starts its own session, so a picking run must stop on `busy`
  and the factory needs a stop script, a second routine for PR labels, a label handshake for draft
  PRs and per-hour event caps. With the sweep as the one dispatcher, one fire is one chosen run.
- **An LLM router** (Warp's "Build a self-improving software factory", whose triage stage has a
  model choose the route). A model can skip a required step on a plausible reading; a table can't,
  and its decisions can be tested on fixtures, as the sweep's are.
- **The Ralph loop** (Huntley: a bash loop feeding the same prompt to fresh contexts until done). It
  has no stop condition but the model's, and no route; Huntley himself: "There's no way in heck
  would I use Ralph in an existing code base". The routine's run is bounded by the caps in section 4
  and ends with a `FACTORY` line that the Stop hook checks.
- **Keep `factory.yml` and fix each seam** (the status quo, #646, #659). Each fix added harness, and
  the next failure came from the next seam. It stays the fallback if checks 1, 2 or 6 fail.

## 7. The Stop-hook check (spike check 7)

`.claude/hooks/factory-stop-check.mjs`, registered under `Stop` in `.claude/settings.json`: when the
last line of the final message that starts with `FACTORY ` starts with `FACTORY ready`, the hook
returns Claude Code's block decision, with the reason, unless the named branch is a `<N>-<slug>`
branch that exists, has commits beyond `origin/main` and the tree is clean. Claude then carries on
with the reason. The loop has two bounds: the hook refuses at most 3 times per session (a count in a
file under the temp folder), then lets the turn end with a warning; and Claude Code's own cap,
"after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block
and ends the turn. The count of consecutive continuations resets each time Claude calls a tool"
([hooks docs](https://code.claude.com/docs/en/hooks), "Stop input", read 28 Nov 2026), which alone
doesn't bound a run that calls a tool between blocks. It acts only in a factory run:
`GITHUB_ACTIONS=true` with `GITHUB_WORKFLOW=factory` (today's `factory.yml`) or `FACTORY_RUN=1` (the
routine's environment); every other session gets no output. It ships now, whatever the spike
concludes, and needs no change to `factory.yml`. Tests: `.claude/hooks/factory-stop-check.test.sh`,
on a fixture shaped like run 45928803367.

Alternatives considered: a `prompt` or `agent` Stop hook (a model judging the claim, the LLM-router
problem again, and a cost on every stop); a `PreToolUse` check on `git commit` (it can't see the
claim, and #605's commits did run, on `main`); a check in a later workflow step (what `factory.yml`
already has: it finds the missing branch only after the agent can no longer fix it); bash with `jq`
like the other hooks (Node reads the hook's JSON and the transcript without a parser of our own, as
`deny-prompts-when-remote.mjs` does); and scoping by `CLAUDE_CODE_REMOTE` (lanes set it too).
Pattern: a **postcondition guard** on the turn's end, checked against the observed git state rather
than the agent's account of it.

## Consequences

- The factory runs where lanes run, so a fix to a lane's tooling reaches it, and the seams that
  `factory.yml` built (hand-off, broker, publish, actor check) leave once the routine is adopted.
- Factory commits are the admin's, so "what the factory did" is read from the plan comment's
  `Report` and the PR's opener, no longer from commit authors.
- The sweep holds a fire token that can start runs on the admin's subscription: it sits in an
  environment only `main` may use, and the routine accepts only `<mode> <N>`.
- Runs draw down the admin's Claude Code subscription, as lanes do; the routine's hourly limits (30
  fires per routine) are far above one run at a time.
- Until checks 1, 2 and 6 run, this ADR stays proposed: `factory.yml` doesn't change, and the one
  thing that ships is the Stop hook in `.claude/`.

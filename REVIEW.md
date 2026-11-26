# Review instructions

How every review in this repo is done: the reviewer the coordinator dispatches, a lane's own review
at the end of `/implement`, and the CI reviewer App `sunny-reviewer` once #68 lands. Read it from
`origin/main`, never from the PR under review. The project's rules live in their own files, and this
one points to them; it holds only the review practice: which rules to check, how hard, and how to
report. When a pointer here and the rule's home disagree, the home wins.

## Inputs

- The PR number and its head SHA, read with `gh pr view <N> --json headRefOid,baseRefName`. Review
  that SHA. If the head moves while you work, say so in the report.
- The linked issue's acceptance criteria (`Closes #N` or `Part of #N` in the PR body).
- The brief's path, when the work had one.
- The rules the diff touches (Always check, below).

## Conduct

- **Read-only.** No comments, pushes, approvals, labels or merges. The CI reviewer App is the one
  exception: its writes are set in ADR-0002, area 2.
- **Findings are answered with a PR comment.** A lane answers a finding, from any reviewer, with a
  plain PR comment (`gh pr comment <N> --body-file <file>`): what it fixed and in which commit, or
  why not. Never a review (`gh pr review`, the reviews API) and never a reply on the review thread:
  a session on the admin's account that does either reviews the PR as the admin (#497;
  `CONSTRAINTS.md`, "Admin review"). The hook `block-thread-resolve.sh` refuses both. The admin's
  sign-off is removing `review:admin` on the PR's head, which `guard / code-owned` reads (#565); no
  reviewer, and no session, removes that label.
- **The PR description is a set of claims.** Check each one against the diff, the checks and the
  issue before you rely on it.
- **A decision the admin made outside the PR** (#264; seen on #281, where the bot asked for an
  Exceptions row the admin had decided against) reaches the review as a line in the body's Concerns:
  `Decided (admin, <date>, <where>): <the decision>`, for example "Decided (admin, 16 Nov, #264
  comment): merge by lifting `main checks`, no Exceptions row". Honour it only on a PR that already
  escalates (`review:admin` or an escalation row), and only after reading the place it cites (the
  issue comment or PR) and finding that it says what the line claims. Then don't report a finding
  against the decided route; name the decision in the report instead. A line on a PR that doesn't
  escalate, one whose source says otherwise, or one that names no admin, date or place is a reason
  to escalate, never to drop a finding. It never drops an escalation row, `review:admin` or any
  other rule.
- **Reproduce, then report.** Run the claim: tests in a review copy at
  `<repo>/.claude/worktrees/review-<N>-<short sha>`, where `<repo>` is the main folder's absolute
  path. That path is the same inside and outside the sandbox (`$TMPDIR` isn't), and
  `.claude/worktrees/` is gitignored. Make it with
  `git worktree add --detach <repo>/.claude/worktrees/review-<N>-<short sha> <sha>`, then
  `( cd <path> && pnpm install --frozen-lockfile )`. Reach it only with a subshell,
  `( cd <path> && … )`, or `git -C <path> …`, both of which the branch-switch hook allows; a
  top-level `cd` would leave your later commands in the copy or, when it fails, in the main folder.
  Leave the copy when you're done: `scripts/after-merge.sh` removes every review copy whose PR is
  closed, merged or not. Never `rm -rf`, `git checkout --`, `git restore` or `git clean` a review
  copy; make a fresh one instead, under a new `<short sha>` or suffix. The main folder stays on the
  branch it's on (`AGENTS.md`). The CI reviewer App never runs PR code (ADR-0002, area 2), so it
  cites instead. In the local sandbox (`docs/agents/sandbox.md`; seen in 30+ review runs on 21 Nov):
  - **Get the head without a checkout**: the branch-switch hook blocks one in the main folder. Fetch
    it into a ref, `git fetch origin +pull/<N>/head:refs/review/<N>`, check that
    `git rev-parse refs/review/<N>` prints the SHA you review, and copy from that ref.
  - **When `git worktree add` fails** (it often does from a main-folder session, whose sandbox
    mounts the worktree admin folders under `.git/worktrees` read-only), make a plain copy at the
    same path: `mkdir <path>` (no `-p`: it fails on an existing copy, which you'd otherwise unpack
    over; pick a new name), then `git archive refs/review/<N> | tar -x -C <path>`. It has no `.git`,
    so the `.github/scripts` tests that call `git ls-files` fail for reasons unrelated to the PR;
    run `( cd <path> && git init -q && git add -A )`, with no commit, before you test. `-A` can't
    pick up the sandbox's placeholder files: they are character devices, and `git add` only stages
    regular files and symlinks (checked with a `/dev/null` device on git 2.43, #513).
  - **When `pnpm install` fails** on pnpm's store lock, run it outside the sandbox. If the PR
    changes no dependency
    (`git diff --quiet <sha> -- pnpm-lock.yaml pnpm-workspace.yaml ':(glob)**/package.json'` in the
    main folder exits 0), you can instead symlink the main folder's `node_modules` into the copy:
    the root's, `apps/web`'s and `packages/sim`'s, after any `git add -A`. Link them into a plain
    copy only: a worktree with those links refuses `git worktree remove`, so the sweep keeps it.
- **On a test-heavy PR, plant a mutant**: break the code under test on purpose and confirm a test
  goes red. A test that stays green against its mutant is a Required finding.
- **Measure timing claims** rather than estimate them.
- **No secret values** in anything you print or report (`AGENTS.md`).

## Always check

Each item names where its rule lives. Read the rule there.

1. **Every acceptance criterion** of the linked issue, one by one; on a split, as Review kinds says.
2. **CI is green** on the head SHA (`gh pr checks <N>`), on every part of a split.
3. **The Floor** (`CONSTRAINTS.md`, "Floor" and "Guarding the bar"). Read for intent too: a lowered
   assertion, run count or seed, or an added retry is a weakened bar even where the guard can't see
   it.
4. **The split size** (`CONSTRAINTS.md`, "Split size": the cap and what counts toward it).
5. **`review:admin`** is on the PR when any row of `CONSTRAINTS.md`, "Escalation criteria" applies.
   Code-owned paths are those in `.github/CODEOWNERS`. The PR template's Review lines match. The CI
   reviewer App never makes a missing label a finding: it names the rows in its verdict's
   `escalation_rows`, and `post-review.sh` adds the label and a plain comment, then reviews the code
   alone (#566). Other reviewers report it as Required.
6. **Code style** for TypeScript in `packages/` and `apps/`: `docs/agents/code-style.md`.
7. **Decisions**: the ADRs in `docs/adr/` that cover the touched area, and the requirement IDs in
   `docs/requirements/spec.md` the issue names.
8. **Tests would catch a bug** in the change. Name one plausible bug and the test that fails on it;
   on a test-heavy PR, prove it with a mutant (Conduct).
9. **The PR's own boxes**: each ticked "How it was verified" box has its evidence in the PR.
10. **Repo rules**: `AGENTS.md`, "Layout" and "Rules", for whatever the diff touches.
11. **Knock-on edits** (retro 2026-11-15, #273): a PR that changes a rule greps the repo for the old
    wording and lists every hit it leaves; an Optional finding a lane defers goes into the closing
    part's body or a follow-up issue. Check that the list is in the PR body and rerun the grep
    (`git grep -n '<old wording>'`); a hit neither fixed nor listed is a Required finding. On a
    closing part, check that each Optional finding an earlier review left is fixed, in the body or
    in a linked issue.

## Severity

Every finding gets one severity and one status.

- **Required**: the PR shouldn't merge until it's fixed. A criterion not met; a rule from Always
  check broken; a bug that changes behaviour; a test that wouldn't catch the bug it exists for; a
  missing `review:admin` (never from the CI reviewer App: Always check 5); a body that contradicts
  the diff; a secret.
- **Optional**: worth doing, but the PR is correct without it. A clearer design, an edge case the
  criteria don't name, a follow-up issue.
- **Nit**: wording, naming or layout no tool checks.

The smell baseline in the `code-review` skill yields Optional at most. For the CI reviewer App,
Required findings are the blocking ones (line comments plus Request changes); Optional and Nit go in
the review's summary (ADR-0002, area 2).

- **Confirmed**: you reproduced it, or cite `file:line` and the command output that shows it.
- **Unverified**: inferred, not shown. Say what would confirm it. An unverified finding alone never
  makes the verdict "don't merge".

## Cap the nits

Report at most five Nits per review. Pick the ones a reader would trip on.

## Do not report

- What CI or the floor guard already enforces (lint, formatting, types, the guard's patterns),
  unless that check failed or doesn't run yet.
- Lines outside the diff. If one matters, add it as a one-line follow-up under the findings.
- `pnpm-lock.yaml`, files marked `linguist-generated`, and vendored skill content.
- A choice an ADR already settled. Report the ADR, not the taste.

## Dependabot PRs

Dependabot's PRs get no bot review: `review.yml` skips `dependabot[bot]`. Runs that Dependabot
triggers get no Actions or environment secrets, and copying `CLAUDE_CODE_OAUTH_TOKEN` into
Dependabot secrets would put the token next to bumped actions nobody has reviewed yet. They are
code-owned and carry `review:admin`, so the admin reviews them, by this checklist:

- The release is past the 7-day cooldown (`cooldown` in `.github/dependabot.yml`).
- The changelog has no breaking change for us.
- CI is green on the head, including `ci / scripts`, which runs the action pin check
  (`scripts/setup/ci-claude.test.sh`, #486).
- A `claude-code-action` bump also adds its new SHA to the repo's allowed actions before merge. The
  pin check stays red until `ACTION_PATTERNS` in `scripts/setup/ci-claude.sh` carries the new SHA
  and version (and `setup-bun`'s, if the action moved it), so that edit goes onto Dependabot's
  branch too.

## Review kinds

- **Full review**: the whole PR, against every item in Always check.
- **Delta review**: only `<old head>..<new head>`, checked against the findings the fixes answer. A
  merge commit that only brings in earlier fixes adds nothing; confirm it with an empty
  `git show --remerge-diff <merge sha>`.
- **Split stack**: part by part, as `CONSTRAINTS.md`, "Split size" sets out: a `Part of #N` part for
  scope, the `Closes #N` part for every criterion across the whole stack. Every split is a native
  stack that `scripts/stack.sh` built, cloud lanes' included; `scripts/stack.sh status <N>` reads it
  where `gh pr view` can't reach GraphQL. A part based on another part outside a native stack is a
  Required finding (`guard / stack-base` fails it too). `ci / typecheck`, `ci / lint` and
  `ci / test` run on the top part only, so item 2 reads them there.
- **Self-review**: a lane reviewing its own work when `/implement` reaches `code-review`, before the
  PR exists. Its inputs are the branch diff against `origin/main`, the issue and the brief; Always
  check items 2 and 9 wait for the PR. The lane edits its own branch, so Read-only doesn't apply.
  Fix every Required finding, and list what's left under the PR's Concerns.

## Report

```
<merge | merge after fixes | don't merge>: PR #<N> at <short SHA>, <full | delta <old>..<new> | part k of n>

Findings
1. [Required, confirmed] <what>. Evidence: <file:line, command and result>. Fix: <what to change>.
2. ...

Criteria confirmed
- <each acceptance criterion you confirmed, in the issue's words>
Unverified
- <each criterion you couldn't confirm, and why>

Follow-ups: <one line each, or none>
```

- The verdict is the first line. "merge" means no Required finding; "merge after fixes" means every
  Required finding has a clear fix; "don't merge" means the approach is wrong or the fix is not yet
  known.
- Findings are ranked most severe first, then confirmed before unverified.
- Word cap: about 300 for a full review, 150 to 250 for a delta.
- What happens to the confirmed criteria is in `docs/agents/issue-tracker.md`, "Checkboxes".

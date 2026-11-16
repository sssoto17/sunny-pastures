# Review instructions

How every review in this repo is done: the reviewer the coordinator dispatches, a lane's own review
at the end of `/implement`, and the CI reviewer App `sunny-reviewer` once #68 lands. Read it from
`origin/main`, never from the PR under review. The project's rules live in their own files, and
this one points to them; it holds only the review practice: which rules to check, how hard, and
how to report. When a pointer here and the rule's home disagree, the home wins.

## Inputs

- The PR number and its head SHA, read with `gh pr view <N> --json headRefOid,baseRefName`. Review
  that SHA. If the head moves while you work, say so in the report.
- The linked issue's acceptance criteria (`Closes #N` or `Part of #N` in the PR body).
- The brief's path, when the work had one.
- The rules the diff touches (Always check, below).

## Conduct

- **Read-only.** No comments, pushes, approvals, labels or merges. The CI reviewer App is the one
  exception: its writes are set in ADR-0002, area 2.
- **The PR description is a set of claims.** Check each one against the diff, the checks and the
  issue before you rely on it.
- **Reproduce, then report.** Run the claim: tests in a temporary worktree under `$TMPDIR`
  (`git worktree add "$TMPDIR/review-<N>" <sha>`, then `pnpm install --frozen-lockfile`), removed
  with `git worktree remove` when you're done. The main folder stays on the branch it's on
  (`AGENTS.md`). The CI reviewer App never runs PR code (ADR-0002, area 2), so it cites instead.
- **On a test-heavy PR, plant a mutant**: break the code under test on purpose and confirm a test
  goes red. A test that stays green against its mutant is a Required finding.
- **Measure timing claims** rather than estimate them.
- **No secret values** in anything you print or report (`AGENTS.md`).

## Always check

Each item names where its rule lives. Read the rule there.

1. **Every acceptance criterion** of the linked issue, one by one; on a split, as Review kinds
   says.
2. **CI is green** on the head SHA (`gh pr checks <N>`), on every part of a split.
3. **The Floor** (`CONSTRAINTS.md`, "Floor" and "Guarding the bar"). Read for intent too: a
   lowered assertion, run count or seed, or an added retry is a weakened bar even where the guard
   can't see it.
4. **The split size** (`CONSTRAINTS.md`, "Split size": the cap and what counts toward it).
5. **`review:admin`** is on the PR when any row of `CONSTRAINTS.md`, "Escalation criteria" applies.
   Code-owned paths are those in `.github/CODEOWNERS`. The PR template's Review lines match.
6. **Code style** for TypeScript in `packages/` and `apps/`: `docs/agents/code-style.md`.
7. **Decisions**: the ADRs in `docs/adr/` that cover the touched area, and the requirement IDs in
   `docs/requirements/spec.md` the issue names.
8. **Tests would catch a bug** in the change. Name one plausible bug and the test that fails on
   it; on a test-heavy PR, prove it with a mutant (Conduct).
9. **The PR's own boxes**: each ticked "How it was verified" box has its evidence in the PR.
10. **Repo rules**: `AGENTS.md`, "Layout" and "Rules", for whatever the diff touches.
11. **Knock-on edits** (retro 2026-11-15, #273): a PR that changes a rule greps the repo for the
    old wording and lists every hit it leaves; an Optional finding a lane defers goes into the
    closing part's body or a follow-up issue. Check that the list is in the PR body and rerun the
    grep (`git grep -n '<old wording>'`); a hit neither fixed nor listed is a Required finding.

## Severity

Every finding gets one severity and one status.

- **Required**: the PR shouldn't merge until it's fixed. A criterion not met; a rule from Always
  check broken; a bug that changes behaviour; a test that wouldn't catch the bug it exists for; a
  missing `review:admin`; a secret.
- **Optional**: worth doing, but the PR is correct without it. A clearer design, an edge case the
  criteria don't name, a follow-up issue.
- **Nit**: wording, naming or layout no tool checks.

The smell baseline in the `code-review` skill yields Optional at most. For the CI reviewer App,
Required findings are the blocking ones (line comments plus Request changes); Optional and Nit go
in the review's summary (ADR-0002, area 2).

- **Confirmed**: you reproduced it, or cite `file:line` and the command output that shows it.
- **Unverified**: inferred, not shown. Say what would confirm it. An unverified finding alone
  never makes the verdict "don't merge".

## Cap the nits

Report at most five Nits per review. Pick the ones a reader would trip on.

## Do not report

- What CI or the floor guard already enforces (lint, formatting, types, the guard's patterns),
  unless that check failed or doesn't run yet.
- Lines outside the diff. If one matters, add it as a one-line follow-up under the findings.
- `pnpm-lock.yaml`, files marked `linguist-generated`, and vendored skill content.
- A choice an ADR already settled. Report the ADR, not the taste.

## Review kinds

- **Full review**: the whole PR, against every item in Always check.
- **Delta review**: only `<old head>..<new head>`, checked against the findings the fixes answer.
  A merge commit that only brings in earlier fixes adds nothing; confirm it with an empty
  `git show --remerge-diff <merge sha>`.
- **Split stack**: part by part, as `CONSTRAINTS.md`, "Split size" sets out: a `Part of #N` part
  for scope, the `Closes #N` part for every criterion across the whole stack. Cloud lanes can't
  link native stacks; the coordinator links them locally.
- **Self-review**: a lane reviewing its own work when `/implement` reaches `code-review`, before
  the PR exists. Its inputs are the branch diff against `origin/main`, the issue and the brief;
  Always check items 2 and 9 wait for the PR. The lane edits its own branch, so Read-only doesn't
  apply. Fix every Required finding, and list what's left under the PR's Concerns.

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

- The verdict is the first line. "merge" means no Required finding; "merge after fixes" means
  every Required finding has a clear fix; "don't merge" means the approach is wrong or the fix is
  not yet known.
- Findings are ranked most severe first, then confirmed before unverified.
- Word cap: about 300 for a full review, 150 to 250 for a delta.
- What happens to the confirmed criteria is in `docs/agents/issue-tracker.md`, "Checkboxes".

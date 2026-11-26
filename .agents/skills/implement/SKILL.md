---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

The PR closes its issue, and only that issue: `Closes #N` for the branch's `<N>` (`Part of #N` only on an earlier part of a split, `CONSTRAINTS.md`, "Split size"), no other closing keyword anywhere in the body, and `Also closes #M` on a line of its own only when this PR really completes #M too (`docs/agents/issue-tracker.md`, "Closing issues"; `guard / pr-body`). If a criterion turns out to need the admin after the merge (a live demo, a repo setting, a workflow that only runs from `main`), file it as a verify issue as that doc's "Verify issues" says, leave it unticked, and name the verify issue in the PR's Concerns. Never leave the original issue open for it.

A follow-up issue you file for CI, tooling or workflow work goes to the **Tooling backlog** milestone unless it blocks product work in this issue's milestone (`docs/agents/issue-tracker.md`, "Tooling backlog").

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "code-review" to review the work.

Commit your work to the current branch.

When the work is ready for review, push the branch and open its PR with `scripts/open-pr.sh <branch> <body-file>` (a stack with `scripts/stack.sh`), never `gh pr create`: the PR then comes from `sunny-factory[bot]`, so the admin can approve it (#336).

Answer each review finding on the PR with a plain PR comment (`gh pr comment <N> --body-file <file>`), never a review (`gh pr review`) or a reply on the review thread, and never resolve a thread: a review from a session on the admin's account signs the PR off as the admin (REVIEW.md, Conduct; #497).

Keep the PR body true to the head. With each fix push, before you ask for review again, re-read the whole body (What and why, Changes made, Not touched, Concerns) against `git diff origin/main...HEAD` and fix every line the diff no longer bears out. The push itself starts the reviewer App's next run, which reads the body once, so do it after the fix commit and before the push: edit the body file, apply it with `gh api -X PATCH repos/sssoto17/sunny-pastures/pulls/<N> -F body=@<body-file> --silent` (REST, so it works in cloud sessions; no allow rule matches it, so it prompts locally), then push. A body that contradicts the diff is a Required finding (REVIEW.md, Severity).

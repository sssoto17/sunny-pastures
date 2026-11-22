---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

The PR closes its issue, and only that issue: `Closes #N` for the branch's `<N>`, no other closing keyword anywhere in the body, and `Also closes #M` on a line of its own only when this PR really completes #M too (`docs/agents/issue-tracker.md`, "Closing issues"; `guard / pr-body`). If a criterion turns out to need the admin after the merge (a live demo, a repo setting, a workflow that only runs from `main`), file it as a verify issue as that doc's "Verify issues" says, leave it unticked, and name the verify issue in the PR's Concerns. Never leave the original issue open for it.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "code-review" to review the work.

Commit your work to the current branch.

When the work is ready for review, push the branch and open its PR with `scripts/open-pr.sh <branch> <body-file>` (a stack with `scripts/stack.sh`), never `gh pr create`: the PR then comes from `sunny-factory[bot]`, so the admin can approve it (#336).

Answer each review finding on the PR with a plain PR comment (`gh pr comment <N> --body-file <file>`), never a review (`gh pr review`) or a reply on the review thread, and never resolve a thread: a review from a session on the admin's account signs the PR off as the admin (REVIEW.md, Conduct; #497).

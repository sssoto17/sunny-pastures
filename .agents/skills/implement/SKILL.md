---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "code-review" to review the work.

Commit your work to the current branch.

When the work is ready for review, push the branch and open its PR with `scripts/open-pr.sh <branch> <body-file>` (a stack with `scripts/stack.sh`), never `gh pr create`: the PR then comes from `sunny-factory[bot]`, so the admin can approve it (#336).

Answer each review finding on the PR with a plain PR comment (`gh pr comment <N> --body-file <file>`), never a review (`gh pr review`) or a reply on the review thread, and never resolve a thread: a review from a session on the admin's account signs the PR off as the admin (REVIEW.md, Conduct; #497).

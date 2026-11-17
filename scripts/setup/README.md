# Setup scripts

Scripts the admin runs by hand; each header says what it does. Runbooks of several commands:

## #336: lanes open PRs as sunny-factory

`scripts/setup/factory-app.sh`, on your own machine, before the throwaway test: it creates the
environment `factory-app` (only `main` may use it), walks you through a new sunny-factory key
(stored from the `.pem` through stdin, then the file is deleted), sets the client ID, and checks
the App's installation. It reads each result back and stops at the first failed check; re-running
is safe. The throwaway test's steps are in #336's PR, "For the admin".

## #68: the reviewer App's tests (a)-(f)

ADR-0002, admin checklist step 12. `ci-check.sh` opens throwaway PRs onto `main`, the real review
workflow reviews them, and `results 68` reads the outcome. Run from your own clone, outside the
sandbox (`git worktree add` and `git push`). Every PR it opens is a throwaway: titled
`THROWAWAY #68 (x):`, "Never merge" in the body. (a) and (c) also carry your open "Hold" thread,
which keeps them from merging once auto-merge is on; leave it open. `allow_auto_merge` stays off
until (a) has shown `APPROVED` (#68 asks for that first); then one fresh approval covers (b) and (d).

Before you start: the `post-review.sh` change that turns on auto-merge is merged to `main`; the
review runs from `main`'s copy (`pull_request_target`). `main`'s ruleset has 1 required approval,
stale-review dismissal and thread resolution (on since 12 Nov); `start 68` checks them.

| # | Command or step | By hand? | Wait | Tests |
|---|---|---|---|---|
| 1 | `scripts/setup/ci-check.sh start 68`, with `allow_auto_merge` off: (a)'s review logs `auto_merge=refused` | | 2-3 min a review | (a), (c), (e1), (f) |
| 2 | `scripts/setup/ci-check.sh results 68`: (a) must read `APPROVED` | | | read them |
| 3 | `gh api -X PATCH repos/sssoto17/sunny-pastures --silent -F allow_auto_merge=true` | yes | | (b) needs it |
| 4 | `scripts/setup/ci-check.sh push 68 a > .scratch/68-push-a.md`; it refuses unless 3 is done and (a) is approved | | 2-3 min | (b), (d) |
| 5 | `scripts/setup/ci-check.sh resolve 68` (once (e1) reads pass) | | up to 20 min, usually 3-5 | (e2) |
| 6 | Resolve (e)'s `escalated:` thread in the PR's UI | yes | | |
| 7 | `scripts/setup/ci-check.sh push 68 e` | | 2-3 min | (e3) |
| 8 | `scripts/setup/ci-check.sh results 68 > .scratch/68-results.md`, add step 4's line, then `gh issue comment 68 --body-file .scratch/68-results.md` | | | all |
| 9 | `scripts/setup/ci-check.sh cleanup 68` | | | closes the PRs unmerged |
| 10 | `gh api -X PATCH repos/sssoto17/sunny-pastures --silent -F allow_auto_merge=false`, unless Q16 holds | yes | | |

- **While auto-merge is on (steps 3-10),** every real PR the App approves gets auto-merge too, and
  merges once its checks are green. Keep the window short, and open no other PRs during it.
- **Follow the reviews** with `gh run list --repo sssoto17/sunny-pastures --workflow review.yml`.
  A row reads "not yet run" until its review has landed.
- **Step 5** pushes a workflow file, so gh needs the `workflow` scope:
  `gh auth refresh -h github.com -s workflow` (it prints a one-time code, not a token). As
  `sunny-factory`, the run resolves the thread, pushes one commit to (e), and waits for the
  reviewer: it fails unless the reviewer reopened the thread.
- **Step 6 before step 7:** (e3) passes when the thread is resolved by you and the App has
  reviewed the newest head. Resolve first, then push; a thread open again after step 7 is a fail.
- **"Not exercised" is never a pass.** The App never approves (f) (Code-owned path row, in code)
  and you can't approve (e) or (f) (you opened them). (f)'s code-owner hold rests on the ruleset's
  `require_code_owner_review` (`gh api repos/sssoto17/sunny-pastures/rules/branches/main`: `true`).
- **To run one test again,** fix the cause, then `cleanup 68` and start over from step 1. For
  step 5 alone, delete its branch first:
  `gh api -X DELETE repos/sssoto17/sunny-pastures/git/refs/heads/throwaway/68-factory-resolve`.

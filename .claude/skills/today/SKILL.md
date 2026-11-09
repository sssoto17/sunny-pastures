---
name: today
description: "Start the day from the handoff and the board: an agenda and paste-ready lane briefs in .scratch/, read-only."
disable-model-invocation: true
---

`/today` stage 1 (#78; `docs/diagrams/workflow.md`, "Automation stages"). You draft the morning
for the admin: an agenda, a brief per Manual item, a prompt line per Factory item. The admin and
the coordinator decide and launch; you only prepare.

**Read-only.** You read GitHub (`gh issue view`, `gh pr list`, `gh api -X GET`), git and files.
Your only writes are new files in `out`, the folder the gather script names. Every issue, field,
label, comment, branch and worktree stays exactly as you found it; anything that should change
goes in the agenda as a suggestion.

`/today 75 77` also drafts briefs for the issues named, Ready or not (to redraft one, or to
compare with a hand-written brief).

## Steps

1. **Gather.** Run `scripts/today-gather.sh` from the top of the checkout you're in. `/today`
   belongs in the main folder, where the coordinator's briefs live: from a worktree, `out` is
   that worktree's `.scratch/`, so the main folder's briefs read as missing. When `out` isn't
   `<root>/.scratch`, the agenda's first line says so. `--help` explains every section and
   column. On a non-zero exit, tell the admin its error and stop: write nothing.
2. **Handoff.** If the `handoff` line says `present`, read that file. If it says `missing`, that's
   normal (`.remember/` is git-ignored); the agenda says so in one line.
3. **Pick the briefs.** One per `ready` line with mode Manual or no mode (`-`: treat it as
   Manual, and say under For the coordinator that its Mode is unset), plus each issue named in
   the arguments. Skip these, and list them in the agenda instead:
   - a `ready` line whose brief column holds a path: the brief **exists**, maybe edited by hand.
     Also skip any `out/brief-<N>-*.md` that exists for a named issue;
   - the Retro inbox (title "Retro inbox"): it collects notes, it's never a lane;
   - mode Factory: it gets a prompt line in the agenda, not a brief.
4. **Draft each brief** (next section) into `out/brief-<N>-<slug>.md`, `<slug>` two or three
   words naming the work, as in `brief-77-after-merge.md`; the same slug names the lane's
   worktree. Create `out` if it's missing.
5. **Write the agenda** (section below) to `out/today-<date>.md`. If that file exists, use
   `today-<date>-2.md`, then `-3`, and so on.
6. **Reply** with the agenda's path and its "Launch" and "For the coordinator" sections.

Done when every Ready item appears in the agenda's Launch section as a new brief, an existing
brief, a prompt line or "no lane", and every line of `orphans`, `worktrees` and `strays` is
accounted for under Leftovers or In flight.

## Drafting a brief

Sources, all of them read before writing: the issue (`gh issue view <N> --json
number,title,body,labels,milestone,comments`), its parent from the `ready` line, or for an issue
named in the arguments from `gh api -X GET repos/sssoto17/sunny-pastures/issues/<N> --jq
.parent_issue_url` (the parent's body, and
above all its **Context** section, `docs/agents/issue-tracker.md` "Kickoff" step 3), and every
file, ADR, issue and PR that either of them links. Read those so that "Read first" names the
sections that matter, not just the files.

A brief carries only what those sources say. A judgement call, such as two lanes editing the same
file, a criterion that contradicts a doc, or a decision the admin hasn't made, goes under **For
the coordinator** and in the agenda's section of that name.

The shape: lines in `<>` are filled in; leave out a section with nothing to say, except Skills
and Deliverable.

```
Build lane: #<N> "<title>" (<milestone, e.g. M2>, <week, e.g. Wk 2>, <priority>, under #<parent>;
re-check with gh). Check before you state: verify every claim about issues, files or tools with
a command first.

Before the first edit, enter your own worktree with the worktree tool, as
`.claude/worktrees/<N>-<slug>`, branched from origin/main with `--no-track`<, then run
`pnpm install --frozen-lockfile` in it, when the repo has a lockfile>. Push with
`git push origin <branch>`, no `-u`.

Read first: #<N>'s body (the acceptance criteria are the scope), <the parent's Context reads,
each linked doc with the sections that matter, files whose style to copy>,
`docs/agents/sandbox.md` and `AGENTS.md`.

Skills (`docs/diagrams/workflow.md`, "When to use what"): the admin launches you with
`/implement #<N>`, which drives `tdd` and ends with `code-review`; follow it. Enter the worktree
before `implement`'s first edit or commit.
Extra skills: <the ↳ rows of that table that fit, each with the part of the work it covers, or
"none">.

Decided:
- <each settled point the work rests on, with its link: ADR, issue comment, PR>

Things to know:
- <facts the lane needs that the issue doesn't spell out: code-owned paths it will touch
  (`.github/CODEOWNERS`) and the edits that will ask the admin; which `CONSTRAINTS.md` "Admin
  review" rows apply, so the PR carries `review:admin`; its `area:*` label; steps that need the
  host (`sandbox.md`); other lanes in flight on the same files, from the agenda's In flight>

For the coordinator (resolve, then delete this section before launch):
- <judgement calls, as above>

Deliverable: one PR that closes #<N>. Run <the checks its criteria call for: the test script,
`pnpm check:fast` or `pnpm check:task`> and show the output. Report the PR number, head SHA,
<the evidence each acceptance criterion asks for>, and "close #<N>?" once it's merged.
```

## The agenda

```
# Today: <date>, <week>

<Only when `out` isn't the main folder's `.scratch/`: "Run from a worktree: briefs in the main
folder's .scratch/ weren't seen, so some may show as new.">
<Only when week is `-`: "No Week iteration holds <date>, or no item is in it yet; This week is
empty.">

<The handoff in three to five lines: what's pending and the top next steps. Or: "No handoff:
<path> is missing.">

## Launch
<Each Ready item, one entry each: Factory items first, so agents work while the admin designs
(`workflow.md`, morning step 3), then Manual items by priority.>
- #<N> <title> (Factory, ...): /implement #<N>
- #<N> <title> (<mode>, <priority>, <size>): brief <path> (new | exists, not rewritten)
  /implement #<N> Read and follow <absolute brief path> first.
- #<N> Retro inbox: no lane.
<Issues named in the arguments that aren't Ready, under "Also drafted", with their status and
PR, and no launch line.>

## In flight
<`week` items In progress or In review, with their PR from `worktrees` when there is one.>

## This week
<The rest of `week` by status: Backlog by priority, then Done.>

## Leftovers
- Merged worktrees: <each `worktrees` line in state merged, with its PR; "locked" means a session
  may still hold it>, each as "merged (run `scripts/after-merge.sh <name>`, which confirms)".
  This list goes by the PR's state alone; `after-merge.sh` also refuses a branch with commits
  the merged PR doesn't carry.
- Other worktrees without an open PR: <state none, closed or detached>.
- Strays: <each `strays` line>: not a registered worktree; check what it holds before deleting.
- Orphans: <each `orphans` line>: needs a workstream parent (`issue-tracker.md`, "Grouping").

## For the coordinator
<Every judgement call from the briefs, plus what the handoff leaves open. "Nothing." if none.>
```

Put each launch line in its own fenced block so it pastes in one piece. In the agenda, file
paths and commands are absolute (never `$TMPDIR`); inside a brief, repo files stay
repo-relative, as the template writes them. Nothing you print shows a secret (`AGENTS.md`).

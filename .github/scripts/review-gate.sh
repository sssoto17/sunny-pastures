#!/usr/bin/env bash
# Decides whether review.yml's job reviews this event, before Claude runs, so a head is reviewed
# once (#274; retro 2026-11-15, item F) and only while nobody who counts has approved it (#404).
# Writes run=true|false to GITHUB_OUTPUT and logs one GATE line.
# Tests: .github/scripts/tests/review-gate.test.mjs.
#
# Env: ACTION (github.event.action, for the log), BOT (the App's slug), ADMIN (the admin's login),
# DEFAULT_BRANCH, PR_JSON and REVIEWS (the PR and its reviews as gather writes them: head_sha,
# base, stack and labels; author, state, body, commit_id), BASE_FILES (read only when the base
# isn't DEFAULT_BRANCH: the paths the base changes since DEFAULT_BRANCH, from REST compare),
# GITHUB_OUTPUT. An unreadable file fails the step rather than guess.
set -euo pipefail

skip() {
  echo "GATE skip: $1 (event: $ACTION)"
  echo "run=false" >>"$GITHUB_OUTPUT"
  exit 0
}

head=$(jq -er .head_sha "$PR_JSON")
base=$(jq -er .base "$PR_JSON")
labelled=$(jq '.labels | index("review:admin") != null' "$PR_JSON")

# Stacked parts (#404; admin, 21 Nov 2026). The trigger takes every base, so a part of a native
# stack is reviewed on its own base. A PR on another base outside a stack is hand-chained, which
# `guard / stack-base` refuses, so it gets no review either. `stack` comes from GET pulls/<n>, not
# the event: the event's is null on `opened` (ADR-0002, "Stacks"). Parts open as drafts and are
# marked ready once linked (#358), so a ready part already has its stack.
if [[ $base != "$DEFAULT_BRANCH" ]]; then
  stacked=$(jq -e 'has("stack") and .stack != null' "$PR_JSON") || [[ $stacked == false ]]
  [[ $stacked == true ]] || skip "hand-chained: based on $base, not $DEFAULT_BRANCH, and in no native stack"
  # claude-code-action restores these paths from origin/<base.ref> before Claude starts
  # (SENSITIVE_PATHS in src/github/operations/restore-config.ts at the pinned SHA). Above part 1
  # that ref is the part below's branch, not yet merged, so a review there would run with config
  # nobody has reviewed. The compare lists at most 300 files: 300 may hide one, so it skips too.
  # Re-check this list against SENSITIVE_PATHS whenever review.yml's claude-code-action pin moves.
  restored=$(jq '(length >= 300) or any(.[]; test(
    "^(\\.claude|\\.mcp\\.json|\\.claude\\.json|\\.gitmodules|\\.ripgreprc|CLAUDE\\.md|CLAUDE\\.local\\.md|\\.husky)(/|$)"))' \
    "$BASE_FILES")
  if [[ $restored == true ]]; then
    echo "::warning title=No review on this stacked part::the stack below changes config that claude-code-action restores from the base ($base). Review it by hand (#404)."
    skip "restored config: the stack below $head changes a path the action restores from $base"
  fi
fi

# A head counts as reviewed only when this App posted a review on it with a non-blank body: the
# summary review, which post-review.sh posts last. Each line or file comment it posts first is a
# COMMENTED review of its own with an empty body (PR #280, 2a46ae8), so a run that died between
# its comments and its summary doesn't count, and the next event reviews the head again.
reviewed=$(jq --arg u "${BOT}[bot]" --arg head "$head" \
  'any(.[]; .author == $u and .commit_id == $head and ((.body // "") | test("\\S")))' "$REVIEWS")
# A head approved by the admin or by this App needs no review (#404). Only this head: a push
# after the approval is a new head. A dismissed approval reads DISMISSED, so it doesn't count.
head_approved=$(jq --arg bot "${BOT}[bot]" --arg admin "$ADMIN" --arg head "$head" \
  'any(.[]; .state == "APPROVED" and .commit_id == $head and (.author == $bot or .author == $admin))' \
  "$REVIEWS")
# The exception (ADR-0002, test (e)): review:admin on the PR while an approval of this App still
# stands means the label came after it (post-review.sh never approves a labelled PR), so the
# review runs again to dismiss it and turn auto-merge off. Whatever the event: a reopened run at
# the same head can cancel the labeled one (the job's cancel-in-progress) and must finish its
# work. A dismissed approval reads DISMISSED, so once a run has withdrawn it, nothing re-runs.
# Any commit counts, as post-review.sh's dismiss does. It wins over the two skips below.
approved=$(jq --arg u "${BOT}[bot]" 'any(.[]; .author == $u and .state == "APPROVED")' "$REVIEWS")

if [[ ! ($labelled == true && $approved == true) ]]; then
  [[ $head_approved != true ]] || skip "approved: the admin or ${BOT} already approved $head"
  [[ $reviewed != true ]] || skip "${BOT} already reviewed $head"
fi

echo "GATE run: event $ACTION, head $head, base $base, reviewed=$reviewed head_approved=$head_approved labelled=$labelled approved=$approved"
echo "run=true" >>"$GITHUB_OUTPUT"

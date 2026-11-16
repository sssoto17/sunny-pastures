#!/usr/bin/env bash
# Decides whether review.yml's job reviews this event, before Claude runs, so a head is reviewed
# once (#274; retro 2026-11-15, item F). Writes run=true|false to GITHUB_OUTPUT and logs one GATE
# line. Tests: .github/scripts/tests/review-gate.test.mjs.
#
# Env: ACTION (github.event.action, for the log), BOT (the App's slug), PR_JSON and REVIEWS (the
# PR and its reviews as gather writes them: head_sha and labels; author, state, body, commit_id),
# GITHUB_OUTPUT. An unreadable file fails the step rather than guess.
set -euo pipefail

head=$(jq -er .head_sha "$PR_JSON")
labelled=$(jq '.labels | index("review:admin") != null' "$PR_JSON")
# A head counts as reviewed only when this App posted a review on it with a non-blank body: the
# summary review, which post-review.sh posts last. Each line or file comment it posts first is a
# COMMENTED review of its own with an empty body (PR #280, 2a46ae8), so a run that died between
# its comments and its summary doesn't count, and the next event reviews the head again.
reviewed=$(jq --arg u "${BOT}[bot]" --arg head "$head" \
  'any(.[]; .author == $u and .commit_id == $head and ((.body // "") | test("\\S")))' "$REVIEWS")
# The exception (ADR-0002, test (e)): review:admin on the PR while an approval of this App still
# stands means the label came after it (post-review.sh never approves a labelled PR), so the
# review runs again to dismiss it and turn auto-merge off. Whatever the event: a reopened run at
# the same head can cancel the labeled one (the job's cancel-in-progress) and must finish its
# work. A dismissed approval reads DISMISSED, so once a run has withdrawn it, nothing re-runs.
# Any commit counts, as post-review.sh's dismiss does.
approved=$(jq --arg u "${BOT}[bot]" 'any(.[]; .author == $u and .state == "APPROVED")' "$REVIEWS")

if [[ $reviewed == true && ! ($labelled == true && $approved == true) ]]; then
  echo "GATE skip: ${BOT} already reviewed $head (event: $ACTION)"
  echo "run=false" >>"$GITHUB_OUTPUT"
  exit 0
fi

echo "GATE run: event $ACTION, head $head, reviewed=$reviewed labelled=$labelled approved=$approved"
echo "run=true" >>"$GITHUB_OUTPUT"

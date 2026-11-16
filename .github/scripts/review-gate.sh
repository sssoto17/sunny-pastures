#!/usr/bin/env bash
# Decides whether review.yml's job reviews this event, before Claude runs (#274; retro
# 2026-11-15, item F). Writes run=true|false to GITHUB_OUTPUT and logs one GATE line.
# Tests: .github/scripts/tests/review-gate.test.mjs.
#
# Env: ACTION (github.event.action), HEAD (the PR's head SHA), BOT (the App's slug), REVIEWS (the
# PR's reviews as gather writes them: author, state, body, commit_id), GITHUB_OUTPUT.
set -euo pipefail

# A head counts as reviewed only when this App posted a review on it with a non-blank body: the
# summary review, which post-review.sh posts last. Each line or file comment it posts first is a
# COMMENTED review of its own with an empty body (PR #280, 2a46ae8), so a run that died between
# its comments and its summary doesn't count, and the next event reviews the head again.
reviewed=$(jq --arg u "${BOT}[bot]" --arg head "$HEAD" \
	'any(.[]; .author == $u and .commit_id == $head and ((.body // "") | test("\\S")))' "$REVIEWS")
# The exception (ADR-0002, test (e)): review:admin added while an approval of this App still
# stands re-runs the review, which dismisses that approval and turns auto-merge off. The job's
# `if:` lets through only that label, added by someone other than the App. A dismissed approval
# reads DISMISSED, so once a run has withdrawn it, adding the label again skips. Any commit
# counts, as post-review.sh's dismiss does: an approval of an older head that GitHub kept still
# lets the PR merge.
approved=$(jq --arg u "${BOT}[bot]" 'any(.[]; .author == $u and .state == "APPROVED")' "$REVIEWS")

if [[ $reviewed == true && ! ($ACTION == labeled && $approved == true) ]]; then
	echo "GATE skip: ${BOT} already reviewed $HEAD (event: $ACTION)"
	echo "run=false" >>"$GITHUB_OUTPUT"
	exit 0
fi
echo "GATE run: event $ACTION, head $HEAD, reviewed=$reviewed approved=$approved"
echo "run=true" >>"$GITHUB_OUTPUT"

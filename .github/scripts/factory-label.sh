#!/usr/bin/env bash
# One factory:* label move on one issue (#619; ADR-0002, area 2, "The factory sweep, built"): the
# transition code the sweep and the factory share. An issue carries at most one of factory:ready,
# factory:working, factory:review and factory:failed; this sets it to TO (or to none) by removing
# every other factory:* label first and then adding TO, so no moment has two. Moving into
# factory:failed also posts one comment on the issue: WHY, DETAIL's text when given, and how to
# retry. sweep.yml's `labels` job runs it for each move the sweep planned (the reconcile, and
# factory:working on what it dispatches); factory.yml's `labels` job runs it once a run ends
# (factory-outcome.sh). Both with the App's token, minted with issues: write in that job only.
#
# Env: GH_TOKEN (the App's token), GITHUB_REPOSITORY, ISSUE (a number), TO (ready, working, review,
# failed or none), WHY (one line: the log and the comment), FROM (optional: space-separated states;
# then the move happens only when the issue carries one of them), DETAIL (optional: a Markdown file
# appended to the failed comment). Logs one `LABEL` line. Exit codes: 0 moved or nothing to do, 1 a
# bad input or a failed write (the step fails rather than leave a half-made move unsaid).
# Tests: .github/scripts/tests/factory-label.test.mjs
set -euo pipefail

r="repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
issue=${ISSUE-}
to=${TO-}
why=${WHY:-no reason given}
[[ $issue =~ ^[1-9][0-9]{0,6}$ ]] || { echo "::error::factory-label: not an issue number: $(printf %q "$issue")"; exit 1; }
[[ $to =~ ^(ready|working|review|failed|none)$ ]] || { echo "::error::factory-label: not a factory state: $(printf %q "$to")"; exit 1; }
# WHY reaches the log on one line: a line break can't start a workflow command of its own.
why=${why//$'\r'/ }
why=${why//$'\n'/ }

have=$(gh api "$r/issues/$issue" --jq '[.labels[].name | select(IN("factory:ready", "factory:working",
  "factory:review", "factory:failed")) | ltrimstr("factory:")] | join(" ")')
was=${have:-none}
carries() { [[ " $have " == *" $1 "* ]]; }
if [[ -n ${FROM-} ]]; then
  hit=false
  for s in $FROM; do if carries "$s"; then hit=true; fi; done
  [[ $hit == true ]] || { echo "LABEL #$issue: left at $was, not one of: $FROM ($why)"; exit 0; }
fi
if [[ $have == "${to/none/}" ]]; then
  echo "LABEL #$issue: already $was ($why)"
  exit 0
fi

for s in $have; do
  [[ $s == "$to" ]] || gh api -X DELETE "$r/issues/$issue/labels/factory:$s" --silent
done
if [[ $to != none ]] && ! carries "$to"; then
  gh api -X POST "$r/issues/$issue/labels" -f "labels[]=factory:$to" --silent
fi
echo "LABEL #$issue: $was -> $to ($why)"

if [[ $to == failed ]] && ! carries failed; then
  body=$(mktemp)
  {
    printf '`factory:failed`: %s\n\n' "$why"
    if [[ -n ${DETAIL-} && -s $DETAIL ]]; then cat "$DETAIL"; printf '\n'; fi
    printf 'To retry, replace `factory:failed` with `factory:ready`: the sweep keeps the most advanced label when an issue carries two.\n'
  } >"$body"
  gh api -X POST "$r/issues/$issue/comments" -F "body=@$body" --silent
  rm -f "$body"
  echo "LABEL #$issue: commented the reason"
fi

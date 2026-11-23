#!/usr/bin/env bash
# The label a factory run leaves on its issue (#619; ADR-0002, area 2, "The factory sweep, built"):
# factory.yml's `labels` job runs it once the run's other jobs are done, whatever happened, and it
# moves the issue through factory-label.sh, the transition code the sweep uses too:
# - a fix round (#588) whose gate passed: factory:review, since the PR is still open;
# - an issue run that opened a PR: factory:review;
# - an issue run that passed the gate and opened no PR: factory:failed, and one comment with the
#   run's link and the last `RESULT claude=`, `RESULT handoff=` and `RESULT factory=` lines of the
#   factory job's log (the `RESULT factory=` line is Claude's own `FACTORY …` reason, #615), in a
#   code block;
# - an issue run the gate refused: factory:failed with the gate's reason, but only when the issue
#   is at factory:working (the sweep dispatched it); an issue the admin dispatched keeps its label.
# Each move happens only from the states that run could have left (ready or working; a fix round's
# working or review), so an admin's relabel during the run isn't overwritten.
# A run whose gate wrote no issue (the switch was off, or a fix round the gate refused) moves
# nothing: the sweep's reconcile settles a factory:working left behind.
#
# The log lines are the model's words (Claude wrote the FACTORY line; factory.yml's `result` step
# already makes it one line of at most 300 characters with no control characters): each keeps 300
# characters with no backticks and goes inside a fenced block, so it can't format, link or mention.
#
# Env: GH_TOKEN (the App's token, issues: write), RUN_TOKEN (the job's GITHUB_TOKEN, actions: read,
# for the log), GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, RUNNER_TEMP; ISSUE, FIX (the
# fix round's PR or empty), GATE_RUN and GATE_WHY (the gate's outputs), PR (publish's output),
# FACTORY_RESULT and PUBLISH_RESULT (those jobs' results).
# Tests: .github/scripts/tests/factory-label.test.mjs ("factory-outcome.sh")
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
r="repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:?GITHUB_RUN_ID is not set}"
label() { ISSUE=$ISSUE TO=$1 WHY=$2 FROM=${3-} DETAIL=${4-} bash "$here/factory-label.sh"; }

[[ -n ${ISSUE-} ]] || { echo "LABEL none: the gate checked no issue"; exit 0; }
if [[ -n ${FIX-} ]]; then
  label review "fix round on PR #$FIX ended ($url)" "working review"
elif [[ -n ${PR-} ]]; then
  label review "run $url opened PR #$PR" "ready working"
elif [[ ${GATE_RUN-} == true ]]; then
  detail="$RUNNER_TEMP/factory-detail.md"
  lines=""
  job=$(GH_TOKEN=$RUN_TOKEN gh api "$r/actions/runs/$GITHUB_RUN_ID/jobs?per_page=100" \
    --jq '.jobs[] | select(.name == "factory") | .id' 2>/dev/null | head -n1) || job=""
  if [[ $job =~ ^[1-9][0-9]*$ ]]; then
    log="$RUNNER_TEMP/factory-job.log"
    if GH_TOKEN=$RUN_TOKEN gh api "$r/actions/jobs/$job/logs" >"$log" 2>/dev/null; then
      for k in claude handoff factory; do
        l=$(grep -E "^[0-9TZ:.-]+ RESULT $k=" "$log" | tail -n1 | cut -d' ' -f2- | tr -d '`\r' | cut -c1-300) || l=""
        [[ -z $l ]] || lines+="$l"$'\n'
      done
    fi
  fi
  {
    printf 'The factory job ended `%s` and publish `%s`.\n\n' "${FACTORY_RESULT:-unknown}" "${PUBLISH_RESULT:-unknown}"
    if [[ -n $lines ]]; then
      printf '```text\n%s```\n' "$lines"
    else
      printf 'No `RESULT` lines could be read from the factory job'"'"'s log: see the run.\n'
    fi
  } >"$detail"
  label failed "run $url opened no PR" "ready working" "$detail"
else
  label failed "run $url: the gate refused: ${GATE_WHY:-no reason given}" working
fi

#!/usr/bin/env bash
# The pr-draft workflow's one step (#358; ADR-0002, area 2, "Stacks" and "Lanes open PRs as
# sunny-factory"): turns lane PRs into drafts, or marks them ready for review, as sunny-factory[bot]
# with the App token in GH_TOKEN. The REST update endpoint has no draft field, so this uses GraphQL's
# convertPullRequestToDraft and markPullRequestReadyForReview, which the cloud proxy refuses a
# session. The App's token marks ready, never GITHUB_TOKEN: events GITHUB_TOKEN causes start no
# workflows, so ready_for_review would start no CI. A lane asks with scripts/pr-draft.sh.
#
# Every input comes from repository_dispatch's client_payload, which anyone with write access can
# send: STATE and PRS reach this script only as environment variables, and every PR is checked
# before any write. Refusals: a state other than draft or ready; a list that isn't 1 to 20 PR
# numbers, comma-separated; a PR that isn't open, comes from another repository, or whose head isn't
# a lane branch. A PR already in the asked state is left alone, so it raises no event.
# Outputs: switched=<numbers, comma-separated>. Exit codes: 0 done; 1 GitHub refused a switch;
# 2 the request was refused, nothing written.
# Tests: .github/scripts/tests/pr-draft.test.mjs
set -euo pipefail

R=repos/$GITHUB_REPOSITORY
# The lanes' branch names, as .github/scripts/open-pr.sh checks them (ADR-0002, area 1).
LANE='^([0-9]+-[a-z0-9]+(-[a-z0-9]+)*|claude/[A-Za-z0-9._-]+)$'
MAX=20

# A message may quote the payload: escaped as workflow commands require, so a newline in it can't
# start a command of its own.
esc() { local s=${1//'%'/%25}; s=${s//$'\r'/%0D}; printf '%s' "${s//$'\n'/%0A}"; }
refuse() { # message
  echo "::error title=pr-draft::$(esc "$1")"
  printf 'Refused: %s\n' "$(esc "$1")" >>"$GITHUB_STEP_SUMMARY"
  exit 2
}
is_lane() { [[ $1 =~ $LANE && ! ${1#claude/} =~ ^\.+$ ]]; }

STATE=${STATE:-} PRS=${PRS:-}
[[ $STATE == draft || $STATE == ready ]] || refuse "the state '$STATE' isn't draft or ready"
[[ $PRS =~ ^[1-9][0-9]{0,6}(,[1-9][0-9]{0,6})*$ ]] ||
  refuse "the PRs '$PRS' aren't PR numbers, comma-separated"
IFS=, read -r -a prs <<<"$PRS"
((${#prs[@]} <= MAX)) || refuse "more than $MAX PRs in one request"
want=false
[[ $STATE == ready ]] || want=true

todo=() ids=()
for n in "${prs[@]}"; do
  [[ " ${todo[*]-} " != *" $n "* ]] || continue
  # Fields split on the unit separator, which `read` never collapses (a tab run would merge an
  # empty field into the next).
  info=$(gh api "$R/pulls/$n" --jq '[.state, .draft, .head.repo.full_name // "", .head.ref, .node_id] | map(tostring) | join("\u001f")') ||
    refuse "can't read PR #$n"
  IFS=$'\x1f' read -r state draft repo head id <<<"$info"
  [[ $state == open ]] || refuse "#$n isn't open"
  [[ $repo == "$GITHUB_REPOSITORY" ]] || refuse "#$n comes from another repository"
  is_lane "$head" || refuse "#$n's head $head isn't a lane branch (<N>-<slug> or claude/<name>)"
  if [[ $draft == "$want" ]]; then
    echo "#$n is $STATE already"
    continue
  fi
  todo+=("$n") ids+=("$id")
done

m=markPullRequestReadyForReview
[[ $STATE == ready ]] || m=convertPullRequestToDraft
switched=() code=0
for i in "${!todo[@]}"; do
  # The query is fixed text; the node id goes as a GraphQL variable, never into the query.
  if gh api -X POST graphql -f query="mutation(\$id: ID!) { $m(input: {pullRequestId: \$id}) { pullRequest { number } } }" \
    -f id="${ids[i]}" --silent; then
    switched+=("${todo[i]}")
    echo "#${todo[i]} is $STATE now"
  else
    echo "::error title=pr-draft::GitHub refused to mark #${todo[i]} $STATE (see gh's message above)"
    code=1
  fi
done

echo "switched=$(IFS=,; echo "${switched[*]-}")" >>"$GITHUB_OUTPUT"
{
  if ((${#switched[@]})); then
    echo "Marked $(printf '#%s ' "${switched[@]}")$STATE as the App."
  else
    echo "Nothing to mark $STATE: every PR was $STATE already, or GitHub refused."
  fi
} >>"$GITHUB_STEP_SUMMARY"
exit "$code"

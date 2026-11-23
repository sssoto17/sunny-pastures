#!/usr/bin/env bash
# File a milestone's architecture review (#517): "Architecture review, <milestone>", in that
# milestone, under the Agent workflow parent, with its type, area, Priority, Size and Week, through
# scripts/new-issue.sh. The review runs once per milestone instead of in a weekly slot that was
# missed three weeks running (#290, #407, retro 2026-11-22). Run by .github/workflows/
# milestone-review.yml on `milestone: created`, and by hand for a backfill. A milestone that
# already has an issue titled "Architecture review, …" (open or closed) is left alone, so a re-run
# never files a second. REST only (`gh api`; docs/agents/github-rest.md).
# Tests: scripts/milestone-review.test.sh.
# Needs bash 4.4+, an authenticated gh that can write issues, and for Week the `project` scope or
# PROJECT_GH_TOKEN (gh uses it for the Project's calls only, as issue-fields.sh does).
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "milestone-review: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
# The workstream parent the reviews sit under: Agent workflow, as #407 does.
PARENT=73
PREFIX="Architecture review"
here="$(cd "$(dirname "$0")" && pwd)"
# PROJECT_API, PROJECT_JQ_DEFS, project_gh, project_refused.
# shellcheck source=scripts/lib/project-rest.sh
. "$here/lib/project-rest.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/milestone-review.sh <milestone-number>

Files "Architecture review, <milestone title>" into the open milestone of that number (the number
in the milestone's URL), as a sub-issue of #73, with: type chore (native Chore), area:tools,
Priority P2, Size M, and Week set to the board iteration that contains the milestone's due date.
With no due date, or no iteration containing it yet, Week is left unset and the issue carries
`triage` (scripts/new-issue.sh adds it); the log says so.

Does nothing, and exits 0, when the milestone already has an issue whose title starts with
"Architecture review, " (open or closed): a milestone gets one review.

Exit codes: 0 filed or already there, 2 bad arguments or a closed milestone (nothing filed),
3 GitHub couldn't be read before filing (nothing filed); otherwise scripts/new-issue.sh's code
(1 a write failed, 4 filed but the Project step skipped).

example: scripts/milestone-review.sh 4
EOF
}

die() { # code message
  printf 'milestone-review: %s\n' "$2" >&2
  exit "$1"
}

# A note for the log: an annotation in a workflow run, a plain line elsewhere.
warn() { # message
  if [[ ${GITHUB_ACTIONS-} == true ]]; then
    printf '::warning::milestone-review: %s\n' "$1"
  else
    printf 'milestone-review: warning: %s\n' "$1" >&2
  fi
}

case ${1-} in
  "") usage; exit 2 ;;
  -h | --help) usage; exit 0 ;;
esac
(($# == 1)) || die 2 "takes one milestone number, got $# arguments"
# Digits only, no "#4": the workflow's concurrency group keys on the value as given.
number=$1
[[ $number =~ ^[1-9][0-9]*$ ]] || die 2 "not a milestone number: \"$1\""

err=$(mktemp "${TMPDIR:-/tmp}/milestone-review.XXXXXX")
body=$(mktemp "${TMPDIR:-/tmp}/milestone-review-body.XXXXXX")
trap 'rm -f "$err" "$body"' EXIT

# --- reads --------------------------------------------------------------------------------------
row=$(gh api "repos/$OWNER/$REPO/milestones/$number" --jq '[.state, (.due_on // "-"), .title] | @tsv') ||
  die 3 "could not read milestone $number (does it exist?); nothing was filed"
IFS=$'\t' read -r state due_on title <<<"$row"
[[ -n $title ]] || die 3 "milestone $number has no title in GitHub's answer; nothing was filed"
[[ $state == open ]] || die 2 "milestone \"$title\" is $state; nothing was filed"

# Every issue of the milestone, closed ones too, so a review already done counts. REST lists PRs
# as issues, hence the select. The comma matters: #517 itself ("Architecture review per
# milestone, …") sits in M4 and isn't a review.
existing=$(gh api --paginate "repos/$OWNER/$REPO/issues?milestone=$number&state=all&per_page=100" \
  --jq ".[] | select(has(\"pull_request\") | not) | select(.title | startswith(\"$PREFIX, \")) | .number") ||
  die 3 "could not list the issues of \"$title\"; nothing was filed"
if [[ -n $existing ]]; then
  echo "milestone-review: \"$title\" already has its review: #$(paste -sd' ' - <<<"$existing" | sed 's/ /, #/g'). Nothing was filed."
  exit 0
fi

# Week: the iteration whose days contain the due date (start_date plus duration days, from the
# REST Projects API's iteration field). GitHub stores a milestone's due date as a date at midnight
# UTC, so its first ten characters are the day.
week=""
due=${due_on:0:10}
if [[ $due_on == - ]]; then
  warn "\"$title\" has no due date, so Week is left unset and the review carries \`triage\`"
elif ! [[ $due =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  die 3 "unexpected due date \"$due_on\" for \"$title\"; nothing was filed"
else
  WEEK_FILTER="$PROJECT_JQ_DEFS"'
("DUE" + "T00:00:00Z" | fromdateiso8601) as $d
| .[] | select(.name == "Week" and .data_type == "iteration")
| iterations
| select((.start_date + "T00:00:00Z" | fromdateiso8601) as $s | $s <= $d and $d < $s + .duration * 86400)
| .title | txt'
  if weeks=$(project_gh api "$PROJECT_API/fields?per_page=100" --jq "${WEEK_FILTER//DUE/$due}" 2>"$err"); then
    week=$(head -n1 <<<"$weeks")
    [[ -n $week ]] ||
      warn "no Week iteration contains \"$title\"'s due date ($due) yet, so Week is left unset and the review carries \`triage\`"
  elif project_refused "$err"; then
    cat "$err" >&2
    warn "GitHub refused the Project here, so Week is left unset; scripts/new-issue.sh names the step to finish"
  else
    cat "$err" >&2
    die 3 "could not read the Project's Week iterations; nothing was filed"
  fi
fi

# --- file it ------------------------------------------------------------------------------------
cat >"$body" <<EOF
## Parent

[Agent workflow](https://github.com/$OWNER/$REPO/issues/$PARENT). Filed by \`scripts/milestone-review.sh\` (#517), which \`.github/workflows/milestone-review.yml\` runs when a milestone is created: the architecture review runs once per milestone (\`docs/diagrams/workflow.md\`, the milestone loop).

## What to build

Run this milestone's architecture review with the \`improve-codebase-architecture\` skill, fed by Fallow's hotspots, duplication and cycles, over \`packages/sim\`, \`apps/web\` and \`scripts/\`. Report the deepening candidates and file the ones the admin picks.

## Acceptance criteria

- [ ] A report goes up as a PR: Fallow's output (hotspots, duplication, cycles, boundaries) and the skill's candidates, each with its files, the problem, the proposed deeper module or seam, and an effort and payoff estimate.
- [ ] Each candidate says whether it touches work open in this milestone, so nothing collides with a lane in flight.
- [ ] The admin picks candidates, and each pick is filed in Backlog with \`scripts/new-issue.sh\`.
EOF

args=(--title "$PREFIX, $title" --type chore --area tools --milestone "$title" --body-file "$body"
  --parent "$PARENT" --priority P2 --size M)
[[ -n $week ]] && args+=(--week "$week")
"$here/new-issue.sh" "${args[@]}"

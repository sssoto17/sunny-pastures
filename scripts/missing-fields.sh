#!/usr/bin/env bash
# List the open issues that break the "Issue fields" rule (docs/agents/issue-tracker.md): every
# issue carries a native issue type, Priority, Size and Week, and `triage` while one is missing.
# Read-only: one paginated GraphQL read, no writes. Needs bash 4.4+ and an authenticated gh with
# the `project` scope. Tests: scripts/missing-fields.test.sh.
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "missing-fields: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
PROJECT_URL=https://github.com/users/sssoto17/projects/3
US=$'\x1f'

trap 'exit 3' ERR # an unexpected failure is exit 3, never 1, which means "issues listed"

usage() {
  cat >&2 <<'EOF2'
usage: scripts/missing-fields.sh

Lists the open issues in sssoto17/sunny-pastures that break docs/agents/issue-tracker.md,
"Issue fields", one per line in ascending issue order: "#<number>", tab, the problem, tab, the
title (as gh's @tsv escapes it). A problem is one of:
  - "missing: Type, Week", the fields not set (Type is GitHub's native issue type; Priority,
    Size and Week are fields on the Sunny Pastures Project), with "; no triage" added when the
    issue doesn't carry the `triage` label it should;
  - "triage, though its fields are set": scripts/issue-fields.sh <n> removes it.
Every issue needs all four, workstream parents too. A summary goes to stderr.

Exit codes: 0 none found, 1 issues listed, 2 bad arguments (nothing read), 3 GitHub couldn't be
read or answered in an unexpected shape (no list printed).
EOF2
}

die() { # code message
  printf 'missing-fields: %s\n' "$2" >&2
  exit "$1"
}

case $# in
  0) ;;
  1)
    case $1 in
      -h | --help) usage; exit 0 ;;
      *) usage; die 2 "unexpected argument \"$1\"" ;;
    esac
    ;;
  *) usage; die 2 "takes no arguments, got $#" ;;
esac

# The Project's fields are only in GraphQL. --paginate follows issues' pageInfo via $endCursor.
read -r -d '' QUERY <<'EOF2' || true
query($owner: String!, $repo: String!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 50, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title
        issueType { name }
        labels(first: 50) { nodes { name } }
        projectItems(first: 20) {
          nodes {
            project { url }
            fieldValues(first: 30) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
              }
            }
          }
        }
      }
    }
  }
}
EOF2
# One row per open issue, tab-separated: number, native type, labels joined by \x1f, Priority,
# Size, Week ("-" for anything unset), title. The
# fields come from the item on this repo's Project only. Tested through jq in the test file.
FILTER='.data.repository.issues.nodes[]
| ([.projectItems.nodes[] | select(.project.url == "'"$PROJECT_URL"'")
    | .fieldValues.nodes[] | select(.field) | {(.field.name): (.name // .title)}] | add // {}) as $f
| [.number, (.issueType.name // "-"),
  ([.labels.nodes[].name] | join("\u001f") | if . == "" then "-" else . end),
  ($f.Priority // "-"), ($f.Size // "-"), ($f.Week // "-"), .title] | @tsv'

rows=$(gh api graphql --paginate -F owner="$OWNER" -F repo="$REPO" -f query="$QUERY" --jq "$FILTER") ||
  die 3 "could not read the open issues of $OWNER/$REPO from GitHub (see gh's error above)"

listed=""
found=0
while IFS=$'\t' read -r number type labels priority size week title; do
  [[ -z $number ]] && continue
  [[ $number =~ ^[0-9]+$ && -n $title ]] || die 3 "unexpected row from GitHub, has the API changed? $number"
  declare -A have=([Type]=$type [Priority]=$priority [Size]=$size [Week]=$week)
  missing=()
  for f in Type Priority Size Week; do [[ ${have[$f]} != - ]] || missing+=("$f"); done
  triage=""
  [[ $US$labels$US == *${US}triage$US* ]] && triage=1
  if ((${#missing[@]})); then
    list=$(printf '%s, ' "${missing[@]}")
    problem="missing: ${list%, }"
    [[ -n $triage ]] || problem+="; no triage"
  elif [[ -n $triage ]]; then
    problem="triage, though its fields are set"
  else
    continue
  fi
  listed+=$(printf '%s\t%s\t%s' "$number" "$problem" "$title")$'\n'
  found=$((found + 1))
done <<<"$rows"

if ((found == 0)); then
  echo "missing-fields: every open issue has its fields, and none carries triage" >&2
  exit 0
fi
printf '%s' "$listed" | sort -n -k1,1 | sed 's/^/#/'
echo "missing-fields: $found open issue$( ((found == 1)) || echo s) to fix (docs/agents/issue-tracker.md, \"Issue fields\")" >&2
exit 1

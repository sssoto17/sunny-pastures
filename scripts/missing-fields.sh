#!/usr/bin/env bash
# List the open issues that break the "Issue fields" rule (docs/agents/issue-tracker.md): every
# issue carries a native issue type, Priority, Size and Week, and `triage` while one is missing.
# Read-only, REST only (`gh api`; #346, docs/agents/github-rest.md): the open issues, then the
# Project's fields and items. Needs bash 4.4+ and an authenticated gh with the `project` scope.
# Tests: scripts/missing-fields.test.sh.
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "missing-fields: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
US=$'\x1f'
here="$(cd "$(dirname "$0")" && pwd)"
# PROJECT_API, PROJECT_JQ_DEFS, PROJECT_SKIPPED, project_refused.
# shellcheck source=scripts/lib/project-rest.sh
. "$here/lib/project-rest.sh"

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

Where GitHub refuses the Project (HTTP 403, as the cloud's GitHub proxy does), it lists only
what the issues themselves show (a missing Type, and "; no triage" with it), says which checks
it skipped, and exits 4: run it again where the Project can be reached.

Exit codes: 0 none found, 1 issues listed, 2 bad arguments (nothing read), 3 GitHub couldn't be
read or answered in an unexpected shape (no list printed), 4 the Project's checks were skipped
(the Type checks ran; any issues found are listed).
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

# The open issues (REST "List repository issues", which lists PRs too): number, native type or
# "-", labels joined by the unit separator \x1f ("-" for none, since read collapses empty tab
# fields), title. Tested through jq in the test file.
ISSUES_FILTER='.[] | select(has("pull_request") | not) | [.number, (.type.name // "-"),
  ([.labels[].name] | join("\u001f") | if . == "" then "-" else . end), .title] | @tsv'
rows=$(gh api --paginate "repos/$OWNER/$REPO/issues?state=open&per_page=100" --jq "$ISSUES_FILTER") ||
  die 3 "could not read the open issues of $OWNER/$REPO from GitHub (see gh's error above)"

# Priority, Size and Week per issue number, from this repo's items on the Project (REST "List
# items for a user owned project", asked for those three fields by id).
declare -A priority_of=() size_of=() week_of=()
project_ok=1
err_file=$(mktemp "${TMPDIR:-/tmp}/missing-fields.XXXXXX")
trap 'rm -f "$err_file"' EXIT
if ! ids=$(gh api "$PROJECT_API/fields?per_page=100" \
  --jq '[.[] | select(.name == "Priority" or .name == "Size" or .name == "Week") | .id] | join(",")' \
  2>"$err_file"); then
  cat "$err_file" >&2
  project_refused "$err_file" || die 3 "could not read the Project's fields from GitHub (see gh's error above)"
  project_ok=0
fi
if ((project_ok)); then
  [[ $ids =~ ^[0-9]+,[0-9]+,[0-9]+$ ]] ||
    die 3 "the Project has no Priority, Size and Week fields (got ids \"$ids\"), has it changed?"
  ITEMS_FILTER="$PROJECT_JQ_DEFS"'
    .[] | select(.content_type == "Issue"
      and ((.content.html_url // "") | test("/'"$OWNER/$REPO"'/issues/[0-9]+$")))
    | [.content.number, (fv("Priority") // "-"), (fv("Size") // "-"), (fv("Week") // "-")] | @tsv'
  items=$(gh api --paginate "$PROJECT_API/items?per_page=100&fields=$ids" --jq "$ITEMS_FILTER") ||
    die 3 "could not read the Project's items from GitHub (see gh's error above)"
  while IFS=$'\t' read -r number p s w; do
    [[ -z $number ]] && continue
    [[ $number =~ ^[0-9]+$ ]] || die 3 "unexpected item from GitHub, has the API changed? $number"
    priority_of[$number]=$p size_of[$number]=$s week_of[$number]=$w
  done <<<"$items"
fi

listed=""
found=0
while IFS=$'\t' read -r number type labels title; do
  [[ -z $number ]] && continue
  [[ $number =~ ^[0-9]+$ && -n $title ]] || die 3 "unexpected row from GitHub, has the API changed? $number"
  declare -A have=([Type]=$type [Priority]=${priority_of[$number]:--} [Size]=${size_of[$number]:--}
    [Week]=${week_of[$number]:--})
  missing=()
  checked=(Type Priority Size Week)
  ((project_ok)) || checked=(Type)
  for f in "${checked[@]}"; do [[ ${have[$f]} != - ]] || missing+=("$f"); done
  triage=""
  [[ $US$labels$US == *${US}triage$US* ]] && triage=1
  if ((${#missing[@]})); then
    list=$(printf '%s, ' "${missing[@]}")
    problem="missing: ${list%, }"
    [[ -n $triage ]] || problem+="; no triage"
  elif [[ -n $triage ]] && ((project_ok)); then
    problem="triage, though its fields are set"
  else
    continue
  fi
  listed+=$(printf '%s\t%s\t%s' "$number" "$problem" "$title")$'\n'
  found=$((found + 1))
done <<<"$rows"

if ((!project_ok)); then
  ((found == 0)) || printf '%s' "$listed" | sort -n -k1,1 | sed 's/^/#/'
  echo "missing-fields: $found open issue$( ((found == 1)) || echo s) without a type. Skipped: the Priority, Size and Week checks and \"triage, though its fields are set\": GitHub refused the Project here ($PROJECT_REFUSED_WHY). Run it again where the Project can be reached: scripts/missing-fields.sh" >&2
  exit "$PROJECT_SKIPPED"
fi
if ((found == 0)); then
  echo "missing-fields: every open issue has its fields, and none carries triage" >&2
  exit 0
fi
printf '%s' "$listed" | sort -n -k1,1 | sed 's/^/#/'
echo "missing-fields: $found open issue$( ((found == 1)) || echo s) to fix (docs/agents/issue-tracker.md, \"Issue fields\")" >&2
exit 1

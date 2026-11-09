#!/usr/bin/env bash
# List the open issues that sit under no workstream parent (docs/agents/issue-tracker.md,
# "Grouping"). Read-only: one paginated REST read, no writes. /today (#78) runs it.
# Tests: scripts/orphan-issues.test.sh.
set -euo pipefail

OWNER=sssoto17
REPO=sunny-pastures
US=$'\x1f'

# Any unexpected failure is exit 3, never 1, which means "issues listed".
trap 'exit 3' ERR

usage() {
  cat >&2 <<'EOF'
usage: scripts/orphan-issues.sh

Lists the open issues in sssoto17/sunny-pastures that have no parent issue, one per line:
"#<number>", a tab, then the title, in ascending issue order. A title is printed as gh's @tsv
escapes it (a backslash shows as \\, a tab as \t), so each issue stays on one line. A summary
goes to stderr, so stdout holds only the list.

Every issue sits under a workstream parent (docs/agents/issue-tracker.md, "Grouping"), except:
  - issues labelled idea;
  - the Retro inbox, found by its exact title "Retro inbox";
  - top-level parents: issues with no parent and at least one sub-issue, open or closed. A
    parent whose sub-issues are all closed still counts as one. A parent just framed, with no
    sub-issue yet, is listed until its first ticket is added.
Pull requests are never listed.

Exit codes: 0 none found, 1 issues listed, 2 bad arguments (nothing read), 3 GitHub couldn't be
read or answered in an unexpected shape (no list printed).
EOF
}

die() { # code message
  printf 'orphan-issues: %s\n' "$2" >&2
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

# One row per open issue or PR, tab-separated: number, kind (issue/pr), parent (parent/none),
# sub-issue total (open and closed), labels joined by the unit separator \x1f, which no label name
# contains in practice, unlike "," ("-" for none, since read collapses empty tab fields), title. GitHub leaves parent_issue_url out of an issue with no parent rather
# than sending null (seen 9 Nov); .parent_issue_url is null either way.
FILTER='.[] | [.number,
  (if has("pull_request") then "pr" else "issue" end),
  (if .parent_issue_url then "parent" else "none" end),
  (.sub_issues_summary.total // 0),
  ([.labels[].name] | join("\u001f") | if . == "" then "-" else . end),
  .title] | @tsv'

rows=$(gh api -X GET "repos/$OWNER/$REPO/issues" -f state=open -f per_page=100 --paginate --jq "$FILTER") ||
  die 3 "could not read the open issues of $OWNER/$REPO from GitHub (see gh's error above)"

orphans=""
found=0
while IFS=$'\t' read -r number kind parent subs labels title; do
  [[ -z $number ]] && continue
  if ! [[ $number =~ ^[0-9]+$ && $kind =~ ^(issue|pr)$ && $parent =~ ^(parent|none)$ && $subs =~ ^[0-9]+$ ]]; then
    die 3 "unexpected row from GitHub, has the API changed? $number $kind $parent $subs"
  fi
  [[ $kind == issue && $parent == none ]] || continue
  [[ $US$labels$US == *${US}idea$US* ]] && continue
  [[ $title == "Retro inbox" ]] && continue
  ((subs > 0)) && continue
  orphans+=$(printf '%s\t%s' "$number" "$title")$'\n'
  found=$((found + 1))
done <<<"$rows"

if ((found == 0)); then
  echo "orphan-issues: every open issue has a workstream parent" >&2
  exit 0
fi
printf '%s' "$orphans" | sort -n -k1,1 | sed 's/^/#/'
if ((found == 1)); then
  echo "orphan-issues: 1 open issue without a workstream parent" >&2
else
  echo "orphan-issues: $found open issues without a workstream parent" >&2
fi
exit 1

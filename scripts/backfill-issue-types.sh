#!/usr/bin/env bash
# Set GitHub's native issue type on every open issue whose type doesn't follow its type label:
# none set, or another type (docs/agents/issue-tracker.md, "Issue fields"). The admin runs it
# (#158; re-typing for the renamed types, #266). Needs bash 4.4+ (empty
# arrays under set -u) and an authenticated gh. Tests: scripts/backfill-issue-types.test.sh.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# NATIVE_TYPES, native_type and check_native_types: the type label -> native type mapping.
# shellcheck source=scripts/lib/issue-types.sh
. "$here/lib/issue-types.sh"

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "backfill-issue-types: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
US=$'\x1f'

trap 'exit 3' ERR # an unexpected failure is exit 3, like a failed read

usage() {
  cat >&2 <<'EOF2'
usage: scripts/backfill-issue-types.sh [--dry-run | --apply]

For every open issue in sssoto17/sunny-pastures whose native issue type doesn't follow its type
label (none set, or another type), maps the label to a type: feature -> Feature, bug -> Bug,
design -> Design, and spike, chore, idea -> Chore (scripts/lib/issue-types.sh).

  --dry-run  the default: list what would be set, write nothing
  --apply    set each type, then read each issue back

stdout: one line per issue to set, in issue order: "#<number>", tab, the label, tab, the type,
or "<old> -> <type>" when it replaces another type (with --apply, then tab "set" once read
back); or "#<number>", tab, "skip: ..." for an untyped issue with no type label or more than
one, left for a person. An issue whose type already follows its label is left alone, and so is
a typed issue without exactly one type label. A summary goes to stderr. Nothing secret is
printed. It stops before listing if the repo's types (Chore, Bug, Feature, Design) and the
mapping disagree.

Exit codes: 0 done, 1 a write failed or a read-back differs (the rest still run; stderr lists
them), 2 bad arguments, 3 GitHub couldn't be read or a type is missing (nothing written).
EOF2
}

die() { # code message
  printf 'backfill-issue-types: %s\n' "$2" >&2
  exit "$1"
}

apply=""
case $# in
  0) ;;
  1)
    case $1 in
      -h | --help) usage; exit 0 ;;
      --dry-run) ;;
      --apply) apply=1 ;;
      *) usage; die 2 "unexpected argument \"$1\"" ;;
    esac
    ;;
  *) usage; die 2 "takes one option at most, got $#" ;;
esac

# The repo's enabled issue types, "id<TAB>name" per line. GraphQL only: REST lists issue types
# for an organisation, and this repo is user-owned.
types=$(gh api graphql -F owner="$OWNER" -F repo="$REPO" -f query='
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) { issueTypes(first: 25) { nodes { id name isEnabled } } }
  }' --jq '.data.repository.issueTypes.nodes[] | select(.isEnabled) | [.id, .name] | @tsv') ||
  die 3 "could not read the repo's issue types; nothing was written"
type_id() { # name -> id, or nothing
  awk -F'\t' -v n="$1" '$2 == n { print $1; exit }' <<<"$types"
}
why=$(check_native_types "$(cut -f2 <<<"$types")") || die 3 "$why; nothing was written"

# One row per open issue or PR: number, kind, node id, native type (REST's .type, null when
# unset) or "-", labels joined by the unit separator \x1f or "-". Tested through jq.
FILTER='.[] | [.number,
  (if has("pull_request") then "pr" else "issue" end),
  .node_id,
  (.type.name // "-"),
  ([.labels[].name] | join("\u001f") | if . == "" then "-" else . end)] | @tsv'

rows=$(gh api -X GET "repos/$OWNER/$REPO/issues" -f state=open -f per_page=100 --paginate --jq "$FILTER") ||
  die 3 "could not read the open issues of $OWNER/$REPO from GitHub (see gh's error above)"

plan=() # "number<TAB>node id<TAB>label<TAB>type<TAB>old type or -"
skipped=() right=0 unlabelled=0
while IFS=$'\t' read -r number kind node type labels; do
  [[ -z $number ]] && continue
  [[ $number =~ ^[0-9]+$ && $kind =~ ^(issue|pr)$ && -n $node && -n $labels ]] ||
    die 3 "unexpected row from GitHub, has the API changed? $number $kind"
  [[ $kind == issue ]] || continue
  found=()
  IFS=$US read -ra names <<<"$labels"
  for l in "${names[@]}"; do [[ -n $(native_type "$l") ]] && found+=("$l"); done
  if ((${#found[@]} == 1)); then
    want=$(native_type "${found[0]}")
    if [[ $type == "$want" ]]; then
      right=$((right + 1))
    else
      plan+=("$number"$'\t'"$node"$'\t'"${found[0]}"$'\t'"$want"$'\t'"$type")
    fi
  elif [[ $type != - ]]; then
    unlabelled=$((unlabelled + 1)) # typed by hand, with no single label to judge it by
  elif ((${#found[@]} == 0)); then
    skipped+=("$number"$'\t'"skip: no type label")
  else
    list=$(printf '%s, ' "${found[@]}")
    skipped+=("$number"$'\t'"skip: ${#found[@]} type labels (${list%, })")
  fi
done <<<"$rows"

read -r -d '' SET_TYPE <<'EOF2' || true
mutation($issue: ID!, $type: ID!) {
  updateIssue(input: {id: $issue, issueTypeId: $type}) { issue { number } }
}
EOF2

# Each write is checked on its own; a failure is listed and the rest still run.
trap - ERR
out=() failures=()
for row in "${plan[@]}"; do
  IFS=$'\t' read -r number node label name old <<<"$row"
  line="#$number"$'\t'"$label"$'\t'
  [[ $old == - ]] || line+="$old -> "
  line+=$name
  if [[ -n $apply ]]; then
    if ! gh api graphql -f query="$SET_TYPE" -f issue="$node" -f type="$(type_id "$name")" >/dev/null; then
      failures+=("#$number: the write failed") && continue
    fi
    if ! got=$(gh api "repos/$OWNER/$REPO/issues/$number" --jq '.type.name // "-"'); then
      failures+=("#$number: written, but couldn't be read back") && continue
    fi
    [[ $got == "$name" ]] || { failures+=("#$number: the read-back shows $got, expected $name") && continue; }
    line+=$'\t'set
  fi
  out+=("$line")
done
for row in "${skipped[@]}"; do out+=("#$row"); done
((${#out[@]})) && printf '%s\n' "${out[@]}" | sort -t'#' -k2,2n

summary="skipped ${#skipped[@]}, already right $right"
((unlabelled)) && summary+=", typed without one type label $unlabelled"
if [[ -n $apply ]]; then
  echo "backfill-issue-types: set $((${#plan[@]} - ${#failures[@]})), failed ${#failures[@]}, $summary" >&2
else
  echo "backfill-issue-types: dry run: would set ${#plan[@]}, $summary. Run with --apply to write." >&2
fi
if ((${#skipped[@]})); then
  echo "backfill-issue-types: set a skipped issue's type by hand: scripts/issue-fields.sh <n> --type <Chore|Bug|Feature|Design>" >&2
fi
if ((${#failures[@]})); then
  printf 'backfill-issue-types: %s\n' "${failures[@]}" >&2
  echo "backfill-issue-types: re-run --apply to retry; issues already set are skipped" >&2
  exit 1
fi
exit 0

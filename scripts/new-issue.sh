#!/usr/bin/env bash
# File one issue the way docs/agents/issue-tracker.md asks: one type and one area label, the
# native issue type, a milestone, a body file, under its workstream parent, on the Project in
# Backlog, with `triage` while the type, Priority, Size or Week is missing. The coordinator
# files issues only through this script (#153). Names are checked against GitHub before the
# first write, so a typo creates nothing. Tests: scripts/new-issue.test.sh.
# Needs bash 4.4+ and an authenticated gh with the `project` scope (for issue-fields.sh).
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "new-issue: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
TYPES=(feature bug spike design chore idea)

# The native issue type each type label maps to (docs/agents/triage-labels.md, Types).
native_type() { # type label -> native type name
  case $1 in
    feature) echo Feature ;;
    bug) echo Bug ;;
    spike | design | chore | idea) echo Task ;;
  esac
}
here="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: scripts/new-issue.sh --title TEXT --type TYPE --area AREA --milestone TITLE
                            --body-file FILE --parent N
                            [--track NAME] [--mode NAME] [--size NAME] [--priority NAME]
                            [--week NAME]

Creates an issue in sssoto17/sunny-pastures with the type label and the area label, in the
milestone, as a sub-issue of the parent, then adds it to the Project in Backlog and sets its
native issue type and the fields given, through scripts/issue-fields.sh. Prints the type and
the Project fields, then the labels, milestone and parent as GitHub stored them. Each flag also
takes the form --size=M.

  --type      one of feature, bug, spike, design, chore, idea (docs/agents/triage-labels.md).
              It also sets GitHub's native issue type: feature -> Feature, bug -> Bug, the
              rest -> Task. The script stops if the repo doesn't offer that type.
  --area      "tools" or "area:tools"; must be an existing area:* label
  --milestone the exact title of an open milestone
  --parent    the workstream parent's number ("73" or "#73"), an open issue. Required, except
              for an idea, which has none (docs/agents/issue-tracker.md, "Grouping"). Framing a
              new workstream parent is the Kickoff, not this script.

A new issue always starts in Backlog: --status is refused, and so is --mode Factory. Only the
admin moves an issue to Ready or sets Factory.

Set --priority, --size and --week: with the type, they're your proposal, which the admin
confirms at Ready (docs/agents/issue-tracker.md, "Issue fields"). If one is left out, the issue
gets the `triage` label and a warning names what's missing.

Before the first write it reads the labels, the repo's issue types, the open milestones and
the parent, and stops on an unknown name. issue-fields.sh checks the field names after the issue
exists: a bad one there leaves the issue created without fields, and the error prints the
command to finish it.

Exit codes: 0 done, 1 a write failed or the read-back differs (stderr says what exists),
2 bad arguments or an unknown name (nothing created), 3 GitHub couldn't be read before the first
write (nothing created).

example: scripts/new-issue.sh --title "Bench advance in CI" --type chore --area ci-cd \
           --milestone "M3 Actions persist end to end" --body-file .scratch/issue-bench.md --parent 58 \
           --track Infra --size S --priority P2 --week "Wk 2"
EOF
}

die() { # code message
  printf 'new-issue: %s\n' "$2" >&2
  exit "$1"
}

join() { # items... -> "a, b, c"
  local s
  s=$(printf '%s, ' "$@")
  printf '%s' "${s%, }"
}

# --- arguments ----------------------------------------------------------------------------------
# All checks run before the first gh call, so a bad command line never touches GitHub.
case ${1-} in
  "") usage; exit 2 ;;
  -h | --help) usage; exit 0 ;;
esac

title="" type="" area="" milestone="" body_file="" parent=""
fields=() # passed through to issue-fields.sh, in the order given
seen=" "
while (($#)); do
  flag=${1%%=*}
  case $flag in
    --title | --type | --area | --milestone | --body-file | --parent) ;;
    --track | --mode | --size | --priority | --week) ;;
    --status) die 2 "a new issue always starts in Backlog; only the admin moves it on (docs/agents/issue-tracker.md, Status rules)" ;;
    -h | --help) usage; exit 0 ;;
    --*) die 2 "unknown option \"$flag\"" ;;
    *) die 2 "unexpected argument \"$1\"" ;;
  esac
  if [[ $1 == *=* ]]; then
    value=${1#*=}
    shift
  elif (($# >= 2)) && [[ $2 != --* ]]; then
    value=$2
    shift 2
  else
    die 2 "$flag needs a value"
  fi
  [[ $seen == *" $flag "* ]] && die 2 "$flag given twice"
  seen+="$flag "
  case $flag in
    --title) title=$value ;;
    --type) type=$value ;;
    --area) area=$value ;;
    --milestone) milestone=$value ;;
    --body-file) body_file=$value ;;
    --parent) parent=$value ;;
    --mode)
      [[ ${value,,} == factory ]] &&
        die 2 "only the admin sets Mode to Factory, with factory:ready (docs/agents/triage-labels.md)"
      fields+=("$flag" "$value")
      ;;
    *) fields+=("$flag" "$value") ;;
  esac
done

for req in --title --type --area --milestone --body-file; do
  [[ $seen == *" $req "* ]] || die 2 "$req is required (see --help)"
done
[[ -n ${title//[[:space:]]/} ]] || die 2 "--title is empty"

[[ " ${TYPES[*]} " == *" $type "* ]] ||
  die 2 "unknown type \"$type\". Valid types: $(join "${TYPES[@]}")"

area=area:${area#area:}
[[ $area =~ ^area:[a-z0-9-]+$ ]] || die 2 "not an area label: \"$area\""

if [[ $type == idea ]]; then
  [[ -z $parent ]] || die 2 "an idea has no parent (docs/agents/issue-tracker.md, Grouping); drop --parent"
else
  [[ -n $parent ]] || die 2 "--parent is required (only an idea has none)"
  parent=${parent#\#}
  [[ $parent =~ ^[1-9][0-9]*$ ]] || die 2 "not an issue number: \"$parent\""
fi

[[ -f $body_file && -r $body_file ]] || die 2 "body file not found: $body_file"
[[ -s $body_file ]] || die 2 "body file is empty: $body_file"

issue_type=$(native_type "$type")
# The four fields every issue carries (issue-tracker.md, "Issue fields"): the type is required
# above, so `triage` goes on when Priority, Size or Week isn't given.
missing=()
for pair in --priority=Priority --size=Size --week=Week; do
  [[ $seen == *" ${pair%%=*} "* ]] || missing+=("${pair#*=}")
done

# --- reads: every name checked before the first write -------------------------------------------
labels=$(gh label list --repo "$OWNER/$REPO" --limit 500 --json name --jq '.[].name') ||
  die 3 "could not read the repo's labels; nothing was created"
grep -qxF -- "$type" <<<"$labels" ||
  die 2 "the type label \"$type\" doesn't exist in $OWNER/$REPO. Nothing was created."
if ! grep -qxF -- "$area" <<<"$labels"; then
  mapfile -t areas < <(grep '^area:' <<<"$labels")
  die 2 "unknown area \"$area\". Valid areas: $(join "${areas[@]}"). Nothing was created."
fi

# The repo's issue types are read with GraphQL (repository.issueTypes); REST lists them only for
# an organisation, and this repo is user-owned.
types=$(gh api graphql -F owner="$OWNER" -F repo="$REPO" -f query='
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) { issueTypes(first: 25) { nodes { name isEnabled } } }
  }' --jq '.data.repository.issueTypes.nodes[] | select(.isEnabled) | .name') ||
  die 3 "could not read the repo's issue types; nothing was created"
if ! grep -qxF -- "$issue_type" <<<"$types"; then
  mapfile -t type_names <<<"$types"
  die 2 "the repo offers no \"$issue_type\" issue type for --type $type (it offers: $(join "${type_names[@]}")). Nothing was created."
fi

milestones=$(gh api "repos/$OWNER/$REPO/milestones?state=open&per_page=100" --jq '.[].title') ||
  die 3 "could not read the open milestones; nothing was created"
if ! grep -qxF -- "$milestone" <<<"$milestones"; then
  mapfile -t open_milestones <<<"$milestones"
  die 2 "unknown milestone \"$milestone\". Open milestones: $(join "${open_milestones[@]}"). Nothing was created."
fi

if [[ -n $parent ]]; then
  row=$(gh api "repos/$OWNER/$REPO/issues/$parent" \
    --jq '[.state, (if has("pull_request") then "pr" else "issue" end)] | @tsv') ||
    die 3 "could not read parent #$parent (does it exist?); nothing was created"
  IFS=$'\t' read -r state kind <<<"$row"
  [[ $kind == issue ]] || die 2 "#$parent is a pull request, not an issue. Nothing was created."
  [[ $state == open ]] || die 2 "parent #$parent is $state. Nothing was created."
fi

# --- writes -------------------------------------------------------------------------------------
create=(gh issue create --repo "$OWNER/$REPO" --title "$title" --body-file "$body_file"
  --label "$type" --label "$area" --milestone "$milestone")
((${#missing[@]})) && create+=(--label triage)
[[ -n $parent ]] && create+=(--parent "$parent")
url=$("${create[@]}") ||
  die 1 "gh issue create failed. It may have created the issue without its parent link: check \`gh issue list --search \"$title in:title\"\` before re-running."
url=$(tail -n1 <<<"$url")
number=${url##*/}
[[ $number =~ ^[1-9][0-9]*$ ]] || die 1 "gh issue create printed no issue URL (got \"$url\"); check the repo before re-running"

fields=(--type "$issue_type" "${fields[@]}")
if ! fields_out=$("$here/issue-fields.sh" "$number" "${fields[@]}"); then
  rerun=$(printf ' %q' "${fields[@]}")
  die 1 "#$number was created ($url), but its Project fields weren't set. Fix the error above, then run: scripts/issue-fields.sh $number${rerun}"
fi

# --- read-back ----------------------------------------------------------------------------------
row=$(gh api "repos/$OWNER/$REPO/issues/$number" \
  --jq '[([.labels[].name] | join(",")), (.milestone.title // "-"), (.parent_issue_url // "-" | split("/") | last), (.type.name // "-")] | @tsv') ||
  die 1 "#$number was created and its fields set, but it couldn't be read back; check $url"
IFS=$'\t' read -r got_labels got_milestone got_parent got_type <<<"$row"

printf '%s\n' "$fields_out"
printf '%-9s %s\n' "Labels:" "${got_labels//,/, }" "Milestone:" "$got_milestone" \
  "Parent:" "$([[ $got_parent == - ]] && echo - || echo "#$got_parent")"

mismatches=()
for want in "$type" "$area"; do
  [[ ",$got_labels," == *",$want,"* ]] || mismatches+=("missing label $want")
done
[[ $got_type == "$issue_type" ]] || mismatches+=("issue type is $got_type, expected $issue_type")
if ((${#missing[@]})); then
  [[ ",$got_labels," == *",triage,"* ]] || mismatches+=("missing label triage")
else
  [[ ",$got_labels," != *",triage,"* ]] || mismatches+=("triage is on, though all four are set")
fi
[[ $got_milestone == "$milestone" ]] || mismatches+=("milestone is $got_milestone, expected $milestone")
if [[ -n $parent ]]; then
  [[ $got_parent == "$parent" ]] || mismatches+=("parent is $got_parent, expected #$parent")
else
  [[ $got_parent == - ]] || mismatches+=("parent is #$got_parent, expected none")
fi
if ((${#mismatches[@]})); then
  die 1 "#$number was created, but the read-back differs: $(join "${mismatches[@]}"). Fix it by hand on $url."
fi

# Agents set all four when filing, so a missing one is worth a warning (issue-tracker.md, "Issue
# fields"). The issue is filed and labelled triage; the exit code stays 0.
if ((${#missing[@]})); then
  printf 'new-issue: warning: #%s has no %s, so it carries `triage`. Finish with: scripts/issue-fields.sh %s' \
    "$number" "$(join "${missing[@]}")" "$number" >&2
  for f in "${missing[@]}"; do printf ' --%s <%s>' "${f,,}" "$f" >&2; done
  printf '\n' >&2
fi

#!/usr/bin/env bash
# File one issue the way docs/agents/issue-tracker.md asks: one type and one area label, the
# native issue type, a milestone, a body file, under its workstream parent, on the Project in
# Backlog, with `triage` while the type, Priority, Size or Week is missing. The coordinator
# files issues only through this script (#153). Names are checked against GitHub before the
# first write, so a typo creates nothing. REST only (`gh api`), local and cloud alike (#346;
# docs/agents/github-rest.md). Tests: scripts/new-issue.test.sh.
# Needs bash 4.4+ and an authenticated gh with the `project` scope (for issue-fields.sh).
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "new-issue: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
here="$(cd "$(dirname "$0")" && pwd)"
# TYPE_LABELS, native_type and check_native_types: the type label -> native type mapping.
# shellcheck source=scripts/lib/issue-types.sh
. "$here/lib/issue-types.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/new-issue.sh --title TEXT --type TYPE --area AREA --milestone TITLE
                            --body-file FILE --parent N
                            [--size NAME] [--priority NAME] [--week NAME] [--label NAME]...

Creates an issue in sssoto17/sunny-pastures with the type label and the area label, in the
milestone, as a sub-issue of the parent, then adds it to the Project in Backlog and sets its
native issue type and the fields given, through scripts/issue-fields.sh. Prints the type and
the Project fields, then the labels, milestone and parent as GitHub stored them. Each flag also
takes the form --size=M.

  --type      one of feature, bug, spike, design, chore, idea (docs/agents/triage-labels.md).
              It also sets GitHub's native issue type: feature -> Feature, bug -> Bug,
              design -> Design, and spike, chore, idea -> Chore (scripts/lib/issue-types.sh).
              The script stops if the repo's types (Chore, Bug, Feature, Design) and that
              mapping disagree, whatever --type is.
  --area      "tools" or "area:tools"; must be an existing area:* label
  --milestone the exact title of an open milestone
  --parent    the workstream parent's number ("73" or "#73"), an open issue. Required, except
              for an idea, which has none (docs/agents/issue-tracker.md, "Grouping"). Framing a
              new workstream parent is the Kickoff, not this script.
  --label     one more label, an existing one (a verify issue's blocked:admin, say); repeat it
              for more. Not the type, an area or triage: --type, --area and the triage rule
              set those. factory:ready is refused: only the admin adds it.

A new issue always starts in Backlog: --status is refused, and so is --label factory:ready.
Only the admin moves an issue to Ready or adds factory:ready (docs/agents/triage-labels.md).

The Project's Mode and Track fields were dropped (#621): --mode and --track are refused.

Set --priority, --size and --week: with the type, they're your proposal, which the admin
confirms at Ready (docs/agents/issue-tracker.md, "Issue fields"). If one is left out, the issue
gets the `triage` label and a warning names what's missing.

Before the first write it reads the labels, the repo's issue types, the open milestones and
the parent, and stops on an unknown name. issue-fields.sh checks the field names after the issue
exists: a bad one there leaves the issue created without fields, and the error prints the
command to finish it.

Where GitHub refuses the Project (HTTP 403, as the cloud's GitHub proxy does), the issue is still
created with its labels, milestone, native type and parent; issue-fields.sh names the Project
step it skipped and the command that finishes it. The issue gets `triage` (Priority, Size and
Week aren't set yet), which that command removes once all four are set, and this exits 4.

Exit codes: 0 done, 1 a write failed or the read-back differs (stderr says what exists),
2 bad arguments, an unknown name, or the repo's issue types and the mapping disagree (nothing
created), 3 GitHub couldn't be read before the first write (nothing created), 4 the issue is
filed but its Project step was skipped: run the printed command where the Project can be reached.

example: scripts/new-issue.sh --title "Bench advance in CI" --type chore --area ci-cd \
           --milestone "M3 Actions persist end to end" --body-file .scratch/issue-bench.md --parent 58 \
           --size S --priority P2 --week "Wk 2"
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
extra_labels=() # --label, in the order given
seen=" "
while (($#)); do
  flag=${1%%=*}
  case $flag in
    --title | --type | --area | --milestone | --body-file | --parent) ;;
    --size | --priority | --week | --label) ;;
    --mode | --track)
      die 2 "$flag is gone: the Project's Mode and Track fields were dropped (#621). Set --priority, --size and --week instead" ;;
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
  if [[ $flag == --label ]]; then
    [[ -n $value ]] || die 2 "--label is empty"
    [[ ${value,,} == factory:ready ]] &&
      die 2 "only the admin adds factory:ready (docs/agents/triage-labels.md); file the issue without it"
    [[ " ${extra_labels[*],,} " == *" ${value,,} "* ]] && die 2 "--label $value given twice"
    extra_labels+=("$value")
    continue
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
    *) fields+=("$flag" "$value") ;;
  esac
done

for req in --title --type --area --milestone --body-file; do
  [[ $seen == *" $req "* ]] || die 2 "$req is required (see --help)"
done
[[ -n ${title//[[:space:]]/} ]] || die 2 "--title is empty"

[[ " ${TYPE_LABELS[*]} " == *" $type "* ]] ||
  die 2 "unknown type \"$type\". Valid types: $(join "${TYPE_LABELS[@]}")"

area=area:${area#area:}
[[ $area =~ ^area:[a-z0-9-]+$ ]] || die 2 "not an area label: \"$area\""

# --label adds labels no other flag or rule owns.
for label in "${extra_labels[@]}"; do
  if [[ " ${TYPE_LABELS[*]} " == *" ${label,,} "* ]]; then
    die 2 "--label $label: the type label is set with --type"
  elif [[ ${label,,} == area:* ]]; then
    die 2 "--label $label: the area label is set with --area"
  elif [[ ${label,,} == triage ]]; then
    die 2 "--label $label: new-issue.sh adds triage itself, while Priority, Size or Week is missing"
  fi
done

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
labels=$(gh api --paginate "repos/$OWNER/$REPO/labels?per_page=100" --jq '.[].name') ||
  die 3 "could not read the repo's labels; nothing was created"
grep -qxF -- "$type" <<<"$labels" ||
  die 2 "the type label \"$type\" doesn't exist in $OWNER/$REPO. Nothing was created."
if ! grep -qxF -- "$area" <<<"$labels"; then
  mapfile -t areas < <(grep '^area:' <<<"$labels")
  die 2 "unknown area \"$area\". Valid areas: $(join "${areas[@]}"). Nothing was created."
fi
for label in "${extra_labels[@]}"; do
  grep -qxF -- "$label" <<<"$labels" ||
    die 2 "unknown label \"$label\" in $OWNER/$REPO. Nothing was created."
done

# The repo's enabled issue types (REST "List issue types for a repository").
types=$(gh api "repos/$OWNER/$REPO/issue-types" --jq '.[] | select(.is_enabled) | .name') ||
  die 3 "could not read the repo's issue types; nothing was created"
# The whole mapping is checked, not only this --type, so a rename is caught on the next filing.
why=$(check_native_types "$types") || die 2 "$why. Nothing was created."

# "number<TAB>title" per open milestone: REST creates an issue in a milestone by its number.
milestones=$(gh api "repos/$OWNER/$REPO/milestones?state=open&per_page=100" --jq '.[] | [.number, .title] | @tsv') ||
  die 3 "could not read the open milestones; nothing was created"
milestone_number=$(awk -F'\t' -v t="$milestone" '$2 == t { print $1; exit }' <<<"$milestones")
if [[ -z $milestone_number ]]; then
  mapfile -t open_milestones < <(cut -f2- <<<"$milestones")
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
# REST "Create an issue": labels, milestone (by number) and the native type (by name) in one call;
# -F body=@file reads the body from the file. Then the parent link (REST "Add sub-issue", by the
# new issue's id).
create=(gh api -X POST "repos/$OWNER/$REPO/issues" -f title="$title" -F body=@"$body_file"
  -f "labels[]=$type" -f "labels[]=$area" -F milestone="$milestone_number" -f type="$issue_type")
for label in "${extra_labels[@]}"; do create+=(-f "labels[]=$label"); done
((${#missing[@]})) && create+=(-f "labels[]=triage")
row=$("${create[@]}" --jq '[.number, .id, .html_url] | @tsv') ||
  die 1 "creating the issue failed. Check whether it exists before re-running: gh api \"repos/$OWNER/$REPO/issues?state=open&per_page=5\" --jq '.[].title'"
IFS=$'\t' read -r number issue_id url <<<"$row"
[[ $number =~ ^[1-9][0-9]*$ && $issue_id =~ ^[1-9][0-9]*$ ]] ||
  die 1 "GitHub's answer to the create had no issue number (got \"$row\"); check the repo before re-running"

if [[ -n $parent ]]; then
  gh api -X POST "repos/$OWNER/$REPO/issues/$parent/sub_issues" -F sub_issue_id="$issue_id" --silent ||
    die 1 "#$number was created ($url), but not linked under #$parent. Run: gh api -X POST repos/$OWNER/$REPO/issues/$parent/sub_issues -F sub_issue_id=$issue_id, then scripts/issue-fields.sh $number$(printf ' %q' --type "$issue_type" "${fields[@]}")"
fi

fields=(--type "$issue_type" "${fields[@]}")
fields_code=0
fields_out=$("$here/issue-fields.sh" "$number" "${fields[@]}") || fields_code=$?
if ((fields_code == 4)); then
  # The Project step was skipped (issue-fields.sh said so and printed the command), so Priority,
  # Size and Week aren't set yet: the issue carries `triage` until that command runs, which takes
  # it off once all four are set. Without it the issue shows in no triage search (#359, 18 Nov).
  if ((${#missing[@]} == 0)); then
    gh api -X POST "repos/$OWNER/$REPO/issues/$number/labels" -f "labels[]=triage" --silent ||
      die 1 "#$number was created ($url) and its Project step skipped, but \`triage\` couldn't be added. Run: gh api -X POST repos/$OWNER/$REPO/issues/$number/labels -f 'labels[]=triage'"
  fi
elif ((fields_code)); then
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
for want in "$type" "$area" "${extra_labels[@]}"; do
  [[ ",$got_labels," == *",$want,"* ]] || mismatches+=("missing label $want")
done
[[ $got_type == "$issue_type" ]] || mismatches+=("issue type is $got_type, expected $issue_type")
if ((${#missing[@]} || fields_code == 4)); then
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
if ((fields_code == 4)); then
  echo "new-issue: #$number is filed with its labels, milestone, type and parent, and carries \`triage\` until its Project step runs (see issue-fields above)" >&2
  exit 4
fi

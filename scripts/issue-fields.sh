#!/usr/bin/env bash
# Add an issue to the Sunny Pastures Project (if it isn't on it) and set its fields and its native
# issue type by name, then remove `triage` once the four fields every issue carries are set
# (docs/agents/issue-tracker.md, "Issue fields"). Field, option and type ids are looked up from
# GitHub on every run, never hard-coded. Every name is checked before the first write, so a typo
# changes nothing. Tests: scripts/issue-fields.test.sh.
# Needs bash 4.4+ (empty arrays under set -u) and an authenticated gh with the `project` scope.
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "issue-fields: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
PROJECT=3

usage() {
  cat >&2 <<'EOF'
usage: scripts/issue-fields.sh <issue> [--type NAME] [--track NAME] [--mode NAME] [--size NAME]
                               [--priority NAME] [--week NAME] [--status NAME]

Adds the issue to the Sunny Pastures Project if it's missing, sets the named fields, then prints
the fields as GitHub stored them. Names ignore case; --week takes "Wk 2" or the full title.
Each flag also takes the form --size=M. --type sets GitHub's native issue type (Chore, Bug,
Feature, Design), not the type label. It follows the label: feature -> Feature, bug -> Bug,
design -> Design, and spike, chore, idea -> Chore (scripts/lib/issue-types.sh).

Triage: once the native type, Priority, Size and Week are all set, a `triage` label is removed
and the "Triage:" line says so. While one is missing, `triage` is left as it is and the line
names what's missing (docs/agents/issue-tracker.md, "Issue fields").

Status: a new item, or one with no Status, gets Backlog. A Status already set is left alone
unless --status is given (--status Backlog may move an issue back). Admin-only values are
refused: --status Ready and --mode Factory.

After the writes it reads the issue and its item back and fails if a field doesn't show the
value it set, or if `triage` is still on once all four are set.

Exit codes: 0 done, 1 a gh call failed or the read-back differs, 2 bad arguments or an unknown
name (nothing changed).

example: scripts/issue-fields.sh 47 --type Chore --track Infra --mode Manual --size S --priority P2 --week "Wk 2"
EOF
}

die() { # code message
  printf 'issue-fields: %s\n' "$2" >&2
  exit "$1"
}

# Values only the admin sets (docs/agents/issue-tracker.md, Status rules; triage-labels.md,
# Factory): refused on the command line and left out of the valid-names lists.
admin_only() { # field name
  [[ $1 == Status && ${2,,} == ready ]] || [[ $1 == Mode && ${2,,} == factory ]]
}

# --- arguments ----------------------------------------------------------------------------------
# All checks run before the first gh call, so a bad command line never touches the Project.
case ${1-} in
  "") usage; exit 2 ;;
  -h | --help) usage; exit 0 ;;
esac
issue=${1#\#}
[[ $issue =~ ^[1-9][0-9]*$ ]] || die 2 "not an issue number: \"$1\""
shift

# Requested fields, in the order given: parallel arrays of field name and option name.
req_fields=()
req_names=()
while (($#)); do
  flag=${1%%=*}
  case $flag in
    --type) field=Type ;;
    --track) field=Track ;;
    --mode) field=Mode ;;
    --size) field=Size ;;
    --priority) field=Priority ;;
    --week) field=Week ;;
    --status) field=Status ;;
    -h | --help) usage; exit 0 ;;
    --*) die 2 "unknown option \"$flag\"" ;;
    *) die 2 "unexpected argument \"$1\" (fields are set with --track, --size, ...)" ;;
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
  for f in "${req_fields[@]}"; do
    [[ $f == "$field" ]] && die 2 "$flag given twice"
  done
  if admin_only "$field" "$value"; then
    if [[ $field == Status ]]; then
      die 2 "only the admin moves an issue to Ready (docs/agents/issue-tracker.md, Status rules)"
    fi
    die 2 "only the admin sets Mode to Factory, with factory:ready (docs/agents/triage-labels.md)"
  fi
  req_fields+=("$field")
  req_names+=("$value")
done

# One read-only lookup: the Project's fields and options, the repo's issue types, the issue (its
# node id, native type and labels) and its item on the Project.
# Each output line is tab-separated: a record type, then its values.
read -r -d '' QUERY <<'EOF' || true
query($owner: String!, $repo: String!, $number: Int!, $project: Int!) {
  user(login: $owner) {
    projectV2(number: $project) {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
          ... on ProjectV2IterationField {
            id name
            configuration { iterations { id title } completedIterations { id title } }
          }
        }
      }
    }
  }
  repository(owner: $owner, name: $repo) {
    issueTypes(first: 25) { nodes { id name isEnabled } }
    issue(number: $number) {
      id url title
      issueType { name }
      labels(first: 100) { nodes { name } }
      projectItems(first: 50) {
        nodes {
          id
          project { id }
          fieldValues(first: 50) {
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
EOF
read -r -d '' FILTER <<'EOF' || true
(.data.user.projectV2 // {fields: {nodes: []}}) as $p
| (select($p.id) | ["project", $p.id]),
  ($p.fields.nodes[] | select(.options) | . as $f
    | .options[] | ["option", $f.name, $f.id, "select", .id, .name]),
  ($p.fields.nodes[] | select(.configuration) | . as $f
    | (.configuration.iterations + .configuration.completedIterations)[]
    | ["option", $f.name, $f.id, "iteration", .id, .title]),
  (.data.repository.issueTypes.nodes // [] | .[] | select(.isEnabled)
    | ["option", "Type", "-", "type", .id, .name]),
  (.data.repository.issue // empty | ["issue", .url, .id]),
  (.data.repository.issue.issueType.name // empty | ["value", "Type", .]),
  (.data.repository.issue.labels.nodes // [] | .[] | ["label", .name]),
  (.data.repository.issue.projectItems.nodes // [] | .[] | select(.project.id == $p.id)
    | ["item", .id],
      (.fieldValues.nodes[] | select(.field) | ["value", .field.name, (.name // .title)]))
| @tsv
EOF

lookup() {
  gh api graphql -f query="$QUERY" -F owner="$OWNER" -F repo="$REPO" -F number="$issue" \
    -F project="$PROJECT" --jq "$FILTER"
}

# Read the lookup into globals: project_id, issue_url, issue_id, item_id, labels, the current
# values (the item's fields and the issue's Type) and the options (parallel arrays opt_*: field
# name, field id, select/iteration/type, option id, name).
load() { # what-it-means-on-failure
  local rows kind a b c d e
  rows=$(lookup) || die 1 "could not read issue #$issue and the Project from GitHub; $1"
  project_id="" issue_url="" issue_id="" item_id="" labels=" "
  current_fields=() current_values=()
  opt_fields=() opt_field_ids=() opt_kinds=() opt_ids=() opt_names=()
  while IFS=$'\t' read -r kind a b c d e; do
    case $kind in
      project) project_id=$a ;;
      issue)
        issue_url=$a
        issue_id=$b
        ;;
      item) item_id=$a ;;
      label) labels+="$a " ;;
      value)
        current_fields+=("$a")
        current_values+=("$b")
        ;;
      option)
        opt_fields+=("$a")
        opt_field_ids+=("$b")
        opt_kinds+=("$c")
        opt_ids+=("$d")
        opt_names+=("$e")
        ;;
    esac
  done <<<"$rows"
  [[ -n $project_id ]] || die 1 "Project $PROJECT of $OWNER not found; $1"
  [[ -n $issue_url ]] || die 1 "issue #$issue not found in $OWNER/$REPO; $1"
}

load "nothing was changed"

# Does option j answer to the name? Case-insensitive; a week also answers to its short name,
# the part of "Wk 2 · 9–15 Nov" before " · ".
option_matches() { # j name
  local want=${2,,} have=${opt_names[$1],,}
  [[ $have == "$want" ]] && return 0
  [[ ${opt_kinds[$1]} == iteration && ${have%% · *} == "$want" ]]
}

current() { # field -> its value on the item, or nothing
  local i
  for i in "${!current_fields[@]}"; do
    [[ ${current_fields[i]} == "$1" ]] && printf '%s' "${current_values[i]}"
  done
  return 0
}

# Status defaults to Backlog when the item is new or has none. A Status already set is left
# alone, so fixing a field on an issue never undoes the admin's move to Ready.
if [[ " ${req_fields[*]} " != *" Status "* && -z $(current Status) ]]; then
  req_fields=(Status "${req_fields[@]}")
  req_names=(Backlog "${req_names[@]}")
fi

# Resolve every name to an option before writing anything: plan holds indexes into opt_*.
plan=()
for i in "${!req_fields[@]}"; do
  field=${req_fields[i]} found="" valid=()
  for j in "${!opt_fields[@]}"; do
    [[ ${opt_fields[j]} == "$field" ]] || continue
    admin_only "$field" "${opt_names[j]}" && continue
    if [[ ${opt_kinds[j]} == iteration ]]; then
      valid+=("${opt_names[j]%% · *}")
    else
      valid+=("${opt_names[j]}")
    fi
    if [[ -z $found ]] && option_matches "$j" "${req_names[i]}"; then
      found=$j
    fi
  done
  if [[ -z $found ]]; then
    list=$(printf '%s, ' "${valid[@]}")
    die 2 "unknown $field \"${req_names[i]}\". Valid names: ${list%, }. Nothing was changed."
  fi
  plan+=("$found")
done

if [[ -z $item_id ]]; then
  item_id=$(gh project item-add "$PROJECT" --owner "$OWNER" --url "$issue_url" --format json --jq .id) ||
    die 1 "could not add $issue_url to the Project; nothing was set"
fi

join() { # items... -> "a, b, c", or "nothing"
  local s
  (($#)) || { printf nothing; return; }
  s=$(printf '%s, ' "$@")
  printf '%s' "${s%, }"
}

# The native type is set on the issue, not the item: updateIssue's issueTypeId (GitHub GraphQL
# reference, "UpdateIssueInput"). gh has no flag for it (gh 2.89).
read -r -d '' SET_TYPE <<'EOF' || true
mutation($issue: ID!, $type: ID!) {
  updateIssue(input: {id: $issue, issueTypeId: $type}) { issue { number } }
}
EOF

done_fields=()
for k in "${!plan[@]}"; do
  j=${plan[k]}
  if [[ ${opt_kinds[j]} == type ]]; then
    set_one() { gh api graphql -f query="$SET_TYPE" -f issue="$issue_id" -f type="${opt_ids[j]}" >/dev/null; }
  elif [[ ${opt_kinds[j]} == iteration ]]; then
    set_one() { gh project item-edit --project-id "$project_id" --id "$item_id" \
      --field-id "${opt_field_ids[j]}" --iteration-id "${opt_ids[j]}" >/dev/null; }
  else
    set_one() { gh project item-edit --project-id "$project_id" --id "$item_id" \
      --field-id "${opt_field_ids[j]}" --single-select-option-id "${opt_ids[j]}" >/dev/null; }
  fi
  if ! set_one; then
    left=()
    for l in "${plan[@]:k}"; do left+=("${opt_fields[l]}"); done
    die 1 "could not set ${opt_fields[j]}. set: $(join "${done_fields[@]}"); not set: $(join "${left[@]}"). Re-run the same command."
  fi
  done_fields+=("${opt_fields[j]}")
done

# Read the item back, so what's printed is what GitHub stored, and check it against the plan.
load "the fields were written but couldn't be read back; re-run to check"

# Triage: every issue carries a native type, Priority, Size and Week; `triage` stays on while one
# is missing and comes off here once all four are set (docs/agents/issue-tracker.md, "Issue
# fields"). Only removed, never added: new-issue.sh adds it when it files an issue.
missing_four() {
  local f
  for f in Type Priority Size Week; do
    [[ -n $(current "$f") ]] || printf '%s\n' "$f"
  done
}
has_triage() { [[ $labels == *" triage "* ]]; }
mapfile -t missing < <(missing_four)
removed=""
if ((${#missing[@]} == 0)) && has_triage; then
  gh issue edit "$issue" --repo "$OWNER/$REPO" --remove-label triage >/dev/null ||
    die 1 "the fields are set, but \`triage\` couldn't be removed. Run: gh issue edit $issue --repo $OWNER/$REPO --remove-label triage"
  removed=1
  load "\`triage\` was removed but the issue couldn't be read back; re-run to check"
fi

printf '%s\n' "$issue_url"
for field in Type Status Track Mode Size Priority Week; do
  value=$(current "$field")
  printf '%-9s %s\n' "$field:" "${value:--}"
done
if has_triage; then
  triage="yes"
  ((${#missing[@]})) && triage+=" (missing: $(join "${missing[@]}"))"
elif [[ -n $removed ]]; then
  triage="removed (type, Priority, Size and Week are set)"
else
  triage="-"
  ((${#missing[@]})) && triage+=" (missing: $(join "${missing[@]}"))"
fi
printf '%-9s %s\n' "Triage:" "$triage"

mismatches=()
if ((${#missing[@]} == 0)) && has_triage; then
  mismatches+=("triage is still on, though all four are set")
fi
for j in "${plan[@]}"; do
  value=$(current "${opt_fields[j]}")
  if [[ $value != "${opt_names[j]}" ]]; then
    mismatches+=("${opt_fields[j]} is ${value:--}, expected ${opt_names[j]}")
  fi
done
if ((${#mismatches[@]})); then
  list=$(printf '%s; ' "${mismatches[@]}")
  die 1 "the read-back differs from what was set: ${list%; }. GitHub may lag; re-run to check."
fi

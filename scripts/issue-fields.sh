#!/usr/bin/env bash
# Add an issue to the Sunny Pastures Project (if it isn't on it) and set its fields by name.
# Field and option ids are looked up from GitHub on every run, never hard-coded. Every name is
# checked before the first write, so a typo changes nothing. Tests: scripts/issue-fields.test.sh.
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
usage: scripts/issue-fields.sh <issue> [--track NAME] [--mode NAME] [--size NAME]
                               [--priority NAME] [--week NAME] [--status NAME]

Adds the issue to the Sunny Pastures Project if it's missing, sets the named fields, then prints
the fields as GitHub stored them. Names ignore case; --week takes "Wk 2" or the full title.
Each flag also takes the form --size=M.

Status: a new item, or one with no Status, gets Backlog. A Status already set is left alone
unless --status is given (--status Backlog may move an issue back). Admin-only values are
refused: --status Ready and --mode Factory.

After the writes it reads the item back and fails if a field doesn't show the value it set.

Exit codes: 0 done, 1 a gh call failed or the read-back differs, 2 bad arguments or an unknown
name (nothing changed).

example: scripts/issue-fields.sh 47 --track Infra --mode Manual --size S --priority P2 --week "Wk 2"
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

# One read-only lookup: the Project's fields and options, and the issue's item on the Project.
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
    issue(number: $number) {
      url title
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
  (.data.repository.issue // empty | ["issue", .url]),
  (.data.repository.issue.projectItems.nodes // [] | .[] | select(.project.id == $p.id)
    | ["item", .id],
      (.fieldValues.nodes[] | select(.field) | ["value", .field.name, (.name // .title)]))
| @tsv
EOF

lookup() {
  gh api graphql -f query="$QUERY" -F owner="$OWNER" -F repo="$REPO" -F number="$issue" \
    -F project="$PROJECT" --jq "$FILTER"
}

# Read the lookup into globals: project_id, issue_url, item_id, the item's current values and
# the options (parallel arrays opt_*: field name, field id, select/iteration, option id, name).
load() { # what-it-means-on-failure
  local rows kind a b c d e
  rows=$(lookup) || die 1 "could not read issue #$issue and the Project from GitHub; $1"
  project_id="" issue_url="" item_id=""
  current_fields=() current_values=()
  opt_fields=() opt_field_ids=() opt_kinds=() opt_ids=() opt_names=()
  while IFS=$'\t' read -r kind a b c d e; do
    case $kind in
      project) project_id=$a ;;
      issue) issue_url=$a ;;
      item) item_id=$a ;;
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

done_fields=()
for k in "${!plan[@]}"; do
  j=${plan[k]}
  if [[ ${opt_kinds[j]} == iteration ]]; then
    set_flag=--iteration-id
  else
    set_flag=--single-select-option-id
  fi
  if ! gh project item-edit --project-id "$project_id" --id "$item_id" \
    --field-id "${opt_field_ids[j]}" "$set_flag" "${opt_ids[j]}" >/dev/null; then
    left=()
    for l in "${plan[@]:k}"; do left+=("${opt_fields[l]}"); done
    die 1 "could not set ${opt_fields[j]}. set: $(join "${done_fields[@]}"); not set: $(join "${left[@]}"). Re-run the same command."
  fi
  done_fields+=("${opt_fields[j]}")
done

# Read the item back, so what's printed is what GitHub stored, and check it against the plan.
load "the fields were written but couldn't be read back; re-run to check"
printf '%s\n' "$issue_url"
for field in Status Track Mode Size Priority Week; do
  value=$(current "$field")
  printf '%-9s %s\n' "$field:" "${value:--}"
done
mismatches=()
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

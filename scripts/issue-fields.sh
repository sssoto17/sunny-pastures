#!/usr/bin/env bash
# Add an issue to the Sunny Pastures Project (if it isn't on it) and set its fields and its native
# issue type by name, then remove `triage` once the four fields every issue carries are set
# (docs/agents/issue-tracker.md, "Issue fields"). Field, option and type ids are looked up from
# GitHub on every run, never hard-coded. Every name is checked before the first write, so a typo
# changes nothing; with the Project refused, only the type's name can be checked (the Project's
# field names are checked by the finishing run). REST only (`gh api`), local and cloud alike (#346): the issue through
# repos/<owner>/<repo>, the Project through the REST Projects API, which the cloud proxy refuses;
# then the issue's part is done and exit 4 prints the command that finishes the rest.
# --from makes it a guarded move of Status alone, for the board workflow (#417).
# Tests: scripts/issue-fields.test.sh.
# Needs bash 4.4+ (empty arrays under set -u) and an authenticated gh with the `project` scope, or
# PROJECT_GH_TOKEN holding a token with it (then gh uses that token for the Project's calls only).
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "issue-fields: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

OWNER=sssoto17
REPO=sunny-pastures
here="$(cd "$(dirname "$0")" && pwd)"
# PROJECT_API, PROJECT_NUMBER, PROJECT_JQ_DEFS, PROJECT_SKIPPED, project_refused, project_rerun.
# shellcheck source=scripts/lib/project-rest.sh
. "$here/lib/project-rest.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/issue-fields.sh <issue> [--type NAME] [--track NAME] [--mode NAME] [--size NAME]
                               [--priority NAME] [--week NAME] [--status NAME]
       scripts/issue-fields.sh <issue> --status NAME --from NAME[,NAME...]

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

Guarded move (--from, the board workflow's form, #417): sets Status alone, and only when the
issue is on the Project and its Status is now one of the --from names. Otherwise it changes
nothing, says why, and exits 0. It never adds the issue to the Project, never sets another field
and never removes `triage`. --from never names Backlog: only the admin moves an issue out of it.
It takes no other flag but --status.

PROJECT_GH_TOKEN, when set, is the token for the Project's calls only; the issue's calls keep
gh's own (GH_TOKEN). The board workflow keeps its Project token away from the repo that way.

After the writes it reads the issue and its item back and fails if a field doesn't show the
value it set, or if `triage` is still on once all four are set.

Where GitHub refuses the Project (HTTP 403, as the cloud's GitHub proxy does), it still sets
--type, prints "?" for the Project's fields, names the step it skipped and the command that
finishes it from a local session, and exits 4. The Project's field names (--size XL, --week
"Wk 99") can't be checked then: only --type is. The finishing run checks them.

Exit codes: 0 done (with --from, also left alone), 1 a gh call failed or the read-back differs, 2 bad arguments or an unknown
name (nothing changed), 4 the Project step was skipped: the issue's type is set, the Project
wasn't touched and its field names weren't checked; run the printed command where the Project
can be reached.

example: scripts/issue-fields.sh 47 --type Chore --track Infra --mode Manual --size S --priority P2 --week "Wk 2"
EOF
}

die() { # code message
  printf 'issue-fields: %s\n' "$2" >&2
  exit "$1"
}

# The Project's calls: with PROJECT_GH_TOKEN set, gh uses it for them and nothing else (#417).
project_gh() { # gh args...
  if [[ -n ${PROJECT_GH_TOKEN-} ]]; then GH_TOKEN=$PROJECT_GH_TOKEN gh "$@"; else gh "$@"; fi
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
all_args=("$@")
issue=${1#\#}
[[ $issue =~ ^[1-9][0-9]*$ ]] || die 2 "not an issue number: \"$1\""
shift

# Requested fields, in the order given: parallel arrays of field name and option name.
req_fields=()
req_names=()
from_names=() # --from: the Statuses a guarded move starts from
from_given=""
while (($#)); do
  flag=${1%%=*}
  case $flag in
    --from) field=From ;;
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
  if [[ $field == From ]]; then
    [[ -z $from_given ]] || die 2 "--from given twice"
    from_given=1
    IFS=, read -ra parts <<<"$value"
    for name in "${parts[@]}"; do
      name=${name#"${name%%[![:space:]]*}"} name=${name%"${name##*[![:space:]]}"}
      [[ -n $name ]] || die 2 "--from has an empty name: \"$value\""
      [[ ${name,,} != backlog ]] ||
        die 2 "--from never names Backlog: only the admin moves an issue out of it (docs/agents/issue-tracker.md, Status rules)"
      from_names+=("$name")
    done
    continue
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
if [[ -n $from_given && "${req_fields[*]}" != Status ]]; then
  die 2 "--from moves Status alone: give --status and no other field"
fi

# --- the lookup ---------------------------------------------------------------------------------
# All REST (docs/agents/github-rest.md): the issue (its id, native type and labels) and the
# repo's issue types from repos/<owner>/<repo>; the Project's fields and the issue's item from
# the REST Projects API. Each output line is tab-separated: a record type, then its values. A
# type is set by its name over REST, so a type's option id is its name.
ISSUE_FILTER='["issue", .html_url, .id], (.type.name // empty | ["value", "Type", .]),
  (.labels[] | ["label", .name]) | @tsv'
TYPES_FILTER='.[] | select(.is_enabled) | ["option", "Type", "-", "type", .name, .name] | @tsv'
FIELDS_FILTER="$PROJECT_JQ_DEFS"'
.[] | . as $f
| if .data_type == "single_select" then
    .options[] | ["option", $f.name, $f.id, "select", .id, (.name | txt)]
  elif .data_type == "iteration" then
    ((.configuration.iterations // []) + (.configuration.completed_iterations // []))[]
    | ["option", $f.name, $f.id, "iteration", .id, (.title | txt)]
  else empty end | @tsv'
# The issue's item: matched by the issue's id; its values for the fields asked for by id.
ITEM_FILTER="$PROJECT_JQ_DEFS"'
.[] | select(.content_type == "Issue" and .content.id == $id)
| ["item", .id], (.fields[]? | select(.name != "Title") | val as $v | select($v != null)
  | ["value", .name, $v]) | @tsv'

project_err=$(mktemp "${TMPDIR:-/tmp}/issue-fields.XXXXXX")
trap 'rm -f "$project_err"' EXIT

# Read the lookup into globals: issue_url, issue_id, item_id, labels, project_ok (0 once GitHub
# refused the Project), the current values (the item's fields and the issue's Type) and the
# options (parallel arrays opt_*: field name, field id, select/iteration/type, option id, name).
load() { # what-it-means-on-failure
  local rows fields ids kind a b c d e
  rows=$(gh api "repos/$OWNER/$REPO/issues/$issue" --jq "$ISSUE_FILTER") ||
    die 1 "could not read issue #$issue of $OWNER/$REPO from GitHub (does it exist?); $1"
  issue_id=$(awk -F'\t' '$1 == "issue" { print $3 }' <<<"$rows")
  [[ $issue_id =~ ^[0-9]+$ ]] || die 1 "unexpected answer from GitHub for issue #$issue, has the API changed?; $1"
  rows+=$'\n'$(gh api "repos/$OWNER/$REPO/issue-types" --jq "$TYPES_FILTER") ||
    die 1 "could not read the issue types of $OWNER/$REPO from GitHub; $1"
  project_ok=1
  if ! fields=$(project_gh api "$PROJECT_API/fields?per_page=100" --jq "$FIELDS_FILTER" 2>"$project_err"); then
    [[ -n ${refusal_shown-} ]] || cat "$project_err" >&2 # once, not again on the read-back
    refusal_shown=1
    project_refused "$project_err" || die 1 "could not read Project $PROJECT_NUMBER of $OWNER from GitHub; $1"
    project_ok=0
  fi
  if ((project_ok)); then
    ids=$(cut -f3 <<<"$fields" | sort -u | paste -sd, -)
    rows+=$'\n'$fields
    rows+=$'\n'$(project_gh api --paginate "$PROJECT_API/items?per_page=100&fields=$ids" \
      --jq "${ITEM_FILTER//\$id/$issue_id}") ||
      die 1 "could not read the items of Project $PROJECT_NUMBER from GitHub; $1"
  fi
  issue_url="" item_id="" labels=" "
  current_fields=() current_values=()
  opt_fields=() opt_field_ids=() opt_kinds=() opt_ids=() opt_names=()
  while IFS=$'\t' read -r kind a b c d e; do
    case $kind in
      issue) issue_url=$a ;;
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

join() { # items... -> "a, b, c", or "nothing"
  local s
  (($#)) || { printf nothing; return; }
  s=$(printf '%s, ' "$@")
  printf '%s' "${s%, }"
}

# A guarded move (--from) goes ahead only for an issue on the Project whose Status is one it
# starts from; anything else is left as it is (#417). Names are checked first, as for any field.
if [[ -n $from_given ]]; then
  ((project_ok)) || die "$PROJECT_SKIPPED" "skipped the move: GitHub refused the Project here ($PROJECT_REFUSED_WHY), so nothing changed. Finish where the Project can be reached: $(project_rerun scripts/issue-fields.sh "${all_args[@]}")"
  from_canon=()
  for name in "${from_names[@]}"; do
    found=""
    for j in "${!opt_fields[@]}"; do
      if [[ ${opt_fields[j]} == Status && ${opt_names[j],,} == "${name,,}" ]]; then
        found=${opt_names[j]}
      fi
    done
    [[ -n $found ]] || die 2 "unknown Status \"$name\" in --from. Nothing was changed."
    from_canon+=("$found")
  done
  now=$(current Status)
  why=""
  if [[ -z $item_id ]]; then
    why="it isn't on the Project"
  else
    why="a move to ${req_names[0]} starts only from $(join "${from_canon[@]}")"
    for name in "${from_canon[@]}"; do
      [[ $name == "$now" ]] && why=""
    done
  fi
  if [[ -n $why ]]; then
    printf '%s\n%-9s %s\n' "$issue_url" "Status:" "${now:--} (left alone: $why)"
    exit 0
  fi
fi

# Status defaults to Backlog when the item is new or has none. A Status already set is left
# alone, so fixing a field on an issue never undoes the admin's move to Ready.
if ((project_ok)) && [[ " ${req_fields[*]} " != *" Status "* && -z $(current Status) ]]; then
  req_fields=(Status "${req_fields[@]}")
  req_names=(Backlog "${req_names[@]}")
fi

# Resolve every name to an option before writing anything: plan holds indexes into opt_*. A
# Project field can't be checked while the Project is refused: it goes to `skipped`.
plan=() skipped=()
for i in "${!req_fields[@]}"; do
  field=${req_fields[i]} found="" valid=()
  if [[ $field != Type ]] && ((!project_ok)); then
    skipped+=("$field")
    continue
  fi
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

# --- writes -------------------------------------------------------------------------------------
# The type first, on the issue (REST "Update an issue", `type` by name), then every Project field
# in one item update (REST "Update project item for user": field ids and option or iteration ids).
type_plan=() field_plan=()
for j in "${plan[@]}"; do
  if [[ ${opt_kinds[j]} == type ]]; then type_plan+=("$j"); else field_plan+=("$j"); fi
done
names_of() { local j; for j in "$@"; do printf '%s\n' "${opt_fields[j]}"; done; }

if ((${#field_plan[@]})) && [[ -z $item_id ]]; then
  item_id=$(project_gh api -X POST "$PROJECT_API/items" -f type=Issue -F id="$issue_id" --jq .id) ||
    die 1 "could not add $issue_url to the Project; nothing was set"
fi

done_fields=()
for j in "${type_plan[@]}"; do
  if ! gh api -X PATCH "repos/$OWNER/$REPO/issues/$issue" -f type="${opt_ids[j]}" --silent; then
    mapfile -t left < <(names_of "${plan[@]}")
    die 1 "could not set Type. set: nothing; not set: $(join "${left[@]}"). Re-run the same command."
  fi
  done_fields+=(Type)
done
if ((${#field_plan[@]})); then
  # Ids are GitHub's: a field id is a number, an option or iteration id a short token. Anything
  # else would break the JSON, so it stops before writing.
  body="" sep=""
  for j in "${field_plan[@]}"; do
    [[ ${opt_field_ids[j]} =~ ^[0-9]+$ && ${opt_ids[j]} =~ ^[A-Za-z0-9_-]+$ ]] ||
      die 1 "unexpected id for ${opt_fields[j]} from GitHub (${opt_field_ids[j]}, ${opt_ids[j]}), has the API changed? set: $(join "${done_fields[@]}")"
    body+="$sep{\"id\":${opt_field_ids[j]},\"value\":\"${opt_ids[j]}\"}"
    sep=,
  done
  body="{\"fields\":[$body]}"
  if ! project_gh api -X PATCH "$PROJECT_API/items/$item_id" --input - --silent <<<"$body"; then
    mapfile -t left < <(names_of "${field_plan[@]}")
    die 1 "could not set $(join "${left[@]}"). set: $(join "${done_fields[@]}"); not set: $(join "${left[@]}"). Re-run the same command."
  fi
fi

# Read the issue and item back, so what's printed is what GitHub stored, and check it.
load "the fields were written but couldn't be read back; re-run to check"

# Triage: every issue carries a native type, Priority, Size and Week; `triage` stays on while one
# is missing and comes off here once all four are set (docs/agents/issue-tracker.md, "Issue
# fields"). Only removed, never added: new-issue.sh adds it when it files an issue. Without the
# Project, Priority, Size and Week can't be read, so triage is left for the finishing run.
missing_four() {
  local f
  for f in Type Priority Size Week; do
    [[ -n $(current "$f") ]] || printf '%s\n' "$f"
  done
}
has_triage() { [[ $labels == *" triage "* ]]; }
mapfile -t missing < <(missing_four)
removed=""
if ((project_ok && ${#missing[@]} == 0)) && has_triage && [[ -z $from_given ]]; then
  gh api -X DELETE "repos/$OWNER/$REPO/issues/$issue/labels/triage" --silent ||
    die 1 "the fields are set, but \`triage\` couldn't be removed. Run: gh api -X DELETE repos/$OWNER/$REPO/issues/$issue/labels/triage"
  removed=1
  load "\`triage\` was removed but the issue couldn't be read back; re-run to check"
fi

printf '%s\n' "$issue_url"
for field in Type Status Track Mode Size Priority Week; do
  value=$(current "$field")
  [[ $field != Type ]] && ((!project_ok)) && value="?"
  printf '%-9s %s\n' "$field:" "${value:--}"
done
if ((!project_ok)); then
  triage="? (the Project couldn't be read)"
elif has_triage; then
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
if ((project_ok && ${#missing[@]} == 0)) && has_triage && [[ -z $from_given ]]; then
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

# The skipped step (#346, criterion 3): everything the issue itself holds is done; the Project's
# part waits for a session that can reach it. Re-running the whole command is safe.
if ((!project_ok)); then
  step="add #$issue to Project $PROJECT_NUMBER if it isn't on it, set Status if unset"
  ((${#skipped[@]})) && step+=", set $(join "${skipped[@]}")"
  step+=", and remove \`triage\` once the four are set"
  die "$PROJECT_SKIPPED" "skipped the Project step: GitHub refused the Project here ($PROJECT_REFUSED_WHY), so nothing on it changed$( ((${#type_plan[@]})) && echo "; the type is set"). Skipped: $step. Finish from a local session, or the admin runs: $(project_rerun scripts/issue-fields.sh "${all_args[@]}")"
fi

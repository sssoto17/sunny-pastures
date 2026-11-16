# shellcheck shell=bash
# The type label -> GitHub native issue type mapping, sourced by new-issue.sh and
# backfill-issue-types.sh: the scripts' copy of the Types table in docs/agents/triage-labels.md,
# so keep the two the same. The admin set it on 15 Nov 2026 (#266). Callers bring bash 4.4+ and
# set -euo pipefail; nothing here exits.
# Tests: scripts/new-issue.test.sh, scripts/backfill-issue-types.test.sh. The issue forms'
# `type:` keys (.github/ISSUE_TEMPLATE/*.yml) must match too: .github/scripts/tests/issue-forms.test.mjs.

# The type labels, in the order the docs list them.
# shellcheck disable=SC2034 # read by new-issue.sh
TYPE_LABELS=(feature bug spike design chore idea)

# The native types the mapping uses: the repo must offer exactly these (check_native_types).
NATIVE_TYPES=(Feature Bug Design Chore)

native_type() { # type label -> native type name, or nothing for any other label
  case $1 in
    feature) echo Feature ;;
    bug) echo Bug ;;
    design) echo Design ;;
    spike | chore | idea) echo Chore ;;
  esac
}

# Compare the repo's enabled issue types (names, one per line) with NATIVE_TYPES. Prints why they
# disagree and returns 1, so a rename of the repo's types is caught on the next run of any script
# that sources this, not at the next filing of the type that moved.
check_native_types() { # repo type names (newline-separated)
  local name have=() missing=() extra=() s
  while IFS= read -r name; do
    [[ -n $name ]] && have+=("$name")
  done <<<"$1"
  for name in "${NATIVE_TYPES[@]}"; do
    grep -qxF -- "$name" <<<"$1" || missing+=("$name")
  done
  for name in "${have[@]}"; do
    [[ " ${NATIVE_TYPES[*]} " == *" $name "* ]] || extra+=("$name")
  done
  ((${#missing[@]} + ${#extra[@]})) || return 0
  s="the repo's issue types ($(_types_join "${have[@]}")) and the mapping in scripts/lib/issue-types.sh"
  s+=" ($(_types_join "${NATIVE_TYPES[@]}")) disagree:"
  ((${#missing[@]})) && s+=" the repo offers no $(_types_join "${missing[@]}");"
  ((${#extra[@]})) && s+=" nothing maps to $(_types_join "${extra[@]}");"
  s+=" update the mapping and docs/agents/triage-labels.md (Types) to match the repo"
  printf '%s' "$s"
  return 1
}

_types_join() { # items... -> "a, b, c"
  local s
  s=$(printf '%s, ' "$@")
  printf '%s' "${s%, }"
}

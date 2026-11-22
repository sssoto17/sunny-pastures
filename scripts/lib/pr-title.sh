# shellcheck shell=bash
# The PR-title rule (#471), sourced by open-pr.sh and stack.sh: a title starts with a Conventional
# Commit type, an optional (scope) and !, then ": " and a summary, since it is also the squash
# commit's subject (docs/agents/triage-labels.md, the PR title prefixes). A body file's first line is
# the title, so a body that starts with its `Closes #N` or `Part of #N` line is refused here rather
# than opened with that line as its title (#466). Callers bring bash 4.4+ and
# set -euo pipefail; nothing here exits.
# Tests: scripts/open-pr.test.sh, scripts/stack.test.sh.

# The types a title may start with. `spike` is the spike PRs' prefix in triage-labels.md. Keep the
# list the same as triage-labels.md ("PR title prefix") and open-pr.sh's usage text.
PR_TITLE_TYPES=(feat fix chore docs test ci build refactor perf style revert spike)

pr_title_problem() { # title -> nothing when it passes, else what's wrong and the fix, on stdout
  local title=$1 types list link='^[[:space:]]*([Cc]loses|[Ff]ixes|[Rr]esolves|[Pp]art of) #'
  types=$(IFS='|'; echo "${PR_TITLE_TYPES[*]}")
  [[ $title =~ ^($types)(\([^()[:space:]]+\))?!?:\ [^[:space:]] ]] && return 0
  if [[ $title =~ $link ]]; then
    printf '%s' "the title is the body file's first line, which here is the link \"$title\": put \
a title line such as \`fix(tools): <summary>\` above it, and keep the link in the body"
    return 0
  fi
  printf -v list '%s, ' "${PR_TITLE_TYPES[@]}"
  printf '%s' "the title \"$title\" doesn't start with a conventional type: make the body file's \
first line \`<type>(<scope>): <summary>\`, the scope optional, with <type> one of ${list%, } \
(docs/agents/triage-labels.md)"
}

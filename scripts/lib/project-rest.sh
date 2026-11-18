# shellcheck shell=bash
# The Sunny Pastures Project over REST (#346), sourced by issue-fields.sh, missing-fields.sh and
# today-gather.sh: the endpoints, how a field's value reads, and how a refused Project read is
# told apart from a failure. GitHub's REST Projects API ("Projects" in the REST reference:
# fields, items) reads and writes item field values; GraphQL isn't needed. Inventory and
# sources: docs/agents/github-rest.md. Callers bring bash 4.4+ and set -euo pipefail; nothing
# here exits. Tests: scripts/lib/project-rest.test.sh, and each caller's suite.

# shellcheck disable=SC2034 # read by the callers
PROJECT_OWNER=sssoto17
PROJECT_NUMBER=3
# shellcheck disable=SC2034
PROJECT_API=users/$PROJECT_OWNER/projectsV2/$PROJECT_NUMBER
# shellcheck disable=SC2034
PROJECT_URL=https://github.com/users/$PROJECT_OWNER/projects/$PROJECT_NUMBER

# Exit code a script uses when it did every other part but GitHub refused the Project here
# (#346, criterion 3). The cloud GitHub proxy answers 403 for any path outside repos/<owner>/<repo>.
# shellcheck disable=SC2034
PROJECT_SKIPPED=4

# jq definitions for a REST item's field values. A single-select value is an object whose name is
# {raw, html} (the "Get an item" example); an iteration's title is read the same way; text,
# number and date values are plain. `fv(name)` is the item's value for the field of that name, or
# null.
# shellcheck disable=SC2016 # a jq program, not shell
PROJECT_JQ_DEFS='def txt: if type == "object" then (.raw // .html) else . end;
def val: if .value == null then null
  elif (.value | type) == "object" then ((.value.name // .value.title) | txt)
  else .value end;
def fv($n): ([.fields[]? | select(.name == $n) | val] | first);'

# Callers run a Project call with gh's stderr in a file; after a failure, this says whether it
# was GitHub (or the proxy) refusing access, rather than an error worth stopping for.
project_refused() { # errfile -> 0 if the failed call was refused with HTTP 403
  [[ -f $1 ]] && grep -q 'HTTP 403' "$1"
}

# The command line that finishes a skipped step, quoted for the shell.
project_rerun() { # script args...
  local s=$1
  shift
  (($#)) && s+=$(printf ' %q' "$@")
  printf '%s' "$s"
}

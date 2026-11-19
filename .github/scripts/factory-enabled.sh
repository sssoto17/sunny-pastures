#!/usr/bin/env bash
# The factory's kill switch (#106; ADR-0002, area 2, "Caps"). Reads the repo variable
# FACTORY_ENABLED, writes run=true|false to GITHUB_OUTPUT and logs one SWITCH line. Only the exact
# value `true` turns the factory on; unset, empty, `false`, `TRUE` and anything else keep it off.
# .github/workflows/factory-switch.yml runs it as the first job of the factory workflow (#107) and
# the sweep and chain (#108); their other jobs need it and run only on run=true, so with the switch
# off no job reaches the `factory` environment, mints a token or calls Claude. The reviewer never
# calls it. Tests: .github/scripts/tests/factory-enabled.test.mjs.
#
# Env: FACTORY_ENABLED (vars.FACTORY_ENABLED, through env:), GITHUB_WORKFLOW (set by Actions, for
# the log), GITHUB_OUTPUT. Without GITHUB_OUTPUT the step fails rather than let the caller guess.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"
value=${FACTORY_ENABLED-}
caller=${GITHUB_WORKFLOW:-unknown}

if [[ $value == true ]]; then
  echo "SWITCH on: FACTORY_ENABLED is true (workflow: $caller)"
  echo "run=true" >>"$GITHUB_OUTPUT"
  exit 0
fi

# %q shows an empty value as '' and a newline as $'\n', so the log stays one line.
printf 'SWITCH off: FACTORY_ENABLED is %q, not true: factory stops before a token or Claude (workflow: %s)\n' \
  "$value" "$caller"
echo "run=false" >>"$GITHUB_OUTPUT"

#!/usr/bin/env bash
# Runs the shell scripts' test suites (#255): every *.test.sh under scripts/ and .claude/hooks/,
# found here, so a new suite is picked up without a workflow edit. Run from the repo root:
#   bash .github/scripts/shell-suites.sh
set -uo pipefail

suites=()
while IFS= read -r -d '' f; do suites+=("$f"); done < <(
  find scripts .claude/hooks -type f -name '*.test.sh' -print0 2>/dev/null | sort -z
)
if ((${#suites[@]} == 0)); then
  echo "shell-suites: no *.test.sh suites found under scripts/ or .claude/hooks/; run it from the repo root" >&2
  exit 1
fi

# Every suite puts its own fake gh first on PATH. One that forgets must fail here, not reach
# GitHub: a gh that refuses every call goes ahead of the real one, with no token and an empty
# config folder behind it, so the real gh has nothing to log in with either (#255). This holds
# locally too, where the admin's gh is logged in.
block=$(mktemp -d "${TMPDIR:-/tmp}/shell-suites.XXXXXX") || exit 1
trap 'rm -rf "$block"' EXIT
mkdir "$block/bin" "$block/gh-config"
cat >"$block/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "shell-suites: a suite reached the real gh (gh $1 $2 ...); put a fake gh first on its PATH" >&2
exit 97
EOF
chmod +x "$block/bin/gh"
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
export PATH="$block/bin:$PATH" GH_CONFIG_DIR="$block/gh-config"

# On Actions each suite's log folds into a group and a failure is annotated on the run; a local
# run prints plain headers.
actions=${GITHUB_ACTIONS:-}
passed=0 failed=() rows=()
for f in "${suites[@]}"; do
  if [[ $actions == true ]]; then echo "::group::$f"; else echo "== $f"; fi
  start=$SECONDS
  if bash "$f" </dev/null 2>&1; then
    passed=$((passed + 1)) result=ok
  else
    failed+=("$f") result=FAIL
  fi
  [[ $actions == true ]] && echo "::endgroup::"
  [[ $actions == true && $result == FAIL ]] && echo "::error title=ci / scripts::$f failed"
  rows+=("$(printf '%-4s %4ds  %s' "$result" $((SECONDS - start)) "$f")")
done

echo
printf '%s\n' "${rows[@]}"
printf '%d suites: %d passed, %d failed\n' "${#suites[@]}" "$passed" "${#failed[@]}"
if ((${#failed[@]})); then
  printf 'Failed:\n'
  printf '  %s\n' "${failed[@]}"
  exit 1
fi

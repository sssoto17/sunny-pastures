#!/usr/bin/env bash
# Tests for after-edit.sh, through its hook interface: PostToolUse JSON on stdin, exit 0 (pass),
# 2 (block, message on stderr) or 1 (hook error). A throwaway git repo stands in for the work tree:
# its node_modules/.bin/prettier and the pnpm on PATH are fakes that log their arguments, so the
# tests see what ran and in which order. Run: bash .claude/hooks/after-edit.test.sh
set -uo pipefail

hook="$(cd "$(dirname "$0")" && pwd)/after-edit.sh"
pass=0
fail=0

tmp=$(mktemp -d "${TMPDIR:-/tmp}/after-edit-test.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
bin="$tmp/bin"
log="$tmp/log"
mkdir -p "$repo/node_modules/.bin" "$repo/docs" "$bin"
git -c init.defaultBranch=main init -q "$repo"
repo=$(cd "$repo" && git rev-parse --show-toplevel) # the path git reports, symlinks resolved

# Fakes: each logs one line, then exits with the code its variable names (0 by default).
cat >"$repo/node_modules/.bin/prettier" <<EOF
#!/usr/bin/env bash
echo "prettier \$*" >>"$log"
exit \${PRETTIER_EXIT:-0}
EOF
cat >"$bin/pnpm" <<EOF
#!/usr/bin/env bash
echo "pnpm \$*" >>"$log"
exit \${PNPM_EXIT:-0}
EOF
chmod +x "$repo/node_modules/.bin/prettier" "$bin/pnpm"
touch "$repo/README.md" "$repo/docs/a b.md" "$repo/a.ts"

json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

run_hook() { # tool file [cwd] -> sets code, err, ran (the fakes' log)
  local input
  input=$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PostToolUse","tool_name":%s,"tool_input":{"file_path":%s}}' \
    "$(json_str "${3:-$repo}")" "$(json_str "$1")" "$(json_str "$2")")
  : >"$log"
  err=$(cd "${3:-$repo}" && PATH="$bin:$PATH" timeout 10 bash "$hook" <<<"$input" 2>&1 >/dev/null)
  code=$?
  ran=$(cat "$log")
}

check() { # name expected-code expected-log [stderr-substring]
  if [[ $code -eq $2 && $ran == "$3" && (-z ${4:-} || $err == *"$4"*) ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: %s\n  exit: expected %s, got %s\n  ran: expected [%s], got [%s]\n  stderr: %s\n' \
      "$1" "$2" "$code" "$3" "$ran" "$err"
  fi
}

FAST="pnpm --silent check:fast"

# --- Markdown: Prettier first, then check:fast ---------------------------------------------------
run_hook Edit "$repo/README.md"
check "an edited .md file is formatted, then check:fast runs" 0 \
  "prettier --write --log-level warn $repo/README.md"$'\n'"$FAST"

run_hook Write "$repo/docs/a b.md"
check "a path with a space reaches prettier as one argument" 0 \
  "prettier --write --log-level warn $repo/docs/a b.md"$'\n'"$FAST"

run_hook MultiEdit "$repo/docs/a b.md" "$repo/docs"
check "the repo is found from a subfolder of the cwd" 0 \
  "prettier --write --log-level warn $repo/docs/a b.md"$'\n'"$FAST"

# --- what Prettier never sees ------------------------------------------------------------------
run_hook Edit "$repo/a.ts"
check "a code file runs check:fast only" 0 "$FAST"

run_hook Write "$tmp/notes.md"
check "a .md file outside the repo isn't formatted" 0 "$FAST"

run_hook Write "$repo/gone.md"
check "a .md path that isn't a file isn't formatted" 0 "$FAST"

# --- failures block ----------------------------------------------------------------------------
PNPM_EXIT=1 run_hook Edit "$repo/README.md"
check "a failing check:fast blocks the edit" 2 \
  "prettier --write --log-level warn $repo/README.md"$'\n'"$FAST"

PRETTIER_EXIT=2 run_hook Edit "$repo/README.md"
check "a failing prettier blocks, and check:fast doesn't run" 2 \
  "prettier --write --log-level warn $repo/README.md" "prettier couldn't format"

# --- skipped -----------------------------------------------------------------------------------
mkdir -p "$tmp/plain"
run_hook Edit "$tmp/plain/x.md" "$tmp/plain"
check "outside a git repo nothing runs" 0 ""

mv "$repo/node_modules" "$tmp/nm"
run_hook Edit "$repo/README.md"
check "a repo without node_modules is skipped" 0 ""
mv "$tmp/nm" "$repo/node_modules"

printf '%s passed, %s failed\n' "$pass" "$fail"
((fail == 0))

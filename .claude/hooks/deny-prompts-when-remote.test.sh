#!/usr/bin/env bash
# Tests for deny-prompts-when-remote.mjs, through its hook interface: PermissionRequest JSON on
# stdin, exit 0, and on stdout either the deny decision or nothing (#574).
# Run: bash .claude/hooks/deny-prompts-when-remote.test.sh
set -uo pipefail

hook="$(dirname "$0")/deny-prompts-when-remote.mjs"
pass=0
fail=0
unset CLAUDE_CODE_REMOTE CLAUDE_ATTENDED # set in cloud sessions; each case sets its own

INPUT='{"session_id":"t","cwd":"/home/dev/sunny-pastures","permission_mode":"auto","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"pnpm exec prettier --write x.ts","description":"test"}}'

run_hook() { # stdin env-assignments... -> sets code, out
  local input=$1
  shift
  out=$(env "$@" timeout 5 node "$hook" <<<"$input" 2>/dev/null)
  code=$?
}

record() { # name ok
  if [[ $2 == ok ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n' "$1" "$code" "$out"
  fi
}

denies() { # name stdin env-assignments...
  local name=$1
  shift
  run_hook "$@"
  local decision
  decision=$(jq -c '.hookSpecificOutput | [.hookEventName, .decision.behavior, (.decision.message | test("unattended cloud session") and test("simpler, separate commands") and test("report it"))]' <<<"$out" 2>/dev/null)
  [[ $code -eq 0 && $decision == '["PermissionRequest","deny",true]' ]] && record "$name" ok || record "$name" no
}

silent() { # name stdin env-assignments...
  local name=$1
  shift
  run_hook "$@"
  [[ $code -eq 0 && -z $out ]] && record "$name" ok || record "$name" no
}

# --- an unattended cloud session: every prompt becomes a deny ---------------------------------
denies 'cloud' "$INPUT" CLAUDE_CODE_REMOTE=true
denies 'cloud, CLAUDE_ATTENDED not 1' "$INPUT" CLAUDE_CODE_REMOTE=true CLAUDE_ATTENDED=0
denies 'cloud, CLAUDE_ATTENDED empty' "$INPUT" CLAUDE_CODE_REMOTE=true CLAUDE_ATTENDED=

# --- an attended cloud session and a local one: no output, so the prompt shows ----------------
silent 'cloud, CLAUDE_ATTENDED=1' "$INPUT" CLAUDE_CODE_REMOTE=true CLAUDE_ATTENDED=1
silent 'local' "$INPUT"
silent 'local, CLAUDE_CODE_REMOTE not true' "$INPUT" CLAUDE_CODE_REMOTE=false

# --- the decision doesn't depend on stdin ------------------------------------------------------
denies 'cloud, malformed stdin' '{"tool_name": "Bash", ' CLAUDE_CODE_REMOTE=true
denies 'cloud, empty stdin' '' CLAUDE_CODE_REMOTE=true
silent 'local, malformed stdin' 'not json'
silent 'cloud attended, malformed stdin' '{{' CLAUDE_CODE_REMOTE=true CLAUDE_ATTENDED=1

echo "deny-prompts-when-remote.test.sh: $pass passed, $fail failed"
((fail == 0))

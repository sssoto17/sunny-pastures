#!/usr/bin/env bash
# shellcheck disable=SC2088 # a literal `~` in a path is test input: the hook must see it unexpanded
# Tests for block-coordinator-work.sh, through its hook interface: PreToolUse JSON on stdin,
# exit 0 (allow) or 2 (deny, message on stderr). Run: bash .claude/hooks/block-coordinator-work.test.sh
set -uo pipefail

hook="$(dirname "$0")/block-coordinator-work.sh"
MAIN=/home/dev/sunny-pastures
WT=$MAIN/.claude/worktrees/75-coordinator-guard
export CLAUDE_PROJECT_DIR=$MAIN HOME=/home/dev
pass=0
fail=0

# JSON-encode a string the way the harness does (backslash, quote, newline, tab).
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

run_raw() { # json -> sets code, err
  err=$(timeout 5 bash "$hook" <<<"$1" 2>&1 >/dev/null)
  code=$?
}

expect() { # expected-code label [stderr-substring]
  if [[ $code -eq $1 && ( -z ${3:-} || $err == *"$3"* ) ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: expected exit %s, got %s\n  %s\n  stderr: %s\n' "$1" "$code" "$2" "$err"
  fi
}

file_tool() { # expected-code cwd tool path [stderr-substring]
  local key=file_path
  [[ $3 == NotebookEdit ]] && key=notebook_path
  run_raw "$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PreToolUse","tool_name":"%s","tool_input":{"%s":%s,"old_string":"a","new_string":"b"}}' \
    "$(json_str "$2")" "$3" "$key" "$(json_str "$4")")"
  expect "$1" "cwd: $2, $3 $4" "${5:-}"
}

bash_tool() { # expected-code cwd command [stderr-substring]
  run_raw "$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":%s,"description":"test"}}' \
    "$(json_str "$2")" "$(json_str "$3")")"
  expect "$1" "cwd: $2, command: $3" "${4:-}"
}

# --- file tools from the main folder ---------------------------------------------------------
file_tool 2 "$MAIN" Edit "$MAIN/docs/adr/0002-github-platform.md" 'brief'
file_tool 2 "$MAIN" Write "$MAIN/AGENTS.md"
file_tool 2 "$MAIN" MultiEdit "$MAIN/packages/sim/src/index.ts"
file_tool 2 "$MAIN" NotebookEdit "$MAIN/tools/analysis/load.ipynb"
file_tool 2 "$MAIN/docs" Edit "$MAIN/docs/spec.md"
file_tool 0 "$MAIN" Write "$MAIN/.scratch/brief-75.md"
file_tool 0 "$MAIN" Edit "$MAIN/.remember/remember.md"
file_tool 0 "$MAIN" Write /tmp/claude-1000/scratchpad/notes.md
file_tool 0 "$MAIN" Write /home/dev/.claude/projects/-home-dev-sunny-pastures/memory/x.md

# --- another session's worktree: the 7 Nov drift (#55) ---------------------------------------
file_tool 2 "$MAIN" Edit "$WT/docs/adr/0002-github-platform.md"
file_tool 2 "$MAIN" Write "$WT/.scratch/notes.md"
file_tool 2 "$MAIN" Edit .claude/worktrees/37-identity/docs/adr/0002-github-platform.md

# --- relative paths, `..`, `~` ----------------------------------------------------------------
file_tool 2 "$MAIN" Write docs/x.md
file_tool 2 "$MAIN" Write .scratch/../docs/x.md
file_tool 2 "$MAIN" Write "$MAIN/.scratch/../docs/x.md"
file_tool 2 "$MAIN" Write "$MAIN//docs/./x.md"
file_tool 2 "$MAIN/.scratch" Write ../AGENTS.md
file_tool 2 "$MAIN" Write "$MAIN"
file_tool 2 "$MAIN" Write "$MAIN/.scratchpad/x.md"
file_tool 2 "$MAIN" Write '~/sunny-pastures/docs/x.md'
file_tool 0 "$MAIN" Write .scratch/brief.md
file_tool 0 "$MAIN/docs" Write ../.scratch/brief.md
file_tool 0 "$MAIN" Write "$MAIN/docs/../.scratch/brief.md"
file_tool 0 "$MAIN" Write '~/.claude/projects/x/memory/MEMORY.md'
file_tool 0 "$MAIN" Write "$MAIN-other/docs/x.md"
file_tool 0 "$MAIN" Write '/home/dev/My Notes/sunny pastures.md'
# A cwd outside the repo is still the coordinating session: not a worktree.
file_tool 2 /tmp Write "$MAIN/docs/x.md"

# --- worktree sessions are unaffected ---------------------------------------------------------
file_tool 0 "$WT" Edit "$WT/docs/adr/0002-github-platform.md"
file_tool 0 "$WT/docs" Write "$WT/AGENTS.md"
file_tool 0 "$WT" NotebookEdit "$WT/tools/analysis/load.ipynb"
file_tool 0 "$WT" Write docs/x.md

# --- Bash: commits and PRs are lane work --------------------------------------------------------
bash_tool 2 "$MAIN" 'git commit -m "docs: x"' 'brief'
bash_tool 2 "$MAIN" 'git add docs/x.md && git commit -m x'
bash_tool 2 "$MAIN" 'git -c user.name=x commit --amend --no-edit'
bash_tool 2 "$MAIN" "git -C $WT commit -m x"
bash_tool 2 "$MAIN" '( cd .claude/worktrees/75-coordinator-guard && git commit -m x )'
bash_tool 2 "$MAIN" $'git commit -F - <<\'EOF\'\nfeat: x\nEOF'
bash_tool 2 "$MAIN" '/usr/bin/git commit -m x'
bash_tool 2 "$MAIN" "g'i't commit -m x"
bash_tool 2 "$MAIN/docs" 'git commit -m x'
bash_tool 2 "$MAIN" 'gh pr create --title t --body b --label review:admin' 'brief'
bash_tool 2 "$MAIN" 'gh pr new --fill'
bash_tool 2 "$MAIN" "( cd $WT && gh pr create --fill )"
bash_tool 2 "$MAIN" 'git fetch; gh pr create --head chore/75-x --fill'

# --- Bash: the coordinator keeps the board and reads freely ---------------------------------------
bash_tool 0 "$MAIN" 'gh issue create --title t --body b --label chore'
bash_tool 0 "$MAIN" 'gh issue edit 75 --add-label area:tools'
bash_tool 0 "$MAIN" 'gh project item-edit --id x --field-id y --single-select-option-id z'
bash_tool 0 "$MAIN" 'gh pr view 75 --json title'
bash_tool 0 "$MAIN" 'gh pr comment 120 --body "please git commit and gh pr create"'
bash_tool 0 "$MAIN" 'git log --oneline -- commit'
bash_tool 0 "$MAIN" 'git status && git diff --stat'
bash_tool 0 "$MAIN" 'git commit-graph verify'
bash_tool 0 "$MAIN" "git -C $WT log -1"
bash_tool 0 "$MAIN" 'grep -n "git commit" AGENTS.md # gh pr create'
bash_tool 0 "$MAIN" $'gh issue create --title t --body-file - <<\'EOF\'\nThen git commit and gh pr create.\nEOF'

# --- Bash: worktree sessions are unaffected ------------------------------------------------------
bash_tool 0 "$WT" 'git commit -m x'
bash_tool 0 "$WT" 'gh pr create --title t --body b --label review:admin'
bash_tool 0 "$WT/docs" 'git add x && git commit -m x && git push origin chore/75-x'

# --- hook input edge cases ------------------------------------------------------------------
bs=$'\x5c' # a backslash; typing the escape literally gets it decoded on the way into this file
run_raw "{ \"cwd\": \"$MAIN\", \"tool_name\": \"Write\", \"tool_input\": { \"file_path\": \"${bs}/home${bs}/dev${bs}/sunny-pastures${bs}/docs${bs}/x.md\" } }"
expect 2 'escaped slashes, spaced keys'
run_raw "{\"cwd\":\"$MAIN\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$MAIN/${bs}u002escratch/../docs/x.md\"}}"
expect 2 'unicode escape in the path'
run_raw "{\"cwd\":\"$MAIN\",\"tool_name\":\"Write\",\"tool_input\":{\"content\":\"x\\\",\\\"file_path\\\":\\\"$MAIN/.scratch/a\",\"file_path\":\"$MAIN/docs/x.md\"}}"
expect 2 'decoy key inside a string'
run_raw "{\"cwd\":\"$MAIN\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git fetch ${bs}u0026${bs}u0026 git commit -m x\"}}"
expect 2 'unicode-escaped &&'
run_raw "{\"cwd\":\"$MAIN\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$MAIN/docs/x.md\"}}"
expect 0 'Read is not an edit'
run_raw "{\"cwd\":\"$MAIN\",\"tool_name\":\"Write\",\"tool_input\":{}}"
expect 0 'no path'
run_raw "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$MAIN/docs/x.md\"}}"
expect 0 'no cwd'
run_raw 'not json'
expect 0 'malformed input'

big=$'gh issue create --title t --body-file - <<\'EOF\'\n'
for ((l = 0; l < 2000; l++)); do big+="line $l: \"quoted\" text; git commit -m nope && gh pr create"$'\n'; done
big+=$'EOF\ngit commit -m x'
start=$SECONDS
bash_tool 2 "$MAIN" "$big"
if ((SECONDS - start <= 3)); then pass=$((pass + 1)); else
  fail=$((fail + 1)); echo "FAIL: ${#big}-char command took $((SECONDS - start))s"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]

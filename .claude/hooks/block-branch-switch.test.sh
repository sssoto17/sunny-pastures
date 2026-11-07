#!/usr/bin/env bash
# shellcheck disable=SC2016 # test commands are single-quoted on purpose: the hook must see $HOME unexpanded
# Tests for block-branch-switch.sh, through its hook interface: PreToolUse JSON on stdin,
# exit 0 (allow) or 2 (deny, message on stderr). Run: bash .claude/hooks/block-branch-switch.test.sh
set -uo pipefail

hook="$(dirname "$0")/block-branch-switch.sh"
MAIN=/home/dev/sunny-pastures
WT=$MAIN/.claude/worktrees/16-branch-guard-hook
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

run_hook() { # cwd command -> sets code, err
  local input
  input=$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":%s,"description":"test"}}' \
    "$(json_str "$1")" "$(json_str "$2")")
  err=$(bash "$hook" <<<"$input" 2>&1 >/dev/null)
  code=$?
}

check() { # expected-code cwd command [stderr-substring]
  run_hook "$2" "$3"
  if [[ $code -eq $1 && ( -z ${4:-} || $err == *"$4"* ) ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: expected exit %s, got %s\n  cwd: %s\n  command: %s\n  stderr: %s\n' \
      "$1" "$code" "$2" "$3" "$err"
  fi
}
deny() { check 2 "$@"; }
allow() { check 0 "$@"; }

# --- git switch -----------------------------------------------------------------------------
deny "$MAIN" 'git switch feature' 'git -C'
deny "$MAIN/docs" 'git switch -c feature'
allow "$WT" 'git switch feature'
allow "$WT/docs" 'git switch -c feature'
allow "$MAIN" 'git status'

# --- git checkout ---------------------------------------------------------------------------
deny "$MAIN" 'git checkout feature' 'git checkout -- <path>'
deny "$MAIN" 'git checkout -b feature'
deny "$MAIN" 'git checkout -B feature origin/feature'
deny "$MAIN" 'git checkout --orphan gh-pages'
deny "$MAIN" 'git checkout --detach'
deny "$MAIN" 'git checkout -'
allow "$MAIN" 'git checkout -- docs/spec.md'
allow "$MAIN" 'git checkout main -- docs/spec.md'
allow "$MAIN" 'git checkout'
allow "$WT" 'git checkout -b feature'
allow "$WT" 'git checkout -- docs/spec.md'

# --- git global options ---------------------------------------------------------------------
deny "$MAIN" 'git -c core.pager=cat checkout feature'
deny "$MAIN" 'git --no-pager switch feature'
deny "$MAIN" 'git -C . checkout feature'
allow "$MAIN" "git -C $WT checkout -b feature"
allow "$MAIN" 'git -C .claude/worktrees/16-branch-guard-hook switch feature'
allow "$MAIN" 'git worktree add .claude/worktrees/16-x -b chore/16-x main'
allow "$MAIN" 'git log --oneline -- checkout'

# --- chained commands -----------------------------------------------------------------------
deny "$MAIN" 'git fetch && git checkout feature'
deny "$MAIN" 'git fetch; git switch feature'
deny "$MAIN" 'git fetch || git switch feature'
deny "$MAIN" 'git stash list & git switch feature'
deny "$MAIN" $'git fetch\ngit switch feature'
deny "$MAIN" 'git checkout feature 2>&1 | tail -3'
deny "$MAIN" 'git status 2>&1 && git switch feature'
deny "$MAIN" 'cd docs && git checkout feature'
deny "$MAIN" 'cd /home/dev/sunny-pastures && git switch feature'
deny "$MAIN" 'GIT_TRACE=1 git checkout feature'
deny "$MAIN" 'git checkout "feature"'
deny "$MAIN" '{ git switch feature; }'
allow "$MAIN" 'git fetch && git status; git log | head'

# --- quoted text and heredocs are not commands ----------------------------------------------
allow "$MAIN" 'git commit -m "deny git checkout <branch>; git switch too"'
allow "$MAIN" "git commit -m 'feat: x' -m 'and git switch; git checkout -b y'"
allow "$MAIN" $'git commit -F - <<\'EOF\'\nfeat: guard\n\ngit checkout feature\nEOF\ngit log -1'
allow "$MAIN" $'gh pr create --title t --body "$(cat <<\'EOF\'\n## Summary\n- denies `git switch x`; and cd .claude/worktrees/x\nEOF\n)"'
allow "$MAIN" 'grep -n "git checkout" AGENTS.md # git switch feature'
allow "$MAIN" 'echo git\ checkout feature'
deny "$MAIN" $'cat <<EOF > notes.txt\ngit switch x\nEOF\ngit switch feature'

# --- cd/pushd into a worktree (7 Nov comment) -----------------------------------------------
deny "$MAIN" 'cd .claude/worktrees/16-branch-guard-hook' 'subshell'
deny "$MAIN" "cd $WT"
deny "$MAIN" 'cd .claude/worktrees'
deny "$MAIN/docs" 'cd ../.claude/worktrees/16-branch-guard-hook'
deny "$MAIN" 'cd .claude/worktrees/16-branch-guard-hook && pnpm test'
deny "$MAIN" 'git fetch; cd -P "$HOME/x/.claude/worktrees/16-y" && ls'
deny "$MAIN" 'pushd .claude/worktrees/16-branch-guard-hook'
deny "$MAIN" '{ cd .claude/worktrees/16-x; }'
allow "$MAIN" '( cd .claude/worktrees/16-branch-guard-hook && pnpm test )'
allow "$MAIN" "(cd $WT && git status)"
allow "$MAIN" 'cd docs && ls'
allow "$MAIN" 'cd /tmp'
allow "$MAIN" 'ls .claude/worktrees/16-branch-guard-hook'
allow "$WT" 'cd ../16-other-worktree && git status'
allow "$WT" "cd $WT/docs"

# --- a subshell's cd decides where its git runs ---------------------------------------------
allow "$MAIN" '( cd .claude/worktrees/16-x && git checkout -b chore/16-x )'
deny "$MAIN" '( cd .claude/worktrees/16-x; git switch feature )' # cd may have failed
deny "$MAIN" '( cd docs && git checkout feature )'
deny "$MAIN" '( cd .claude/worktrees/16-x ) && git switch feature'
deny "$MAIN" '( cd .claude/worktrees/16-x && ls ); git checkout feature'
deny "$MAIN" '( ( cd .claude/worktrees/16-x ) && git switch feature )'

# --- security review of 7 Nov: accidental near-misses ----------------------------------------
deny "$MAIN" 'git checkout feature --'
deny "$MAIN" 'git -C .claude/worktrees/16-x/../.. checkout feature'
deny "$MAIN" '/usr/bin/git switch feature'
deny "$MAIN" '( cd .claude/worktrees/16-x && cd .. && git checkout feature )'
deny "$MAIN" '( cd .claude/worktrees/16-x && cd /home/dev/sunny-pastures && git switch feature )'
deny "$MAIN" '( cd .claude/worktrees/16-x; cd; git switch feature )'
allow "$MAIN" '( cd .claude/worktrees/16-x && cd docs && git checkout -b feature )'

deny "$MAIN" '( cd .claude/worktrees/16-x/../.. && git switch feature )'
deny "$MAIN" '( cd .claude/worktrees && git switch feature )'
deny "$MAIN" '( pushd .claude/worktrees/16-x && popd && git switch feature )'
deny "$MAIN" '( cd .claude/worktrees/16-x && pushd +1 && git switch feature )'
deny "$MAIN" '( cd .claude/worktrees/16-x && cd `echo /` && git switch feature )'
allow "$MAIN" '( pushd .claude/worktrees/16-x && git switch feature )'

deny "$MAIN" '( pushd -n .claude/worktrees/16-x && git switch feature )'
deny "$MAIN" '( cd .claude/worktrees/. && git switch feature )'
deny "$MAIN" '( cd .claude/worktrees/16-typo || git switch feature )'
deny "$MAIN" '( cd .claude/worktrees/16-x && git status; git switch feature )'
deny "$MAIN" $'( cd .claude/worktrees/16-x\ngit switch feature )'
allow "$MAIN" '( cd .claude/worktrees/16-x && git status && git switch feature )'
allow "$MAIN" '( cd .claude/worktrees/16-x && ( cd docs; git switch feature ) )'

deny "$MAIN" '( ! cd .claude/worktrees/16-x && git switch feature )'
deny "$MAIN" '( true || cd .claude/worktrees/16-x && git switch feature )'
deny "$MAIN" '( git fetch || true && cd .claude/worktrees/16-x && git switch feature )'
allow "$MAIN" '( git fetch || true; cd .claude/worktrees/16-x && git switch feature )'

# --- hook input edge cases ------------------------------------------------------------------
check_raw() { # expected-code raw-json label
  err=$(bash "$hook" <<<"$2" 2>&1 >/dev/null)
  code=$?
  if [[ $code -eq $1 ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    printf 'FAIL: expected exit %s, got %s (%s)\n  stderr: %s\n' "$1" "$code" "$3" "$err"
  fi
}
check_raw 2 '{ "cwd": "/home/dev/sunny-pastures", "tool_input": { "command": "git fetch && git switch x" } }' 'unicode escapes, spaced keys'
check_raw 0 '{"cwd":"/home/dev/sunny-pastures","tool_input":{"description":"x\",\"command\":\"git switch y","command":"git status"}}' 'decoy key inside a string'
check_raw 0 '{"cwd":"/home/dev/sunny-pastures","tool_name":"Bash","tool_input":{}}' 'no command'
check_raw 0 'not json' 'malformed input'

big=$'git commit -F - <<\'EOF\'\n'
for ((l = 0; l < 2000; l++)); do big+="line $l: \"quoted\" text; git checkout -b nope && cd .claude/worktrees/x"$'\n'; done
big+=$'EOF\ngit switch feature'
start=$SECONDS
deny "$MAIN" "$big"
if ((SECONDS - start <= 3)); then pass=$((pass + 1)); else
  fail=$((fail + 1)); echo "FAIL: ${#big}-char command took $((SECONDS - start))s"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]

#!/usr/bin/env bash
# Tests for fallow-gate.sh (#504), through its hook interface: PreToolUse JSON on stdin, exit 0
# (allow) or 2 (block, findings on stderr). The script is Fallow's own (`fallow hooks install
# --target agent`), so these tests pin what this repo relies on, not its internals: which commands
# it audits, that a `fail` verdict blocks with the finding listed, that `pass`, `warn` and a broken
# audit let the command through, and how .claude/settings.json registers it. A throwaway git repo
# stands in for the work tree, with a copy of the gate in its .claude/hooks/; the `fallow` first on
# PATH is a fake that logs its arguments and prints the report the test chose. The real audit is
# shown in #504's PR. Run: bash .claude/hooks/fallow-gate.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
gate="$here/fallow-gate.sh"
settings="$here/../settings.json"
pass=0
fail=0

tmp=$(mktemp -d "${TMPDIR:-/tmp}/fallow-gate-test.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
bin="$tmp/bin"
log="$tmp/log"
mkdir -p "$repo/.claude/hooks" "$bin"
git -c init.defaultBranch=main init -q "$repo"
repo=$(cd "$repo" && git rev-parse --show-toplevel) # the path git reports, symlinks resolved
cp "$gate" "$repo/.claude/hooks/fallow-gate.sh"

# The fake fallow: prints a version, refuses the gate's native JSON reader (so the gate reads the
# report with jq, as it does without a fallow that speaks its protocol), and answers `audit` with
# $tmp/report.json and the exit code in $tmp/status.
cat >"$bin/fallow" <<EOF
#!/usr/bin/env bash
case "\$1" in
  --version) echo "fallow 3.43.1" ;;
  audit) echo "audit \$* (in \$(pwd -P))" >>"$log"; cat "$tmp/report.json"; exit "\$(cat "$tmp/status")" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$bin/fallow"
export PATH="$bin:$PATH"
unset FALLOW_GATE_OUTPUT FALLOW_GATE_REPORT FALLOW_GATE_MIN_VERSION FALLOW_GATE_DEBUG

report() { # status json
  printf '%s' "$1" >"$tmp/status"
  printf '%s' "$2" >"$tmp/report.json"
}
# A new clone group, as `fallow audit --format json` reports one (trimmed).
clone='{"verdict":"fail","attribution":{"gate":"new-only"},"duplication":{"clone_groups":[{"instances":[{"file":"packages/sim/src/pens/index.ts","start_line":96},{"file":"packages/sim/src/pens/index.ts","start_line":231}],"actions":[{"type":"extract-shared"}],"introduced":true}]}}'
clean='{"verdict":"pass","attribution":{"gate":"new-only"}}'
warned='{"verdict":"warn","attribution":{"gate":"new-only"}}'
broken='{"error":true,"message":"cannot resolve base ref"}'

json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

run() { # hook-command shell-command -> sets code, err
  local input
  input=$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":%s}}' \
    "$(json_str "$repo")" "$(json_str "$2")")
  : >"$log"
  err=$(cd "$repo" && timeout 20 bash -c "$1" <<<"$input" 2>&1 >/dev/null)
  code=$?
}

check() { # name expected-code shell-command [stderr-substring] [hook-command]
  run "${5:-./.claude/hooks/fallow-gate.sh}" "$3"
  if [[ $code -eq $2 && (-z ${4:-} || $err == *"$4"*) ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: %s: expected exit %s, got %s\n  command: %s\n  stderr: %s\n' "$1" "$2" "$code" "$3" "$err"
  fi
}

audited() { # name -> passes when the last run called `fallow audit` with the gate's flags
  if grep -q -- 'audit audit --format json --quiet --explain --gate-marker agent' "$log"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: %s: fallow audit not run as the gate runs it\n  log: %s\n' "$1" "$(cat "$log")"
  fi
}

not_audited() { # name
  if [[ ! -s $log ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: %s: fallow audit ran\n  log: %s\n' "$1" "$(cat "$log")"
  fi
}

# --- a new finding blocks a commit or a push, and names the finding ---------------------------
report 1 "$clone"
check 'commit with a new clone' 2 'git commit -m "feat(sim): feed again"' \
  'duplication packages/sim/src/pens/index.ts:96'
audited 'commit with a new clone'
check 'block names the verdict' 2 'git commit -am x' 'verdict fail, 1 finding(s) caused the block'
check 'push with a new clone' 2 'git push -u origin claude/x'
check 'commit after cd and &&' 2 "cd $repo && git add -A && git commit -m x"
check 'commit with git options' 2 'git -c core.editor=true commit --amend --no-edit'

# --- other commands never run the audit --------------------------------------------------------
check 'not git' 0 'ls -la'
not_audited 'not git'
check 'git read with a commit-like word' 0 'git log --grep commit'
not_audited 'git read with a commit-like word'
check 'git status' 0 'git status --short'
not_audited 'git status'

# --- pass and warn let the command through; so does an audit that can't run -------------------
report 0 "$clean"
check 'clean commit' 0 'git commit -m "docs: a line"'
audited 'clean commit'
report 0 "$warned"
check 'warn verdict' 0 'git commit -m x'
report 2 "$broken"
check 'audit runtime error fails open' 0 'git commit -m x' \
  'fallow audit runtime error (cannot resolve base ref), skipping'

# --- the registration in .claude/settings.json -------------------------------------------------
# It sits in the PreToolUse Bash group beside block-branch-switch.sh, so both run on every command.
# Its timeout is ours: `fallow hooks install` drops it, so a reinstall shows up here.
entry=$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[]
  | select(.command | contains("fallow-gate.sh"))]' "$settings")
if [[ $(jq length <<<"$entry") == 1 && $(jq '.[0].timeout' <<<"$entry") == 120 ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  printf 'FAIL: settings.json: want one fallow-gate.sh entry with timeout 120 in the Bash group, got %s\n' "$entry"
fi
others=$(jq -r '[.hooks.PreToolUse[].hooks[].command] | join("\n")' "$settings")
for h in block-branch-switch.sh block-thread-resolve.sh block-coordinator-work.sh; do
  if [[ $others == *"$h"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: settings.json: %s is no longer registered\n' "$h"
  fi
done

# The registered command finds the gate from the session's directory (a lane's worktree has its
# own copy), so run it as written, from a folder inside the throwaway repo.
registered=$(jq -r '.[0].command' <<<"$entry")
mkdir -p "$repo/packages/sim"
report 1 "$clone"
input=$(printf '{"session_id":"t","cwd":%s,"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' \
  "$(json_str "$repo/packages/sim")")
: >"$log"
err=$(cd "$repo/packages/sim" && CLAUDE_PROJECT_DIR=/nonexistent timeout 20 bash -c "$registered" <<<"$input" 2>&1 >/dev/null)
code=$?
if [[ $code -eq 2 && $err == *'duplication packages/sim/src/pens/index.ts:96'* ]] && grep -q "(in $repo)" "$log"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  printf 'FAIL: registered command: expected exit 2 from the repo root, got %s\n  stderr: %s\n  log: %s\n' \
    "$code" "$err" "$(cat "$log")"
fi

echo "fallow-gate.test.sh: $pass passed, $fail failed"
((fail == 0))

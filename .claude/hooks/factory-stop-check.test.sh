#!/usr/bin/env bash
# Tests for factory-stop-check.mjs, through its hook interface: Stop JSON on stdin, the factory's
# environment, a fixture repo as the working directory; on stdout either the block decision or
# nothing (#705, check 7). The first fixture is run 45928803367 (#605, 27 Nov): the chained
# `git switch -c 605-…; git commit` was denied by the Fallow gate, so the branch was never made and
# the commits landed on main, yet the turn ended `FACTORY ready: 605-chicken-pen-feed-eggs`.
# Run: bash .claude/hooks/factory-stop-check.test.sh
set -uo pipefail

hook="$(cd "$(dirname "$0")" && pwd)/factory-stop-check.mjs"
pass=0
fail=0
# Set in cloud sessions and Actions; each case sets its own.
unset CLAUDE_CODE_REMOTE GITHUB_ACTIONS GITHUB_WORKFLOW FACTORY_RUN
work=$(mktemp -d "${TMPDIR:-/tmp}/factory-stop-check.XXXXXX")
trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

BRANCH=605-chicken-pen-feed-eggs
FACTORY_ENV=(GITHUB_ACTIONS=true GITHUB_WORKFLOW=factory) # today's factory.yml
ROUTINE_ENV=(CLAUDE_CODE_REMOTE=true FACTORY_RUN=1)       # the routine's environment (#705)

# A clone whose main matches origin/main, with one commit on it. Prints the clone's path.
fixture() { # name
  local d=$work/$1
  git init -q --bare -b main "$d.git"
  git clone -q "$d.git" "$d" 2>/dev/null
  git -C "$d" commit -q --allow-empty -m init
  git -C "$d" push -q origin main 2>/dev/null
  printf '%s' "$d"
}

commit_file() { # repo file
  printf 'x\n' >"$1/$2"
  git -C "$1" add "$2"
  git -C "$1" commit -q -m "feat(web): $2 (#605)"
}

# Each input gets its own session id, so the hook's per-session refusal count starts at 0, unless
# a case passes one (the loop bound's cases).
stop_input() { # cwd message [transcript] [session]
  jq -cn --arg cwd "$1" --arg msg "$2" --arg tr "${3:-}" --arg sid "${4:-t$RANDOM$RANDOM}" \
    '{session_id: $sid, transcript_path: $tr, cwd: $cwd, permission_mode: "default",
      hook_event_name: "Stop", stop_hook_active: false}
     + (if $msg == "" then {} else {last_assistant_message: $msg} end)'
}

run_hook() { # dir stdin env-assignments... -> sets code, out
  local dir=$1 input=$2
  shift 2
  out=$(cd "$dir" && env TMPDIR="$work/state" "$@" timeout 10 node "$hook" <<<"$input" 2>/dev/null)
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

blocks() { # name dir stdin pattern env-assignments...: blocks with a reason matching pattern
  local name=$1 dir=$2 input=$3 pattern=$4
  shift 4
  run_hook "$dir" "$input" "$@"
  local ok
  ok=$(jq -r --arg p "$pattern" '.decision == "block" and (.reason | test($p))' <<<"$out" 2>/dev/null)
  [[ $code -eq 0 && $ok == true ]] && record "$name" ok || record "$name" no
}

silent() { # name dir stdin env-assignments...
  local name=$1 dir=$2 input=$3
  shift 3
  run_hook "$dir" "$input" "$@"
  [[ $code -eq 0 && -z $out ]] && record "$name" ok || record "$name" no
}

READY="The hand-off files (\`branch\`, \`pr-body.md\`, \`labels\`) are in \`../factory-out\`.

FACTORY ready: $BRANCH"

# --- the #605 fixture: the branch was never made, two commits landed on main --------------------
r605=$(fixture r605)
commit_file "$r605" pens.tsx
commit_file "$r605" plots.tsx
# The transcript holds the denied chained command, as the run's TURNS lines show it. The hook
# decides on the git state alone; the transcript is read only for the final message.
tr605=$work/r605.jsonl
jq -cn --arg b "$BRANCH" '{type: "assistant", message: {role: "assistant", content: [{type: "tool_use",
  id: "toolu_1", name: "Bash", input: {command: ("pnpm boundaries; git switch -c " + $b + "; git commit -qm \"feat(web): chicken pen (#605)\"")}}]}}' >"$tr605"
jq -cn '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: "toolu_1", is_error: true,
  content: "PreToolUse:Bash hook error: fallow-gate: verdict fail, 1 finding(s) caused the block"}]}}' >>"$tr605"
jq -cn --arg m "$READY" '{type: "assistant", message: {role: "assistant", content: [{type: "text", text: $m}]}}' >>"$tr605"

blocks '#605: missing branch, in factory.yml' "$r605" "$(stop_input "$r605" "$READY" "$tr605")" \
  "branch $BRANCH doesn't exist" "${FACTORY_ENV[@]}"
blocks '#605: the reason names where the commits went' "$r605" "$(stop_input "$r605" "$READY" "$tr605")" \
  'HEAD is main, 2 commits past origin/main' "${FACTORY_ENV[@]}"
blocks '#605: the reason offers the stop line' "$r605" "$(stop_input "$r605" "$READY" "$tr605")" \
  'FACTORY stopped: <reason>' "${FACTORY_ENV[@]}"
blocks '#605: in the routine' "$r605" "$(stop_input "$r605" "$READY" "$tr605")" \
  "branch $BRANCH doesn't exist" "${ROUTINE_ENV[@]}"
blocks '#605: final message read from the transcript when the input lacks it' "$r605" \
  "$(stop_input "$r605" "" "$tr605")" "branch $BRANCH doesn't exist" "${FACTORY_ENV[@]}"

# --- the loop bound: 3 refusals per session, then the turn may end, with a warning ---------------
loop_input=$(stop_input "$r605" "$READY" "" loop1)
for i in 1 2 3; do
  blocks "#605: refusal $i of 3 in one session" "$r605" "$loop_input" "branch $BRANCH doesn't exist" "${FACTORY_ENV[@]}"
done
run_hook "$r605" "$loop_input" "${FACTORY_ENV[@]}"
ok4=$(jq -r 'has("decision") | not' <<<"$out" 2>/dev/null)
warn4=$(jq -r '.systemMessage | test("refused this FACTORY ready 3 times") and test("doesn.t exist")' <<<"$out" 2>/dev/null)
[[ $code -eq 0 && $ok4 == true && $warn4 == true ]] && record '#605: the 4th claim ends the turn with a warning' ok ||
  record '#605: the 4th claim ends the turn with a warning' no
blocks '#605: another session starts its own count' "$r605" "$(stop_input "$r605" "$READY" "" loop2)" \
  "branch $BRANCH doesn't exist" "${FACTORY_ENV[@]}"
blocks '#605: a session id it cannot use as a file name still refuses' "$r605" \
  "$(stop_input "$r605" "$READY" "" '../x')" "branch $BRANCH doesn't exist" "${FACTORY_ENV[@]}"

# --- the passing case: the branch exists, has commits past origin/main, the tree is clean -------
ok=$(fixture ok)
git -C "$ok" switch -q -c "$BRANCH"
commit_file "$ok" pens.tsx
silent 'branch with commits, clean tree' "$ok" "$(stop_input "$ok" "$READY")" "${FACTORY_ENV[@]}"
silent 'same, in the routine' "$ok" "$(stop_input "$ok" "$READY")" "${ROUTINE_ENV[@]}"
git -C "$ok" switch -q main
silent 'same, with HEAD back on main' "$ok" "$(stop_input "$ok" "$READY")" "${FACTORY_ENV[@]}"

# --- each failing condition on its own -----------------------------------------------------------
empty=$(fixture empty)
git -C "$empty" branch "$BRANCH"
blocks 'branch with no commits past origin/main' "$empty" "$(stop_input "$empty" "$READY")" \
  "branch $BRANCH has no commits beyond origin/main" "${FACTORY_ENV[@]}"

dirty=$(fixture dirty)
git -C "$dirty" switch -q -c "$BRANCH"
commit_file "$dirty" pens.tsx
printf 'y\n' >>"$dirty/pens.tsx"
printf 'z\n' >"$dirty/untracked.ts"
blocks 'uncommitted and untracked changes' "$dirty" "$(stop_input "$dirty" "$READY")" \
  'the tree is not clean: 2 paths.*pens.tsx' "${FACTORY_ENV[@]}"

noorigin=$(fixture noorigin)
git -C "$noorigin" switch -q -c "$BRANCH"
commit_file "$noorigin" pens.tsx
git -C "$noorigin" update-ref -d refs/remotes/origin/main
blocks 'no origin/main to compare with' "$noorigin" "$(stop_input "$noorigin" "$READY")" \
  'origin/main is missing' "${FACTORY_ENV[@]}"

blocks 'FACTORY ready with no branch name' "$ok" "$(stop_input "$ok" 'FACTORY ready')" \
  'names no branch' "${FACTORY_ENV[@]}"
blocks 'a branch name git would refuse' "$ok" "$(stop_input "$ok" 'FACTORY ready: a..b')" \
  'names no branch' "${FACTORY_ENV[@]}"
blocks 'main named as the branch, though it holds the commits (#605)' "$r605" "$(stop_input "$r605" 'FACTORY ready: main')" \
  'names no branch' "${FACTORY_ENV[@]}"
blocks 'a branch name without the issue number' "$ok" "$(stop_input "$ok" 'FACTORY ready: chicken-pen')" \
  'names no branch' "${FACTORY_ENV[@]}"
blocks 'a branch name that looks like an option' "$ok" "$(stop_input "$ok" 'FACTORY ready: --all')" \
  'names no branch' "${FACTORY_ENV[@]}"
blocks 'the last FACTORY line counts, as factory.yml reads it' "$r605" \
  "$(stop_input "$r605" "FACTORY stopped: earlier draft
FACTORY ready: $BRANCH
Thanks.")" "branch $BRANCH doesn't exist" "${FACTORY_ENV[@]}"

# --- not a claim: no output ----------------------------------------------------------------------
silent 'FACTORY stopped' "$r605" "$(stop_input "$r605" 'FACTORY stopped: the Fallow gate refused the commit three times')" "${FACTORY_ENV[@]}"
silent 'FACTORY fixed (fix mode)' "$r605" "$(stop_input "$r605" 'FACTORY fixed: PR #700')" "${FACTORY_ENV[@]}"
silent 'no FACTORY line' "$r605" "$(stop_input "$r605" 'Done.')" "${FACTORY_ENV[@]}"
silent 'an earlier ready overridden by a later stopped' "$r605" \
  "$(stop_input "$r605" "FACTORY ready: $BRANCH
FACTORY stopped: changed my mind")" "${FACTORY_ENV[@]}"
silent 'ready mentioned mid-line, not at a line start' "$r605" \
  "$(stop_input "$r605" "I would write FACTORY ready: $BRANCH here.")" "${FACTORY_ENV[@]}"

# --- outside a factory run: untouched, whatever the message says --------------------------------
silent 'local lane' "$r605" "$(stop_input "$r605" "$READY")"
silent 'cloud lane' "$r605" "$(stop_input "$r605" "$READY")" CLAUDE_CODE_REMOTE=true
silent 'another workflow (review.yml)' "$r605" "$(stop_input "$r605" "$READY")" GITHUB_ACTIONS=true GITHUB_WORKFLOW=review
silent 'a workflow named factory outside Actions' "$r605" "$(stop_input "$r605" "$READY")" GITHUB_WORKFLOW=factory
silent 'FACTORY_RUN other than 1' "$r605" "$(stop_input "$r605" "$READY")" CLAUDE_CODE_REMOTE=true FACTORY_RUN=true

# --- input it can't read, or no repo: no output (fails open, like the other hooks) -------------
silent 'malformed stdin' "$r605" '{"hook_event_name": "Stop", ' "${FACTORY_ENV[@]}"
silent 'empty stdin' "$r605" '' "${FACTORY_ENV[@]}"
mkdir "$work/plain"
silent 'a folder that is not a git work tree' "$work/plain" "$(stop_input "$work/plain" "$READY")" "${FACTORY_ENV[@]}"

echo "factory-stop-check.test.sh: $pass passed, $fail failed"
((fail == 0))

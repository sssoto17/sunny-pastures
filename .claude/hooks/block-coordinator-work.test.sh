#!/usr/bin/env bash
# shellcheck disable=SC2088,SC2016 # `~`, `$HOME` and backticks are test input: the hook must see them unexpanded
# Tests for block-coordinator-work.sh, through its hook interface: PreToolUse JSON on stdin,
# exit 0 (allow) or 2 (deny, message on stderr). Run: bash .claude/hooks/block-coordinator-work.test.sh
set -uo pipefail

hook="$(dirname "$0")/block-coordinator-work.sh"
MAIN=/home/dev/sunny-pastures
WT=$MAIN/.claude/worktrees/75-coordinator-guard
export CLAUDE_PROJECT_DIR=$MAIN HOME=/home/dev
unset CLAUDE_CODE_REMOTE GITHUB_ACTIONS # set in cloud sessions and CI; tested below
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
# the App's route opens PRs too (#336): the script, a stack's open or add, and the dispatch itself
bash_tool 2 "$MAIN" 'scripts/open-pr.sh --label review:admin 336-x .scratch/body.md'
bash_tool 2 "$MAIN" 'bash scripts/open-pr.sh 336-x body.md'
bash_tool 2 "$MAIN" 'scripts/stack.sh open 336-a=a.md 336-b=b.md'
bash_tool 2 "$MAIN" 'bash ./scripts/stack.sh add 401 336-c=c.md'
bash_tool 2 "$MAIN" 'gh api -X POST repos/sssoto17/sunny-pastures/dispatches --input - <req.json'
bash_tool 0 "$MAIN" 'scripts/stack.sh status 401'
bash_tool 0 "$MAIN" 'bash scripts/open-pr.sh --help'
bash_tool 2 "$MAIN" "( cd $WT && gh pr create --fill )"
bash_tool 2 "$MAIN" 'git fetch; gh pr create --head chore/75-x --fill'
# gh takes the repo flag before the command too (spec review of #75)
bash_tool 2 "$MAIN" 'gh -R sssoto17/sunny-pastures pr create --fill'
bash_tool 2 "$MAIN" 'gh --repo sssoto17/sunny-pastures pr create --fill'
bash_tool 2 "$MAIN" 'gh --repo=sssoto17/sunny-pastures pr new --fill'
bash_tool 0 "$MAIN" 'gh -R sssoto17/sunny-pastures issue create --title t --body b'
bash_tool 0 "$MAIN" 'gh -R sssoto17/sunny-pastures pr view 75'

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

# --- Bash writes to repo files: independent review of #115 ---------------------------------------
# Output redirects
bash_tool 2 "$MAIN" 'echo x > docs/x.md' 'docs/x.md'
bash_tool 2 "$MAIN" 'echo x >> AGENTS.md'
bash_tool 2 "$MAIN" 'printf x >| docs/x.md'
bash_tool 2 "$MAIN" 'ls &> docs/ls.txt'
bash_tool 2 "$MAIN" 'ls &>> docs/ls.txt'
bash_tool 2 "$MAIN" 'make 2> docs/err.log'
bash_tool 2 "$MAIN" 'ls >& docs/ls.txt'
bash_tool 2 "$MAIN" '> docs/x.md'
bash_tool 2 "$MAIN" '{ echo a; echo b; } > docs/x.md'
bash_tool 2 "$MAIN" '( echo a ) > docs/x.md'
bash_tool 2 "$MAIN" $'cat > docs/x.md <<\'EOF\'\nhello\nEOF'
bash_tool 2 "$MAIN" "echo x > $MAIN/docs/x.md"
bash_tool 2 "$MAIN" 'echo x > "docs/a b.md"'
bash_tool 2 "$MAIN" 'echo x > ~/sunny-pastures/docs/x.md'
bash_tool 2 "$MAIN" 'echo x > "$HOME/sunny-pastures/docs/x.md"'
bash_tool 2 "$MAIN" 'echo x > .scratch/../docs/x.md'
bash_tool 2 "$MAIN" 'echo x > "$CLAUDE_PROJECT_DIR/docs/x.md"' # security review of 8fa6f96
bash_tool 2 "$MAIN" 'echo x > ${CLAUDE_PROJECT_DIR}/AGENTS.md'
bash_tool 2 "$MAIN/docs" "sed -i s/a/b/ \"\$PWD/x.md\""
bash_tool 0 "$MAIN" 'echo x > "$CLAUDE_PROJECT_DIR/.scratch/x.md"'
bash_tool 0 "$MAIN" 'echo x > "$PWD/.scratch/x.md"'
bash_tool 2 "$MAIN/docs" 'echo x > x.md'
bash_tool 2 "$MAIN" 'cd docs && echo x > x.md'
bash_tool 2 "$MAIN" '( cd .claude/worktrees/16-x && echo x > docs/x.md )'
bash_tool 2 "$MAIN" "echo x > $WT/docs/x.md"
bash_tool 2 "$MAIN" 'git log | grep x > docs/x.md'
# tee, sed -i, perl -i
bash_tool 2 "$MAIN" 'echo x | tee docs/x.md'
bash_tool 2 "$MAIN" 'echo x | tee -a .scratch/log docs/x.md'
bash_tool 2 "$MAIN" "sed -i 's/a/b/' docs/x.md" '`sed -i`'
bash_tool 2 "$MAIN" "sed -i.bak 's/a/b/' docs/x.md"
bash_tool 2 "$MAIN" "sed -Ei 's/a/b/' docs/x.md"
bash_tool 2 "$MAIN" "sed -e 's/a/b/' -i docs/x.md"
bash_tool 2 "$MAIN" "sed --in-place=.bak -e 's/a/b/' AGENTS.md"
bash_tool 2 "$MAIN" "sed -i -e 's/a/b/' .scratch/x.md docs/x.md"
bash_tool 2 "$MAIN" "perl -pi -e 's/a/b/' docs/x.md"
bash_tool 2 "$MAIN" "perl -i.bak -pe 's/a/b/' docs/x.md"
bash_tool 2 "$MAIN" "perl -0777 -i -pe 's/a/b/g' AGENTS.md"
# cp, mv, install, ln, rm, touch, truncate
bash_tool 2 "$MAIN" 'cp .scratch/x.md docs/x.md'
bash_tool 2 "$MAIN" 'cp -r .scratch/dir docs/'
bash_tool 2 "$MAIN" 'cp -t docs .scratch/x.md'
bash_tool 2 "$MAIN" 'cp --target-directory=docs .scratch/x.md'
bash_tool 2 "$MAIN" 'mv .scratch/x.md docs/x.md'
bash_tool 2 "$MAIN" 'mv docs/x.md .scratch/x.md' # the source is removed
bash_tool 2 "$MAIN" 'install -m 644 .scratch/x.md docs/x.md'
bash_tool 2 "$MAIN" 'ln -s ../AGENTS.md docs/x.md'
bash_tool 2 "$MAIN" 'ln -sf /etc/hosts docs/hosts'
bash_tool 2 "$MAIN" 'rm docs/x.md'
bash_tool 2 "$MAIN" 'rm -rf packages/sim'
bash_tool 2 "$MAIN" 'rm -rf .claude/worktrees/16-x/docs'
bash_tool 2 "$MAIN" 'rm -rf .claude/worktrees'
bash_tool 2 "$MAIN" 'touch docs/x.md'
bash_tool 2 "$MAIN" 'truncate -s 0 docs/x.md'
# git apply and patch
bash_tool 2 "$MAIN" 'git apply .scratch/fix.patch' '`git apply`'
bash_tool 2 "$MAIN" 'git apply --stat --apply .scratch/fix.patch'
bash_tool 2 "$MAIN" "git -C $WT apply .scratch/fix.patch"
bash_tool 2 "$MAIN" 'patch -p1 < .scratch/fix.patch'
bash_tool 2 "$MAIN" 'patch docs/x.md .scratch/fix.patch'
bash_tool 2 "$MAIN" "patch -d $WT -p1 -i .scratch/fix.patch"

# The coordinator's own writes from the main folder keep working
bash_tool 0 "$MAIN" 'git status > /dev/null'
bash_tool 0 "$MAIN" 'git fetch 2>/dev/null'
bash_tool 0 "$MAIN" 'pnpm db:status &> /dev/null'
bash_tool 0 "$MAIN" 'echo oops >&2'
bash_tool 0 "$MAIN" 'echo oops 1>&2'
bash_tool 0 "$MAIN" 'git log 2>&1 | tail -3'
bash_tool 0 "$MAIN" 'exec 3>&-'
bash_tool 0 "$MAIN" 'gh pr view 115 --json body > "$TMPDIR/pr.json"'
bash_tool 0 "$MAIN" 'gh pr view 115 > $TMPDIR/pr.txt'
bash_tool 0 "$MAIN" 'gh pr diff 115 > "${TMPDIR:-/tmp}/115.diff"'
bash_tool 0 "$MAIN" 'echo x > /tmp/claude-1000/scratchpad/x.md'
bash_tool 0 "$MAIN" 'echo x > ~/notes.md'
bash_tool 0 "$MAIN" 'echo x > "$(mktemp)"'
bash_tool 0 "$MAIN" $'cat > .scratch/brief-75.md <<\'EOF\'\nBrief: echo > docs/x.md and sed -i there.\nEOF'
bash_tool 0 "$MAIN" $'cat <<\'EOF\' > .scratch/brief-75.md\nBrief\nEOF'
bash_tool 0 "$MAIN" "cat > $MAIN/.scratch/brief.md < /dev/null"
bash_tool 0 "$MAIN/docs" 'echo x > ../.scratch/x.md'
bash_tool 0 "$MAIN" 'echo "- 10:40 merged #115" >> .remember/now.md'
bash_tool 0 "$MAIN" 'gh issue view 75 | tee .scratch/75.md'
bash_tool 0 "$MAIN" 'git log | tee -a "$TMPDIR/log" | head'
bash_tool 0 "$MAIN" 'wc -l < docs/spec.md'
bash_tool 0 "$MAIN" 'diff <(git show origin/main:AGENTS.md) AGENTS.md'
bash_tool 0 "$MAIN" "sed -n '1,20p' docs/spec.md"
bash_tool 0 "$MAIN" "sed 's/a/b/' docs/spec.md > .scratch/spec.md"
bash_tool 0 "$MAIN" "sed -i 's/a/b/' .scratch/brief.md"
bash_tool 0 "$MAIN" "perl -ne 'print if /x/' docs/spec.md"
bash_tool 0 "$MAIN" "perl -MList::Util=sum -ne 'print' docs/spec.md"
bash_tool 0 "$MAIN" "perl -pi -e 's/a/b/' .scratch/brief.md"
bash_tool 0 "$MAIN" 'cp docs/spec.md .scratch/'
bash_tool 0 "$MAIN" 'cp -r docs "$TMPDIR/docs"'
bash_tool 0 "$MAIN" 'mv .scratch/a.md .scratch/b.md'
bash_tool 0 "$MAIN" 'ln -sf /etc/hosts .scratch/hosts'
bash_tool 0 "$MAIN" 'rm -f .scratch/brief-75.md'
bash_tool 0 "$MAIN" 'rm -rf "$TMPDIR/x"'
bash_tool 0 "$MAIN" 'rm -rf .claude/worktrees/16-x && git worktree prune' # the evening routine (sandbox.md)
bash_tool 0 "$MAIN" 'touch .scratch/x.md'
bash_tool 0 "$MAIN" "touch -d '1 day ago' .remember/x.md"
bash_tool 0 "$MAIN" 'truncate -s 0 .scratch/log'
bash_tool 0 "$MAIN" 'git apply --check .scratch/fix.patch'
bash_tool 0 "$MAIN" 'git apply --stat .scratch/fix.patch'
bash_tool 0 "$MAIN" 'git -C /tmp/other apply .scratch/fix.patch'
bash_tool 0 "$MAIN" 'patch --dry-run -p1 < .scratch/fix.patch'
bash_tool 0 "$MAIN" 'patch -o .scratch/x.md docs/spec.md .scratch/fix.patch'
bash_tool 0 "$MAIN" 'patch -d /tmp/other -p1 < .scratch/fix.patch'
bash_tool 0 "$MAIN" 'git fetch origin && git merge --ff-only origin/main'
bash_tool 0 "$MAIN" 'git worktree remove --force .claude/worktrees/16-x'
bash_tool 0 "$MAIN" 'git worktree prune'
bash_tool 0 "$MAIN" 'scripts/issue-fields.sh 75 --priority P1 --size S'
bash_tool 0 "$MAIN" 'bash scripts/orphan-issues.sh'
bash_tool 0 "$MAIN" 'scripts/after-merge.sh .claude/worktrees/75-coordinator-guard'
bash_tool 0 "$MAIN" 'cd /tmp && echo x > notes.md'
bash_tool 0 /tmp 'echo x > notes.md'

# --- commit and PR forms through wrappers, `-c` shells and the API ----------------------------
bash_tool 2 "$MAIN" 'timeout 60 git commit -m x'
bash_tool 2 "$MAIN" 'timeout -k 5 -s TERM 60 git commit -m x'
bash_tool 2 "$MAIN" 'nice git commit -m x'
bash_tool 2 "$MAIN" 'nice -n 5 git commit -m x'
bash_tool 2 "$MAIN" 'env -i PATH=/usr/bin git commit -m x'
bash_tool 2 "$MAIN" 'env -u GIT_DIR git commit -m x'
bash_tool 2 "$MAIN" 'echo x | xargs git commit -m'
bash_tool 2 "$MAIN" 'printf "%s\n" a | xargs -I{} git commit -m {}'
bash_tool 2 "$MAIN" 'stdbuf -oL git commit -m x'
bash_tool 2 "$MAIN" 'sudo -u soto git commit -m x'
bash_tool 2 "$MAIN" 'bash -c "git commit -m x"'
bash_tool 2 "$MAIN" "sh -c 'git add . && git commit -m x'"
bash_tool 2 "$MAIN" "bash -lc 'gh pr create --fill'"
bash_tool 2 "$MAIN" "bash -o pipefail -c 'git commit -m x | tail -1'"
bash_tool 2 "$MAIN" "zsh -c 'echo x > docs/x.md'"
bash_tool 2 "$MAIN" "timeout 30 bash -c 'sed -i s/a/b/ docs/x.md'"
bash_tool 2 "$MAIN" 'gh api -X POST repos/sssoto17/sunny-pastures/pulls -f title=t -f head=x -f base=main' '`gh api`'
bash_tool 2 "$MAIN" 'gh api --method POST /repos/sssoto17/sunny-pastures/pulls --input .scratch/pr.json'
bash_tool 2 "$MAIN" 'gh api --method=post repos/{owner}/{repo}/pulls -f title=t'
bash_tool 2 "$MAIN" 'gh api repos/{owner}/{repo}/pulls -f title=t -f head=x -f base=main'
bash_tool 2 "$MAIN" 'gh api repos/{owner}/{repo}/pulls -F draft=true -f title=t'
bash_tool 2 "$MAIN" "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'"
bash_tool 0 "$MAIN" 'timeout 60 git fetch'
bash_tool 0 "$MAIN" 'nice -n 5 pnpm check:fast'
bash_tool 0 "$MAIN" "bash -c 'git status && git log -1'"
bash_tool 0 "$MAIN" "bash -c 'cat > .scratch/x.md' < /dev/null"
bash_tool 0 "$MAIN" "sh -c 'cd .claude/worktrees/16-x && git status'"
bash_tool 0 "$MAIN" 'xargs -n1 echo < .scratch/list'
bash_tool 0 "$MAIN" 'bash scripts/issue-fields.sh 75'
bash_tool 0 "$MAIN" 'gh api repos/{owner}/{repo}/pulls'
bash_tool 0 "$MAIN" 'gh api repos/{owner}/{repo}/pulls -X GET -f state=open'
bash_tool 0 "$MAIN" 'gh api repos/{owner}/{repo}/pulls/115/comments -f body=x'
bash_tool 0 "$MAIN" 'gh api -X POST repos/{owner}/{repo}/pulls/115/reviews -f event=COMMENT -f body=x'
bash_tool 0 "$MAIN" 'gh api repos/{owner}/{repo}/issues -f title=t -f body=b'
bash_tool 0 "$MAIN" "gh api graphql -f query='query { viewer { login } }'"
bash_tool 0 "$WT" "bash -c 'git commit -m x && gh pr create --fill'"
bash_tool 0 "$WT" "sed -i 's/a/b/' docs/x.md && echo x > docs/y.md"

# --- re-review of #115: `>` in arithmetic and `[[ ]]` is a comparison, not a redirect -------------
bash_tool 0 "$MAIN" 'n=$(gh pr list --json number --jq length); (( n > 0 )) && echo open'
bash_tool 0 "$MAIN" 'if (( $(git rev-list --count origin/main..HEAD) > 0 )); then echo ahead; fi'
bash_tool 0 "$MAIN" '(( n >= 2 ))'
bash_tool 0 "$MAIN" '((n>0)) && echo yes'
bash_tool 0 "$MAIN" 'while (( i < 3 )); do i=$((i + 1)); done'
bash_tool 0 "$MAIN" 'while (( n > 0 )); do n=$((n - 1)); done'
bash_tool 0 "$MAIN" 'git fetch && (( $(git rev-list --count HEAD..origin/main) > 0 )) && echo behind'
bash_tool 0 "$MAIN" '(( (a + b) * 2 > c ))'
bash_tool 0 "$MAIN" '[[ a > b ]]'
bash_tool 0 "$MAIN" 'if [[ "$a" > "$b" ]]; then echo later; fi'
bash_tool 0 "$MAIN" '[[ -f x ]] && [[ x > y ]] && echo hi'
bash_tool 0 "$MAIN" 'while [[ $(date +%s) > 5 ]]; do break; done'
bash_tool 0 "$MAIN" "[[ \$x == ']]' ]] && echo q"
bash_tool 0 "$MAIN" "awk '\$1 > 3' .scratch/data"
bash_tool 2 "$MAIN" '(( n > 0 )) && echo x > docs/x.md'
bash_tool 2 "$MAIN" '[[ a > b ]] && git commit -m x'
bash_tool 2 "$MAIN" 'if (( n > 0 )); then sed -i s/a/b/ docs/x.md; fi'
# security review of 099a3b7: only a real test or arithmetic command is opaque
bash_tool 2 "$MAIN" 'echo [[ > docs/x.md ]]'         # `[[` as an argument: the redirect is real
bash_tool 2 "$MAIN" 'echo if [[ > docs/x.md ]]'      # `if` as an argument isn't a keyword
bash_tool 2 "$MAIN" 'printf %s do [[ >docs/x.md ]]'
bash_tool 2 "$MAIN" 'echo then ((true) && git commit -m x)'
# bash closes `[[ (a)]]` at `)]]`: what follows is lexed normally (independent review of 7b07348)
bash_tool 2 "$MAIN" '[[ (a)]] && git commit -m x; echo ]]'
bash_tool 2 "$MAIN" '[[ (a)]] > docs/a; echo ]]'
bash_tool 0 "$MAIN" '[[ (a) ]] && echo ok'
bash_tool 0 "$MAIN" '[[ ( a ) && b ]] && echo ok'
bash_tool 0 "$MAIN" 'if [[ (a)]]; then echo ok; fi'
bash_tool 0 "$MAIN" '[[ (a > b)]] && echo ok'
bash_tool 2 "$MAIN" 'x=1 [[ > docs/x.md ]]'          # after an assignment, `[[` is a plain word
bash_tool 2 "$MAIN" '>/dev/null [[ > docs/x.md ]]'   # after a redirect, too
bash_tool 2 "$MAIN" '</dev/null [[ > docs/x.md ]]'
bash_tool 2 "$MAIN" '>/tmp/a [[ > docs/x.md ]]'
bash_tool 2 "$MAIN" '2>&1 [[ > docs/x.md ]]'
bash_tool 2 "$MAIN" $'cat <<EOF [[ > docs/x.md ]]\nbody\nEOF'
bash_tool 0 "$MAIN" 'if ! [[ a > b ]]; then echo no; fi'
bash_tool 0 "$MAIN" 'while true; do [[ x > y ]] && break; done'
bash_tool 0 "$MAIN" '{ (( n > 0 )); }'
bash_tool 2 "$MAIN" '((true) && git commit -m x)'    # nested subshells, not arithmetic
bash_tool 2 "$MAIN" '((cd docs) && echo x > x.md)'
bash_tool 2 "$MAIN" '[[ a ]]>docs/x.md'
bash_tool 2 "$MAIN" $'[[ a ]]\ngit commit -m x'
bash_tool 0 "$MAIN" '[[ a ]]<.scratch/x'
bash_tool 0 "$MAIN" '! [[ a > b ]] && echo no'
bash_tool 0 "$MAIN" 'if ! (( n > 0 )); then echo none; fi'

# --- re-review of #115: sed -i / perl -i through xargs has no operand to check ---------------------
bash_tool 2 "$MAIN" "grep -rl foo docs | xargs sed -i 's/foo/bar/'" 'xargs'
bash_tool 2 "$MAIN" "git ls-files '*.md' | xargs -n1 perl -pi -e 's/a/b/'"
bash_tool 2 "$MAIN" "find .scratch -name '*.md' | xargs sed -i.bak 's/a/b/'"
bash_tool 0 "$MAIN" 'gh issue list --json number --jq ".[].number" | xargs -n1 gh issue view'
bash_tool 0 "$MAIN" 'git ls-files docs | xargs sed -n 1p'
bash_tool 0 "$MAIN" 'git ls-files docs | xargs wc -l'

# --- symlinks: the real path decides --------------------------------------------------------------
REAL=$(mktemp -d "${TMPDIR:-/tmp}/coordinator-test.XXXXXX")
trap 'rm -rf "$REAL"' EXIT
REAL=$(cd "$REAL" && pwd -P)
mkdir -p "$REAL/repo/.scratch" "$REAL/repo/docs" "$REAL/out"
: >"$REAL/repo/AGENTS.md"
ln -s ../AGENTS.md "$REAL/repo/.scratch/agents-link"
ln -s ../docs "$REAL/repo/.scratch/docs-link"
ln -s "$REAL/out" "$REAL/repo/.scratch/out-link"
ln -s "$REAL/repo/AGENTS.md" "$REAL/out/agents-link"
real_file() { CLAUDE_PROJECT_DIR=$REAL/repo file_tool "$@"; }
real_bash() { CLAUDE_PROJECT_DIR=$REAL/repo bash_tool "$@"; }
real_file 2 "$REAL/repo" Write "$REAL/repo/.scratch/agents-link"
real_file 2 "$REAL/repo" Write "$REAL/repo/.scratch/docs-link/new.md"
real_file 2 "$REAL/repo" Write "$REAL/out/agents-link"
real_file 0 "$REAL/repo" Write "$REAL/repo/.scratch/new.md"
real_file 0 "$REAL/repo" Write "$REAL/repo/.scratch/out-link/new.md"
real_bash 2 "$REAL/repo" 'echo x > .scratch/agents-link'
real_bash 2 "$REAL/repo" "sed -i 's/a/b/' .scratch/docs-link/x.md"
real_bash 0 "$REAL/repo" 'echo x > .scratch/new.md'
# rm and unlink remove the link itself, not its target (re-review of #115)
real_bash 0 "$REAL/repo" 'rm .scratch/agents-link'
real_bash 0 "$REAL/repo" 'rm -f .scratch/docs-link'
real_bash 0 "$REAL/repo" 'unlink .scratch/agents-link'
real_bash 2 "$REAL/repo" 'rm -rf .scratch/docs-link/' # a trailing slash goes through the link
real_bash 2 "$REAL/repo" 'rm .scratch/docs-link/x.md'
real_bash 2 "$REAL/repo" 'unlink docs/x.md'

# --- no repo to guard: CLAUDE_PROJECT_DIR unset and cwd outside any git repo ----------------------
mkdir -p "$REAL/no-repo"
CLAUDE_PROJECT_DIR='' file_tool 0 "$REAL/no-repo" Write "$REAL/no-repo/x.md"
CLAUDE_PROJECT_DIR='' bash_tool 0 "$REAL/no-repo" 'echo x > x.md && git commit -m x'

# --- remote sessions aren't the local coordinator: cloud sessions, routines, Actions jobs --------
CLAUDE_CODE_REMOTE=true bash_tool 0 "$MAIN" 'git commit -m x && gh pr create --fill'
CLAUDE_CODE_REMOTE=true file_tool 0 "$MAIN" Edit "$MAIN/docs/retros/2026-11-15.md"
GITHUB_ACTIONS=true bash_tool 0 "$MAIN" "sed -i 's/a/b/' docs/x.md && git commit -am x"
GITHUB_ACTIONS=true file_tool 0 "$MAIN" Write "$MAIN/packages/sim/src/index.ts"
CLAUDE_CODE_REMOTE=false bash_tool 2 "$MAIN" 'git commit -m x'
GITHUB_ACTIONS=1 file_tool 2 "$MAIN" Write "$MAIN/AGENTS.md"

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

# A heredoc line longer than the lexer's 4096-char window still ends where it should.
long=$(printf 'git commit -m nope; %.0s' {1..300})
bash_tool 2 "$MAIN" $'cat > .scratch/x.md <<\'EOF\'\n'"$long"$'\nEOF\ngit commit -m x'
bash_tool 0 "$MAIN" $'cat > .scratch/x.md <<\'EOF\'\n'"$long"$'\nEOF\ngit status'

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]

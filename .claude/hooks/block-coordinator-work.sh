#!/usr/bin/env bash
# shellcheck disable=SC2016 # backticks and `$HOME` in single quotes are message text and patterns
# PreToolUse hook: keep the coordinating session at the coordination level (#75). When the
# session's cwd is the main folder (not inside .claude/worktrees/<name>), it denies:
# - Edit/Write/MultiEdit/NotebookEdit on repo paths outside .scratch/, .remember/ and the review
#   copies (.claude/worktrees/review-*, REVIEW.md, #513), including another session's worktree;
# - the common Bash writes to those paths: output redirects, `tee`, `sed -i`, `perl -i` (and
#   either through xargs), `cp`, `mv`, `install`, `ln`, `rm`, `unlink`, `touch`, `truncate`,
#   `git apply` and `patch`;
# - Bash `git commit`, `gh pr create`, a `gh api` POST that opens a PR, and the App's route to one
#   (#336): `scripts/open-pr.sh`, `scripts/stack.sh open|add` and a POST to `dispatches`.
# Wrappers (`timeout`, `env -i`, `xargs`, …) and `bash -c` strings are looked through. The real
# path decides (a symlink in .scratch/ to a repo file is a repo file; `rm` of a link removes the
# link). Known misses, left to the AGENTS.md standard: other tools that write files (`curl -o`,
# `sort -o`, `prettier --write`, `lint --fix`, `git restore`/`checkout -- <path>`, `git stash
# pop`, `python3`/`node -e`), `$( … )` bodies, and targets behind unknown variables. Paths
# outside the repo (session memory, the scratchpad, $TMPDIR) stay writable, as do reads,
# `gh issue create`, `git fetch`/`merge` and `git worktree`. Worktree sessions and remote ones
# (cloud sessions, routines, GitHub Actions jobs; see remote_session in the lib) are unaffected.
# Exit 2 blocks the tool call and stderr goes back to the session. Reads the raw hook JSON on
# stdin, so it needs no jq; shared parts are in lib/shell-lexer.sh. Tests:
# block-coordinator-work.test.sh next to this file.
set -uo pipefail
# Without the lib the hook exits 1: Claude Code reports the error and lets the call through.
# shellcheck source-path=SCRIPTDIR source=lib/shell-lexer.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/shell-lexer.sh" || exit 1

input=$(cat)
remote_session && exit 0

cwd=$(json_field cwd) || exit 0
in_worktree "$cwd" && exit 0
tool=$(json_field tool_name) || exit 0

# The repo the session was started in: the main folder. No repo, nothing to guard.
root=${CLAUDE_PROJECT_DIR:-}
[[ -n $root ]] || root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
[[ -n $root ]] || exit 0

# Set REPLY to absolute path $1 with symlinks resolved: the real path of the target when it
# exists, else of its parent (GNU `readlink -m`). Falls back to $1 when that fails.
real_path() {
  local r
  if r=$(readlink -m -- "$1" 2>/dev/null) && [[ -n $r ]]; then REPLY=$r; else REPLY=$1; fi
}
normalize_path / "$root"
real_path "$REPLY"
root=$REPLY

# Is absolute path $1 a lane's file: in the repo, outside .scratch/, .remember/ and the review
# copies? Sets REPLY to its real path; with $2 set, only its parent's symlinks are resolved (the
# path names a link). A review copy (.claude/worktrees/review-<N>-<short sha>) is a reviewer's
# throwaway: REVIEW.md has the reviewer link node_modules and plant mutants there, and
# scripts/after-merge.sh removes it once its PR is closed (#513). Lanes are named <N>-<slug>.
lane_path() {
  if [[ -n ${2:-} ]]; then
    local parent=${1%/*}
    real_path "${parent:-/}"
    REPLY=${REPLY%/}/${1##*/}
  else
    real_path "$1"
  fi
  case $REPLY in
    "$root"/.scratch | "$root"/.scratch/* | "$root"/.remember | "$root"/.remember/*) return 1 ;;
    "$root"/.claude/worktrees/review-*) return 1 ;;
    "$root" | "$root"/*) return 0 ;;
  esac
  return 1
}

deny_edit() {
  cat >&2 <<EOF
Blocked: the coordinating session (cwd in the main folder) doesn't edit repo files: $1
It briefs, dispatches, reviews, relays and keeps the board (AGENTS.md). Write a brief in .scratch/
and hand the work to a lane, which enters its own worktree with the worktree tool. From the main
folder, .scratch/, .remember/ and paths outside the repo stay writable.
EOF
  exit 2
}

deny_bash() {
  cat >&2 <<EOF
Blocked: $1 is lane work, and this is the coordinating session (cwd in the main folder).
It briefs, dispatches, reviews, relays and keeps the board (AGENTS.md). From the main folder, Bash
may write to .scratch/, .remember/ and paths outside the repo, and \`gh issue create\` stays
allowed. Write a brief in .scratch/ and hand the work to a lane, which edits, commits and opens
its PR from its own worktree (entered with the worktree tool).
EOF
  exit 2
}

# Deny when word $1, a path that $2 writes, is a lane's file. A relative path is taken from
# directory $3 (default: the command's directory). With $4 = rm, removing a whole worktree
# (.claude/worktrees/<name>) is allowed: the coordinator cleans up merged lanes (workflow.md).
check_write() {
  local w=$1 from=${3:-$here} var_re='^(~|\$\{?(HOME|PWD|CLAUDE_PROJECT_DIR)\}?)(/.*)?$'
  if [[ $w =~ $var_re ]]; then
    case ${BASH_REMATCH[2]} in
      PWD) w=$here ;;
      CLAUDE_PROJECT_DIR) w=$root ;;
      *) w=${HOME:-} ;;
    esac
    [[ -n $w && $w != '?' ]] || return 0
    w+=${BASH_REMATCH[3]}
  elif [[ $w == '$'* ]]; then
    return 0 # $TMPDIR, another variable or a substitution: not the repo, or not knowable
  fi
  normalize_path "$from" "$w"
  [[ $REPLY == '?' ]] && return 0
  if [[ ${4:-} == rm && $REPLY == "$root"/.claude/worktrees/?* &&
    ${REPLY#"$root"/.claude/worktrees/} != */* ]]; then
    return 0
  fi
  # rm removes a link itself, not its target: resolve only the parent. A trailing `/` goes
  # through the link, so then the whole path is resolved.
  local nofollow=''
  [[ ${4:-} == rm && $w != */ ]] && nofollow=1
  lane_path "$REPLY" "$nofollow" && deny_bash "$2 on ${REPLY#"$root"/}"
  return 0
}

# Split the words after a command into operands and option values. $1 lists the short options
# that take a value; $2 maps long ones that take a value to a letter ("name:letter …"). Sets
# operands and optv[letter] (the last value given).
declare -A optv
split_args() {
  local takes=$1 longs=" $2 " w name letter val re="^-[^$1]*([$1])(.*)$"
  shift 2
  operands=()
  optv=()
  while (($#)); do
    w=$1
    shift
    case $w in
      --) operands+=("$@"); break ;;
      --*)
        name=${w#--} name=${name%%=*}
        [[ $longs == *" $name:"* ]] || continue
        letter=${longs#*" $name:"} letter=${letter:0:1}
        if [[ $w == *=* ]]; then val=${w#*=}; else val=${1:-}; shift; fi
        optv[$letter]=$val
        ;;
      -?*)
        [[ -n $takes && $w =~ $re ]] || continue
        letter=${BASH_REMATCH[1]} val=${BASH_REMATCH[2]}
        if [[ -z $val ]]; then val=${1:-}; shift; fi
        optv[$letter]=$val
        ;;
      *) operands+=("$w") ;;
    esac
  done
}

# `sed`/`perl` words after the name: return 0 when they edit in place (`-i`), with the files in
# operands. In an option cluster, a letter in $1 takes a value (the rest of the cluster or the
# next word; `e`, `E` and `f` give the script), and a letter in $2 takes the rest of the cluster.
inplace_targets() {
  local ends=$1 rest=$2 inplace=0 script=0 w c k
  shift 2
  operands=()
  while (($#)); do
    w=$1
    shift
    case $w in
      --) operands+=("$@"); break ;;
      --in-place | --in-place=*) inplace=1 ;;
      --expression=* | --file=*) script=1 ;;
      --expression | --file) script=1; shift ;;
      --*) ;;
      -?*)
        for ((k = 1; k < ${#w}; k++)); do
          c=${w:k:1}
          [[ $c == i ]] && inplace=1 && break # the rest of the cluster is a backup suffix
          [[ -n $rest && $rest == *"$c"* ]] && break
          [[ $ends == *"$c"* ]] || continue
          [[ $c == [eEf] ]] && script=1
          ((k + 1 == ${#w})) && shift # the value is the next word
          break
        done
        ;;
      *) if ((script)); then operands+=("$w"); else script=1; fi ;;
    esac
  done
  ((inplace))
}

check_git() {
  gdir=$here
  parse_git_args "$@"
  case $git_sub in
    commit) deny_bash '`git commit`' ;;
    apply)
      local a readonly=0 apply=0
      for a in "${git_rest[@]}"; do
        case $a in
          --check | --stat | --numstat | --summary) readonly=1 ;;
          --apply) apply=1 ;;
        esac
      done
      ((readonly && !apply)) || check_write . '`git apply`' "$gdir"
      ;;
  esac
}

# The App's route opens PRs too (#336): scripts/open-pr.sh, and scripts/stack.sh open and add.
check_pr_script() { # script args...
  if [[ $1 == open-pr.sh ]]; then
    [[ ${2:-} =~ ^(-h|--help)$ ]] || deny_bash '`scripts/open-pr.sh`'
  elif [[ ${2:-} =~ ^(open|add)$ ]]; then
    deny_bash "\`scripts/stack.sh $2\`"
  fi
  return 0
}

check_gh() {
  local args=("$@")
  # Skip the flags gh accepts before the command: `gh -R <repo> pr create`.
  while ((${#args[@]})) && [[ ${args[0]} == -* ]]; do
    [[ ${args[0]} =~ ^(-R|--repo)$ ]] && args=("${args[@]:1}")
    args=("${args[@]:1}")
  done
  [[ ${args[0]:-} == pr && ${args[1]:-} =~ ^(create|new)$ ]] && deny_bash '`gh pr create`'
  [[ ${args[0]:-} == api ]] || return 0
  # `gh api`: a POST to …/pulls opens a PR. Fields (-f, -F, --input) make it a POST by default.
  local w method='' fields=0 endpoint='' mutation=0
  set -- "${args[@]:1}"
  while (($#)); do
    w=$1
    shift
    case $w in
      -X | --method) method=${1:-}; shift ;;
      -X*) method=${w#-X} ;;
      --method=*) method=${w#*=} ;;
      -f | -F | --field | --raw-field | --input)
        fields=1
        [[ ${1:-} == *createPullRequest* ]] && mutation=1
        shift
        ;;
      -f* | -F* | --field=* | --raw-field=* | --input=*)
        fields=1
        [[ $w == *createPullRequest* ]] && mutation=1
        ;;
      -H | --header | -q | --jq | -t | --template | --cache | -p | --preview | --hostname) shift ;;
      -*) ;;
      *) [[ -n $endpoint ]] || endpoint=$w ;;
    esac
  done
  method=${method^^}
  [[ -z $method ]] && ((fields)) && method=POST
  if [[ $method == POST && $endpoint =~ (^|/)pulls/?$ ]] ||
    { [[ $endpoint == graphql ]] && ((mutation)); }; then
    deny_bash "\`gh api\` opening a PR ($endpoint)"
  fi
  # repository_dispatch is how a lane asks the open-pr workflow for its PR (#336).
  [[ $method == POST && $endpoint =~ (^|/)dispatches/?$ ]] && deny_bash "\`gh api\` dispatching ($endpoint)"
  return 0
}

check_patch() {
  [[ " $* " == *' --dry-run '* ]] && return 0
  split_args dioprFBVzYDg 'directory:d input:i output:o strip:p reject-file:r fuzz:F prefix:B' "$@"
  local pdir=${optv[d]:-.} target
  # With -d, patch works in that directory; it writes -o, else the named file, else the patch's.
  if [[ -n ${optv[o]:-} ]]; then
    target=${optv[o]}
  elif ((${#operands[@]})); then
    target=${operands[0]}
  else
    target=.
  fi
  [[ $target == /* ]] || target=$pdir/$target
  check_write "$target" '`patch`'
}

# Called by walk_commands for each simple command, with `here` its directory and cmd_redirs its
# output redirect targets. Every directory counts: a commit or a write in another session's
# worktree, reached with `git -C` or a subshell `cd`, is lane work too.
check_command() {
  local r
  for r in "${cmd_redirs[@]}"; do check_write "$r" 'a redirect'; done
  case $name in
    git) check_git "${@:2}" ;;
    gh) check_gh "${@:2}" ;;
    open-pr.sh | stack.sh) check_pr_script "$name" "${@:2}" ;;
    bash | sh)
      [[ ${2:-} == */open-pr.sh || ${2:-} == */stack.sh || ${2:-} == open-pr.sh || ${2:-} == stack.sh ]] &&
        check_pr_script "${2##*/}" "${@:3}"
      ;;
    tee)
      split_args '' '' "${@:2}"
      for r in "${operands[@]}"; do check_write "$r" '`tee`'; done
      ;;
    sed | perl)
      local ends=efl rest=''
      [[ $name == perl ]] && ends=eE rest=MmIlx0CdD
      if inplace_targets "$ends" "$rest" "${@:2}"; then
        # Under xargs the files come from stdin, so they can't be checked.
        ((via_xargs)) && deny_bash "\`$name -i\` through xargs"
        for r in "${operands[@]}"; do check_write "$r" "\`$name -i\`"; done
      fi
      ;;
    cp | install | ln | mv)
      split_args tSmog 'target-directory:t suffix:S mode:m owner:o group:g' "${@:2}"
      [[ -n ${optv[t]:-} ]] && check_write "${optv[t]}" "\`$name\`"
      if [[ $name == mv ]] || [[ $name == install && " ${*:2} " =~ \ (-d|--directory)\  ]]; then
        for r in "${operands[@]}"; do check_write "$r" "\`$name\`"; done # mv removes its sources
      elif [[ -z ${optv[t]:-} ]] && ((${#operands[@]} >= 2)); then
        check_write "${operands[-1]}" "\`$name\`"
      elif [[ $name == ln && ${#operands[@]} -eq 1 ]]; then
        check_write "${operands[0]##*/}" '`ln`' # a link in the current directory
      fi
      ;;
    rm | unlink | touch | truncate)
      case $name in
        rm | unlink) split_args '' '' "${@:2}" ;;
        touch) split_args dtr 'date:d reference:r' "${@:2}" ;;
        truncate) split_args sr 'size:s reference:r' "${@:2}" ;;
      esac
      local mode=''
      [[ $name == rm || $name == unlink ]] && mode='rm'
      for r in "${operands[@]}"; do check_write "$r" "\`$name\`" "$here" "$mode"; done
      ;;
    patch) check_patch "${@:2}" ;;
  esac
  return 0
}

case $tool in
  Bash)
    command=$(json_field command) || exit 0
    # Nothing to check: skip the lexer. Only for unquoted text, since quotes or a backslash can
    # split a command name (`g'i't`, `g\it`) and hide it from this test.
    if [[ ! $command =~ [\'\"\\] &&
      ! $command =~ (git|gh|\>|tee|sed|perl|cp|mv|install|ln|link|rm|touch|truncate|patch|sh) ]]; then
      exit 0
    fi
    lex_command "$command"
    walk_commands "$cwd"
    ;;
  Edit | Write | MultiEdit | NotebookEdit)
    path=$(json_field file_path) || path=$(json_field notebook_path) || exit 0
    # shellcheck disable=SC2088 # a literal `~` in the tool input stands for home
    [[ $path == '~' || $path == '~/'* ]] && path=${HOME:-}${path:1}
    normalize_path "$cwd" "$path"
    lane_path "$REPLY" && deny_edit "$REPLY"
    ;;
esac
exit 0

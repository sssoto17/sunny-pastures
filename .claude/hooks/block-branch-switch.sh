#!/usr/bin/env bash
# PreToolUse hook on Bash: keep the main folder on `main` and keep the coordinating session's
# working directory in it. Denies a branch switch (`git checkout <branch>`, `git switch`,
# `gh pr checkout`) whose directory is not inside .claude/worktrees/<name>, whatever the session's
# cwd, and a top-level `cd`/`pushd` into .claude/worktrees/ from the main folder. Exit 2 blocks the
# command and stderr goes back to the session. Reads the raw hook JSON on stdin, so it needs no
# jq. Tests: block-branch-switch.test.sh next to this file.
set -uo pipefail
export LC_ALL=C
# bash 5.2+ expands `&` in a ${s//pat/rep} replacement to the match; a decoded `&` must stay `&`.
shopt -u patsub_replacement 2>/dev/null || true

input=$(cat)

# Print the decoded string value of the first JSON key named $1. Keys are found by a structural
# `{` or `,` before the quote: inside a JSON string every quote is escaped, so it can't match.
json_field() {
  local re='[{,][[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"(.*)'
  [[ $input =~ $re ]] || return 1
  # Whole-string expansions, not a char loop (a char loop takes ~30 s on a 150 KB command).
  # A raw JSON string holds no control characters, so \1 and \2 are free as placeholders.
  local s=${BASH_REMATCH[1]} hex ch
  s=${s//\\\\/$'\1'}  # \\ -> \1
  s=${s//\\\"/$'\2'}  # \" -> \2
  [[ $s =~ ^([^\"]*) ]] && s=${BASH_REMATCH[1]} # the value ends at the first bare quote
  s=${s//\\n/$'\n'}
  s=${s//\\t/$'\t'}
  s=${s//\\r/$'\r'}
  s=${s//\\\//\/}
  s=${s//\\b/ }
  s=${s//\\f/ }
  while [[ $s =~ \\u([0-9a-fA-F]{4}) ]]; do
    hex=${BASH_REMATCH[1]}
    if [[ ${hex,,} == 005c ]]; then
      ch=$'\1' # a backslash, restored below with the others
    elif ((16#$hex >= 32 && 16#$hex < 127)); then
      printf -v ch '%b' "\\x${hex:2:2}"
    else
      ch='?'
    fi
    s=${s//\\u$hex/"$ch"}
  done
  s=${s//$'\2'/\"}
  s=${s//$'\1'/\\}
  printf '%s' "$s"
}

# A path in a worktree: under .claude/worktrees/<name>, with no `..` stepping back out.
in_worktree() {
  [[ $1 =~ (^|/)\.claude/worktrees/[^/.][^/]* && ! $1 =~ \.claude/worktrees/(.*/)?\.\.(/|$) ]]
}

# Set REPLY to $2 resolved against directory $1 and normalised (no `.` or `..`), or to `?` when
# it can't be known from the text: an unknown base, `~`, a variable, a substitution, `+N`.
# `?` never counts as a worktree.
resolve_path() {
  local base=$1 target=$2 p part parts out=()
  REPLY='?'
  [[ $target =~ ^[A-Za-z0-9._/][A-Za-z0-9._/@,:=+-]*$ ]] || return
  if [[ $target == /* ]]; then
    p=$target
  elif [[ $base == '?' ]]; then
    return
  else
    p=$base/$target
  fi
  IFS=/ read -ra parts <<<"$p"
  for part in "${parts[@]}"; do
    case $part in
      '' | .) ;;
      ..) ((${#out[@]})) && out=("${out[@]:0:${#out[@]}-1}") ;;
      *) out+=("$part") ;;
    esac
  done
  local IFS=/
  REPLY=/${out[*]}
}

cwd=$(json_field cwd) || exit 0
command=$(json_field command) || exit 0
[[ $command =~ (git|gh|cd|pushd) ]] || exit 0 # nothing to check: skip the lexer

deny_switch() {
  cat >&2 <<'EOF'
Blocked: this switches branches outside a worktree, in the main folder. The main folder stays on
main and belongs to the coordinating session (AGENTS.md, parallel sessions). Work in a worktree
instead: `git worktree add .claude/worktrees/<N>-<slug> -b <branch> main`, then reach it with
`git -C <worktree> …`, a subshell `( cd <worktree> && … )` or absolute paths
(docs/agents/sandbox.md, "Working directory"). To restore a file, use `git checkout -- <path>`.
EOF
  exit 2
}

# Is `git <args>` (words after `git`) a branch switch? Each `-C <dir>` moves gdir, the
# directory the command acts on; the caller sets gdir first.
git_switches_branch() {
  local i=0 n=$# args=("$@") sub
  while ((i < n)); do
    case ${args[i]} in
      -C)
        resolve_path "$gdir" "${args[i + 1]:-}"
        gdir=$REPLY
        i=$((i + 2))
        ;;
      -c | --git-dir | --work-tree | --namespace) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  sub=${args[i]:-}
  [[ $sub == switch ]] && return 0
  [[ $sub == checkout ]] || return 1
  # checkout: `-- <path>` restores files. Otherwise a ref or a branch option switches.
  local a opts=("${args[@]:i+1}")
  local k
  for ((k = 0; k < ${#opts[@]}; k++)); do
    [[ ${opts[k]} == -- ]] || continue
    ((k + 1 < ${#opts[@]})) && return 1 # `checkout [<ref>] -- <path>` restores files
    opts=("${opts[@]:0:k}")             # a bare trailing `--` changes nothing
    break
  done
  for a in "${opts[@]}"; do
    case $a in
      -b* | -B* | --orphan | --orphan=* | --detach | -) return 0 ;;
      -*) ;;
      *) return 0 ;;
    esac
  done
  return 1
}

# --- Lexer ----------------------------------------------------------------------------------
# Splits $command into tokens: kinds[k] is W (a word, quotes removed) or O (an operator: `&&`,
# `||`, `;` for any other command separator, `(` or `)`). Quoted text, `$( … )`, backticks, comments, redirect targets
# and heredoc bodies never become command words, so a commit message that mentions
# `git checkout` passes.
cmd=$command
n=${#cmd}
i=0
toks=()
kinds=()
word=''
have_word=0
next_is=''         # '' | redirect | heredoc: what the next word is for
heredocs=()        # pending heredoc delimiters, "-DELIM" when <<- strips tabs
heredoc_strip=0

emit_word() {
  if ((have_word)); then
    case $next_is in
      heredoc) heredocs+=("$( ((heredoc_strip)) && printf -- -)$word") ;;
      redirect) ;;
      *) toks+=("$word") kinds+=(W) ;;
    esac
    next_is=''
  fi
  word=''
  have_word=0
}
emit_op() { emit_word; toks+=("$1") kinds+=(O); }

# At cmd[i] == "'": append the quoted text to $word and move past the closing quote.
lex_squote() {
  local rest=${cmd:i+1} body
  body=${rest%%\'*}
  word+=$body
  i=$((i + ${#body} + 2))
}

# At cmd[i] == '"'.
lex_dquote() {
  i=$((i + 1))
  local c
  while ((i < n)); do
    c=${cmd:i:1}
    case $c in
      '"') i=$((i + 1)); return ;;
      \\) word+=${cmd:i+1:1}; i=$((i + 2)) ;;
      '$') if [[ ${cmd:i+1:1} == '(' ]]; then lex_subst; else word+=$c; i=$((i + 1)); fi ;;
      '`') lex_backtick ;;
      *) word+=$c; i=$((i + 1)) ;;
    esac
  done
}

lex_backtick() {
  local rest=${cmd:i+1} body
  body=${rest%%\`*}
  word+=$body
  i=$((i + ${#body} + 2))
}

# At cmd[i] == '$(' (also `$((`). Skips to the matching `)`, through nested quotes,
# substitutions and heredocs; the text is kept in $word only as data.
lex_subst() {
  i=$((i + 2))
  local depth=1 c saved=("${heredocs[@]}")
  heredocs=()
  while ((i < n && depth > 0)); do
    c=${cmd:i:1}
    case $c in
      \\) i=$((i + 2)) ;;
      "'") lex_squote ;;
      '"') lex_dquote ;;
      '`') lex_backtick ;;
      '(') depth=$((depth + 1)); i=$((i + 1)) ;;
      ')') depth=$((depth - 1)); i=$((i + 1)) ;;
      '$') if [[ ${cmd:i+1:1} == '(' ]]; then lex_subst; else i=$((i + 1)); fi ;;
      '<')
        if [[ ${cmd:i:2} == '<<' && ${cmd:i:3} != '<<<' ]]; then
          lex_heredoc_delim
        else
          i=$((i + 1))
        fi
        ;;
      $'\n') i=$((i + 1)); skip_heredoc_bodies ;;
      *) i=$((i + 1)) ;;
    esac
  done
  heredocs=("${saved[@]}")
  word+="\$(...)"
}

# At cmd[i] == '<<' inside a substitution: record the delimiter.
lex_heredoc_delim() {
  local strip=0 delim='' rest
  i=$((i + 2))
  [[ ${cmd:i:1} == - ]] && strip=1 && i=$((i + 1))
  while [[ ${cmd:i:1} == [[:blank:]] ]]; do i=$((i + 1)); done
  rest=${cmd:i}
  if [[ $rest =~ ^([\'\"]?)([^\'\"[:space:]\)\;\&\|\<\>]+)([\'\"]?) ]]; then
    delim=${BASH_REMATCH[2]}
    i=$((i + ${#BASH_REMATCH[0]}))
  fi
  heredocs+=("$( ((strip)) && printf -- -)$delim")
}

# At the start of a line: skip the bodies of every pending heredoc.
skip_heredoc_bodies() {
  local d delim strip line
  for d in "${heredocs[@]}"; do
    strip=0 delim=$d
    [[ $d == -* ]] && strip=1 delim=${d#-}
    while ((i < n)); do
      line=${cmd:i}
      line=${line%%$'\n'*}
      i=$((i + ${#line} + 1))
      ((strip)) && line=${line#"${line%%[!$'\t']*}"}
      [[ $line == "$delim" ]] && break
    done
  done
  heredocs=()
}

while ((i < n)); do
  c=${cmd:i:1}
  case $c in
    ' ' | $'\t') emit_word; i=$((i + 1)) ;;
    $'\n') emit_op ';'; i=$((i + 1)); skip_heredoc_bodies ;;
    ';' | '|')
      if [[ ${cmd:i:2} == '||' ]]; then
        emit_op '||'; i=$((i + 2))
      else
        emit_op ';'; i=$((i + 1)); [[ ${cmd:i:1} == [\;\|\&] ]] && i=$((i + 1))
      fi
      ;;
    '&')
      if [[ ${cmd:i+1:1} == '>' ]]; then # &> and &>> redirect stdout and stderr
        emit_word; next_is=redirect; i=$((i + 2)); [[ ${cmd:i:1} == '>' ]] && i=$((i + 1))
      else
        if [[ ${cmd:i+1:1} == '&' ]]; then emit_op '&&'; i=$((i + 2)); else emit_op ';'; i=$((i + 1)); fi
      fi
      ;;
    '(' | ')') emit_op "$c"; i=$((i + 1)) ;;
    '<' | '>')
      [[ $word =~ ^[0-9]+$ ]] && word='' have_word=0 # the fd in 2>&1
      emit_word
      if [[ ${cmd:i:3} == '<<<' ]]; then
        next_is=redirect; i=$((i + 3))
      elif [[ ${cmd:i:2} == '<<' ]]; then
        next_is=heredoc heredoc_strip=0; i=$((i + 2))
        [[ ${cmd:i:1} == - ]] && heredoc_strip=1 && i=$((i + 1))
      else
        next_is=redirect; i=$((i + 1))
        [[ ${cmd:i:1} == [\>\&\|] ]] && i=$((i + 1))
      fi
      ;;
    '#')
      if ((have_word)); then
        word+=$c; i=$((i + 1))
      else
        rest=${cmd:i}; rest=${rest%%$'\n'*}; i=$((i + ${#rest}))
      fi
      ;;
    "'") have_word=1; lex_squote ;;
    '"') have_word=1; lex_dquote ;;
    '`') have_word=1; lex_backtick ;;
    \\)
      if [[ ${cmd:i+1:1} == $'\n' ]]; then
        i=$((i + 2))
      else
        have_word=1; word+=${cmd:i+1:1}; i=$((i + 2))
      fi
      ;;
    '$')
      have_word=1
      if [[ ${cmd:i+1:1} == '(' ]]; then lex_subst; else word+=$c; i=$((i + 1)); fi
      ;;
    *) have_word=1; word+=$c; i=$((i + 1)) ;;
  esac
done
emit_word

# --- Checks ---------------------------------------------------------------------------------
# Check one simple command (its words in "$@") run in directory dir[depth].
check_command() {
  local words=("$@") negated=0
  # Skip what can precede the command name: grouping, keywords, assignments, wrappers.
  while ((${#words[@]})); do
    case ${words[0]} in
      '!') negated=1 words=("${words[@]:1}") ;;
      '{' | '}' | if | then | elif | else | do | while | until | command | builtin | \
        exec | nohup | time | env) words=("${words[@]:1}") ;;
      *)
        if [[ ${words[0]} =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then words=("${words[@]:1}"); else break; fi
        ;;
    esac
  done
  ((${#words[@]})) || return 0
  local here=${dir[depth]} name=${words[0]##*/}
  case $name in
    git)
      gdir=$here
      if git_switches_branch "${words[@]:1}" && ! in_worktree "$gdir"; then deny_switch; fi
      ;;
    gh)
      if [[ ${words[1]:-} == co || "${words[1]:-} ${words[2]:-}" == 'pr checkout' ]] &&
        ! in_worktree "$here"; then
        deny_switch
      fi
      ;;
    cd | pushd | popd)
      local a target='' plain=$((!negated && !or_seen[depth]))
      for a in "${words[@]:1}"; do
        if [[ $a == -* ]]; then
          [[ $a =~ ^-[LPe@]+$|^--$ ]] || plain=0 # e.g. `pushd -n` doesn't change directory
          continue
        fi
        target=$a
        break
      done
      if [[ $name == popd || -z $target ]]; then
        REPLY='?' # popd, a bare cd (home) or `cd -`
      else
        resolve_path "$here" "$target"
      fi
      # A top-level cd persists into the session's later commands; a subshell's does not.
      if ((depth == 0)) && ! in_worktree "$here" &&
        { [[ $target =~ (^|/)\.claude/worktrees(/|$) ]] || in_worktree "$REPLY"; }; then
        deny_cd
      fi
      if ((plain)); then
        dir[depth]=$REPLY
      elif [[ $REPLY != "$here" ]]; then
        dir[depth]='?' # it may or may not have moved: negated, skippable or an odd option
      fi
      ;;
  esac
}

deny_cd() {
  cat >&2 <<'EOF'
Blocked: a top-level `cd`/`pushd` into .claude/worktrees/ moves this session out of the main
folder, and Bash keeps that directory for every later command. The main folder belongs to the
coordinating session. Use `git -C <worktree> …`, a subshell `( cd <worktree> && … )` or absolute
paths instead (docs/agents/sandbox.md, "Working directory").
EOF
  exit 2
}

# After `;`, `||`, `|` or a newline, an earlier cd at this depth may have failed: the directory
# is base[d] or dir[d]. Keep a worktree only when both are worktrees (the shorter path, so a later
# `..` leaves it sooner); otherwise it's unknown, which counts as the main folder.
settle() {
  local d=${dir[depth]} b=${base[depth]}
  [[ $d == "$b" ]] && return
  if in_worktree "$d" && in_worktree "$b"; then
    ((${#b} < ${#d})) && dir[depth]=$b
  else
    dir[depth]='?'
  fi
}

# Walk the simple commands. dir[d] is the directory at subshell depth d: a subshell starts where
# its parent is (base[d]), and a cd inside it ends with it. A cd counts only through an `&&`
# chain; one that may be skipped (after `||` in the same list) or is negated (`! cd`) makes the
# directory unknown.
depth=0
dir=("$cwd")
base=("$cwd")
or_seen=(0)
cur=()
for ((k = 0; k < ${#toks[@]}; k++)); do
  if [[ ${kinds[k]} == W ]]; then
    cur+=("${toks[k]}")
    continue
  fi
  ((${#cur[@]})) && check_command "${cur[@]}"
  cur=()
  case ${toks[k]} in
    '(')
      depth=$((depth + 1))
      dir[depth]=${dir[depth - 1]} base[depth]=${dir[depth - 1]} or_seen[depth]=0
      ;;
    ')') ((depth > 0)) && depth=$((depth - 1)) ;;
    ';') settle; or_seen[depth]=0 ;;
    '||') settle; or_seen[depth]=1 ;;
  esac
done
((${#cur[@]})) && check_command "${cur[@]}"
exit 0

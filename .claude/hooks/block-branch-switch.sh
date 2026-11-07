#!/usr/bin/env bash
# PreToolUse hook on Bash: keep the main folder on `main` and keep the session's working
# directory in it. In the main folder (any cwd not under .claude/worktrees/) it denies branch
# switches. Exit 2 blocks the command and stderr goes back to the session. Reads the raw hook
# JSON on stdin, so it needs no jq. Tests: block-branch-switch.test.sh next to this file.
set -uo pipefail
export LC_ALL=C

input=$(cat)

# Print the decoded string value of the first JSON key named $1. Keys are found by a structural
# `{` or `,` before the quote: inside a JSON string every quote is escaped, so it can't match.
json_field() {
  local re='[{,][[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"(.*)'
  [[ $input =~ $re ]] || return 1
  # Whole-string expansions, not a char loop (a char loop takes ~30 s on a 150 KB command).
  # A raw JSON string holds no control characters, so \1 and \2 are free as placeholders.
  local s=${BASH_REMATCH[1]} hex
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
    if ((16#$hex >= 32 && 16#$hex < 127)); then
      s=${s//\\u$hex/$(printf '%b' "\\x${hex:2:2}")}
    else
      s=${s//\\u$hex/?}
    fi
  done
  s=${s//$'\2'/\"}
  s=${s//$'\1'/\\}
  printf '%s' "$s"
}

# A path in a worktree: under .claude/worktrees/<name>, with no `..` stepping back out.
in_worktree() {
  [[ $1 =~ (^|/)\.claude/worktrees/[^/.][^/]* && ! $1 =~ \.claude/worktrees/(.*/)?\.\.(/|$) ]]
}

cwd=$(json_field cwd) || exit 0
command=$(json_field command) || exit 0

in_worktree "$cwd" && exit 0

deny_switch() {
  cat >&2 <<'EOF'
Blocked: this switches branches in the main folder. The main folder stays on main and belongs to
the coordinating session (AGENTS.md, parallel sessions). Work in a worktree instead:
`git worktree add .claude/worktrees/<N>-<slug> -b <branch> main`, then reach it with
`git -C <worktree> …`, a subshell `( cd <worktree> && … )` or absolute paths
(docs/agents/sandbox.md, "Working directory"). To restore a file, use `git checkout -- <path>`.
EOF
  exit 2
}

# Is `git <args>` (words after `git`) a branch switch? `git -C <worktree>` is not.
git_switches_branch() {
  local i=0 n=$# args=("$@") sub
  while ((i < n)); do
    case ${args[i]} in
      -C)
        in_worktree "${args[i + 1]:-}" && return 1
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
      -b | -B | --orphan | --detach | -) return 0 ;;
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
# Check one simple command (its words in "$@").
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
  case ${words[0]##*/} in
    git)
      if ((!wt[depth])) && git_switches_branch "${words[@]:1}"; then deny_switch; fi
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
      # A top-level cd persists into the session's later commands; a subshell's does not.
      if [[ $target =~ (^|/)\.claude/worktrees(/|$) ]] && ((depth == 0 && !wt[0])); then
        deny_cd
      fi
      # Fail closed: only a worktree path sets the flag, and only a plain relative path without
      # `..` keeps it. popd, `+N`, `-`, home, absolute paths, variables and substitutions reset it.
      if ((plain)) && [[ ${words[0]##*/} != popd ]] && in_worktree "$target"; then
        wt[depth]=1
      elif ((!plain)) || [[ ${words[0]##*/} == popd || ! $target =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ||
        $target =~ (^|/)\.\.(/|$) ]]; then
        wt[depth]=0
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

# Walk the simple commands. wt[d] says whether subshell depth d is inside a worktree: a
# subshell starts where its parent is (base[d]), and a cd inside it ends with it. A cd's effect
# lasts only through an `&&` chain: after `;`, `||`, `|` or a newline the cd may have failed, so
# the flag goes back to base[d]. A cd that may be skipped (after `||` in the same list) or is
# negated (`! cd`) never sets the flag.
depth=0
wt=(0)
base=(0)
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
    '(') depth=$((depth + 1)); wt[depth]=${wt[depth - 1]} base[depth]=${wt[depth - 1]} or_seen[depth]=0 ;;
    ')') ((depth > 0)) && depth=$((depth - 1)) ;;
    ';') wt[depth]=${base[depth]} or_seen[depth]=0 ;;
    '||') wt[depth]=${base[depth]} or_seen[depth]=1 ;;
  esac
done
((${#cur[@]})) && check_command "${cur[@]}"
exit 0

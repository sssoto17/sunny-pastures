# shellcheck shell=bash disable=SC2034,SC2154 # shares globals with the hooks: $input in, git_sub, here, … out
# Sourced by the PreToolUse hooks in .claude/hooks/; not run on its own. Shared parts:
# - json_field: read a string field from the raw hook JSON in $input, without jq.
# - in_worktree, normalize_path, resolve_path: textual path checks (no filesystem access).
# - lex_command: split a Bash command into words and operators, so quoted text, `$( … )`,
#   comments, redirect targets and heredoc bodies never count as commands.
# - walk_commands: visit each simple command with the directory it runs in, following `cd`,
#   `pushd` and subshells. The hook defines check_command (and optionally check_cd).
# - parse_git_args: find a git subcommand after its global options, following `-C <dir>`.
# Tests: the hooks' own *.test.sh files, through the hook interface.
export LC_ALL=C
# bash 5.2+ expands `&` in a ${s//pat/rep} replacement to the match; a decoded `&` must stay `&`.
shopt -u patsub_replacement 2>/dev/null || true

# Print the decoded string value of the first JSON key named $1 in $input. Keys are found by a
# structural `{` or `,` before the quote: inside a JSON string every quote is escaped, so it can't
# match.
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

# Set REPLY to path $2 resolved against directory $1 and normalised (no `.`, `..` or repeated
# `/`). Purely textual: any characters, no symlinks. `?` when $2 is relative and $1 is `?`.
normalize_path() {
  local base=$1 target=$2 p part parts out=()
  REPLY='?'
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

# Like normalize_path for a shell word, but REPLY is `?` when the word's value can't be known
# from the text: `~`, a variable, a substitution, `+N`. `?` never counts as a worktree.
resolve_path() {
  REPLY='?'
  [[ $2 =~ ^[A-Za-z0-9._/][A-Za-z0-9._/@,:=+-]*$ ]] || return
  normalize_path "$1" "$2"
}

# Words after `git` in "$@". Each `-C <dir>` moves gdir, the directory the command acts on (the
# caller sets gdir first). Sets git_sub to the subcommand and git_rest to the words after it.
parse_git_args() {
  local i=0 n=$# args=("$@")
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
  git_sub=${args[i]:-}
  git_rest=("${args[@]:i+1}")
}

# --- Lexer ----------------------------------------------------------------------------------
# lex_command splits its argument into tokens: kinds[k] is W (a word, quotes removed) or O (an
# operator: `&&`, `||`, `;` for any other command separator, `(` or `)`). Quoted text, `$( … )`,
# backticks, comments, redirect targets and heredoc bodies never become command words, so a
# commit message that mentions `git checkout` passes.

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

lex_command() {
  cmd=$1
  n=${#cmd}
  i=0
  toks=()
  kinds=()
  word=''
  have_word=0
  next_is=''   # '' | redirect | heredoc: what the next word is for
  heredocs=()  # pending heredoc delimiters, "-DELIM" when <<- strips tabs
  heredoc_strip=0
  local c rest
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
}

# --- Walk -----------------------------------------------------------------------------------
# One simple command (its words in "$@") run in directory dir[depth]. Skips what can precede the
# command name, then sets `here` (its directory), `name` (the command's basename) and `negated`,
# and calls the hook's check_command with the remaining words. A `cd`/`pushd`/`popd` then moves
# dir[depth], after calling the hook's check_cd (if defined) with cd_target set and REPLY the
# resolved directory.
visit_command() {
  local words=("$@")
  negated=0
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
  here=${dir[depth]} name=${words[0]##*/}
  check_command "${words[@]}"
  case $name in
    cd | pushd | popd)
      local a plain=$((!negated && !or_seen[depth]))
      cd_target=''
      for a in "${words[@]:1}"; do
        if [[ $a == -* ]]; then
          [[ $a =~ ^-[LPe@]+$|^--$ ]] || plain=0 # e.g. `pushd -n` doesn't change directory
          continue
        fi
        cd_target=$a
        break
      done
      if [[ $name == popd || -z $cd_target ]]; then
        REPLY='?' # popd, a bare cd (home) or `cd -`
      else
        resolve_path "$here" "$cd_target"
      fi
      declare -F check_cd >/dev/null && check_cd
      if ((plain)); then
        dir[depth]=$REPLY
      elif [[ $REPLY != "$here" ]]; then
        dir[depth]='?' # it may or may not have moved: negated, skippable or an odd option
      fi
      ;;
  esac
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

# Walk the simple commands from lex_command, starting in directory $1. dir[d] is the directory at
# subshell depth d: a subshell starts where its parent is (base[d]), and a cd inside it ends with
# it. A cd counts only through an `&&` chain; one that may be skipped (after `||` in the same
# list) or is negated (`! cd`) makes the directory unknown.
walk_commands() {
  depth=0
  dir=("$1")
  base=("$1")
  or_seen=(0)
  local cur=() k
  for ((k = 0; k < ${#toks[@]}; k++)); do
    if [[ ${kinds[k]} == W ]]; then
      cur+=("${toks[k]}")
      continue
    fi
    ((${#cur[@]})) && visit_command "${cur[@]}"
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
  ((${#cur[@]})) && visit_command "${cur[@]}"
}

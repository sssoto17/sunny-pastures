# shellcheck shell=bash disable=SC2034,SC2154 # shares globals with the hooks: $input in, git_sub, here, … out
# Sourced by the PreToolUse hooks in .claude/hooks/; not run on its own. Shared parts:
# - json_field: read a string field from the raw hook JSON in $input, without jq.
# - remote_session: a cloud session, routine or GitHub Actions job, which the hooks skip.
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

# A remote session: a Claude Code cloud session or routine (CLAUDE_CODE_REMOTE=true, documented
# in the hooks reference) or a GitHub Actions job such as the factory or the reviewer
# (GITHUB_ACTIONS=true). Its checkout is its own, so there is no main folder to protect.
remote_session() {
  [[ ${CLAUDE_CODE_REMOTE:-} == true || ${GITHUB_ACTIONS:-} == true ]]
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
# lex_command splits its argument into tokens: kinds[k] is W (a word, quotes removed), R (the
# target of an output redirect) or O (an operator: `&&`, `||`, `;` for any other command
# separator, `(` or `)`). Quoted text, `$( … )`,
# backticks, comments, redirect targets and heredoc bodies never become command words, so a
# commit message that mentions `git checkout` passes.

emit_word() {
  if ((have_word)); then
    case $next_is in
      heredoc) heredocs+=("$( ((heredoc_strip)) && printf -- -)$word") ;;
      redirect) ;;
      redirect_out) # a file the command writes; `>&2` and `2>&1` duplicate a descriptor instead
        ((redir_dup)) && [[ $word =~ ^([0-9]+|-)$ ]] || toks+=("$word") kinds+=(R)
        ;;
      *)
        toks+=("$word") kinds+=(W)
        # Only a keyword in command position leaves the next word there too. After an
        # assignment (`x=1 [[`), `[[` and `((` are plain words, as in bash.
        [[ $cmd_pos == 1 && $word =~ ^(if|then|elif|else|while|until|do|!|\{|time)$ ]] || cmd_pos=0
        ;;
    esac
    next_is=''
  fi
  word=''
  have_word=0
}
# An operator is never a redirect target: `>(cmd)` and `<(cmd)` are process substitutions.
emit_op() { emit_word; next_is='' cmd_pos=1; toks+=("$1") kinds+=(O); }

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

# Is the next word in command position: first, after an operator, or after a keyword or an
# assignment that was itself in command position (cmd_pos, kept by emit_word and emit_op)?
# Only there are `[[` and `((` the test and arithmetic commands; elsewhere they're plain text.
at_command_start() { ((cmd_pos)); }

# At cmd[i] == '[[' starting a word: if a closing ` ]]` ends a word later on, move past it and
# keep the test as one opaque word (`>` and `<` inside it compare, they don't redirect).
lex_dbracket() {
  local j=$((i + 2)) c rest
  while ((j < n)); do
    c=${cmd:j:1}
    case $c in
      \\) j=$((j + 2)); continue ;;
      "'") rest=${cmd:j+1}; rest=${rest%%\'*}; j=$((j + ${#rest} + 2)); continue ;;
      '"')
        j=$((j + 1))
        while ((j < n)) && [[ ${cmd:j:1} != '"' ]]; do
          [[ ${cmd:j:1} == \\ ]] && j=$((j + 1))
          j=$((j + 1))
        done
        j=$((j + 1))
        continue
        ;;
    esac
    if [[ ${cmd:j:2} == ']]' && ${cmd:j-1:1} == [[:space:]\)] ]] && # `[[ (a)]]` closes at `)]]`
      { ((j + 2 >= n)) || [[ ${cmd:j+2:1} == [[:space:]\;\&\|\)\<\>] ]]; }; then
      word+='[[ … ]]'
      i=$((j + 2))
      return 0
    fi
    j=$((j + 1))
  done
  return 1
}

# At the start of a line: skip the bodies of every pending heredoc.
skip_heredoc_bodies() {
  local d delim strip line
  for d in "${heredocs[@]}"; do
    strip=0 delim=$d
    [[ $d == -* ]] && strip=1 delim=${d#-}
    while ((i < n)); do
      # Copy a window, not the whole rest of the command: per line, that copy made long
      # heredocs quadratic. A line longer than the window falls back to the full copy.
      line=${cmd:i:4096}
      [[ $line == *$'\n'* || ${#line} -lt 4096 ]] || line=${cmd:i}
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
  next_is=''   # '' | redirect | redirect_out | heredoc: what the next word is for
  redir_dup=0  # the redirect was `>&`: a target of digits or `-` is a descriptor, not a file
  cmd_pos=1    # the next word is in command position (see at_command_start)
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
          emit_word; next_is=redirect_out redir_dup=0 cmd_pos=0
          i=$((i + 2)); [[ ${cmd:i:1} == '>' ]] && i=$((i + 1))
        else
          if [[ ${cmd:i+1:1} == '&' ]]; then emit_op '&&'; i=$((i + 2)); else emit_op ';'; i=$((i + 1)); fi
        fi
        ;;
      '(')
        local i0=$i
        if ((!have_word)) && [[ ${cmd:i+1:1} == '(' ]] && at_command_start; then
          # `(( … ))` arithmetic: one opaque word, like `$(( … ))` (its `>` compares). Only if
          # it closes with `))`; `((cd x) && y)` is two subshells.
          have_word=1
          lex_subst
          if [[ ${cmd:i:1} == ')' ]]; then
            i=$((i + 1))
          else
            i=$i0 word='' have_word=0
            emit_op "$c"; i=$((i + 1))
          fi
        else
          emit_op "$c"; i=$((i + 1))
        fi
        ;;
      ')') emit_op "$c"; i=$((i + 1)) ;;
      '[')
        if ((!have_word)) && [[ ${cmd:i:3} == '[['[[:space:]] ]] && at_command_start &&
          lex_dbracket; then
          have_word=1
        else
          have_word=1 word+=$c i=$((i + 1))
        fi
        ;;
      '<' | '>')
        [[ $word =~ ^[0-9]+$ ]] && word='' have_word=0 # the fd in 2>&1
        emit_word
        cmd_pos=0 # after a redirect, `[[` and `((` are plain words, as in bash
        if [[ ${cmd:i:3} == '<<<' ]]; then
          next_is=redirect; i=$((i + 3))
        elif [[ ${cmd:i:2} == '<<' ]]; then
          next_is=heredoc heredoc_strip=0; i=$((i + 2))
          [[ ${cmd:i:1} == - ]] && heredoc_strip=1 && i=$((i + 1))
        else
          # `>`, `>>`, `>|`, `>&` and `<>` write to their target; `<` and `<&` only read it.
          next_is=redirect redir_dup=0
          [[ $c == '>' || ${cmd:i+1:1} == '>' ]] && next_is=redirect_out
          i=$((i + 1))
          [[ ${cmd:i:1} == '&' ]] && redir_dup=1
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
# Drop words[0], a wrapper command, and its options; $1 lists its short options that take a value.
drop_opts() {
  local takes=$1 w
  words=("${words[@]:1}")
  while ((${#words[@]})) && [[ ${words[0]} == -?* ]]; do
    w=${words[0]}
    words=("${words[@]:1}")
    [[ $w == -- ]] && break
    [[ -n $takes && $w =~ ^-[$takes]$ ]] && words=("${words[@]:1}") # its value is the next word
  done
}

# The words after a shell's name: set REPLY to the command string of `-c`, or return 1.
shell_c_string() {
  local w has_c=0
  while (($#)); do
    w=$1
    shift
    case $w in
      -o | +o | -O | +O) shift ;;
      --) ((has_c && $#)) && REPLY=$1 && return 0; return 1 ;;
      --*) ;;
      [-+]?*) [[ $w == -*c* ]] && has_c=1 ;;
      *) ((has_c)) && REPLY=$w && return 0; return 1 ;;
    esac
  done
  return 1
}

# One simple command (its words in "$@", its output redirect targets in cmd_redirs) run in
# directory dir[depth]. Skips what can precede the command name (keywords, assignments, wrappers
# such as `timeout 60` or `env -i`), then sets `here` (its directory), `name` (the command's
# basename) and `negated`, and calls the hook's check_command with the remaining words. The
# command string of `bash -c` / `sh -c` is walked too, as a subshell. A `cd`/`pushd`/`popd` then
# moves dir[depth], after calling the hook's check_cd (if defined) with cd_target set and REPLY
# the resolved directory.
visit_command() {
  local words=("$@")
  negated=0 via_xargs=0 # via_xargs: the command runs under xargs, which adds operands to it
  while ((${#words[@]})); do
    case ${words[0]} in
      '!') negated=1 words=("${words[@]:1}") ;;
      '{' | '}' | if | then | elif | else | do | while | until) words=("${words[@]:1}") ;;
      command | builtin | nohup | time) drop_opts '' ;;
      exec) drop_opts a ;;
      env) drop_opts uCS ;;
      nice) drop_opts n ;;
      timeout) drop_opts sk; words=("${words[@]:1}") ;; # and its duration
      xargs) drop_opts IdELnPsa; via_xargs=1 ;;
      stdbuf) drop_opts ioe ;;
      sudo) drop_opts ugpCDhrtTU ;;
      *)
        if [[ ${words[0]} =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then words=("${words[@]:1}"); else break; fi
        ;;
    esac
  done
  ((${#words[@]} || ${#cmd_redirs[@]})) || return 0
  here=${dir[depth]} name=${words[0]:-}
  name=${name##*/}
  if [[ $name =~ ^(ba|z|da|k)?sh$ ]] && shell_c_string "${words[@]:1}"; then
    # A child shell: its cd ends with it, like a subshell's. A deny inside exits 2.
    (lex_command "($REPLY"$'\n'")"; walk_commands "$here"; exit 0) || exit $?
  fi
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
  cmd_redirs=()
  for ((k = 0; k < ${#toks[@]}; k++)); do
    case ${kinds[k]} in
      W) cur+=("${toks[k]}"); continue ;;
      R) cmd_redirs+=("${toks[k]}"); continue ;;
    esac
    ((${#cur[@]} || ${#cmd_redirs[@]})) && visit_command "${cur[@]}"
    cur=() cmd_redirs=()
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
  ((${#cur[@]} || ${#cmd_redirs[@]})) && visit_command "${cur[@]}"
  return 0
}

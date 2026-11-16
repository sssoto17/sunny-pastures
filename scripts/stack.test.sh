#!/usr/bin/env bash
# Tests for stack.sh through its command line: real git against a throwaway bare remote, and a fake
# `gh` on PATH that keeps PRs and stacks as JSON files, shaped as GitHub's REST API returns them.
# It never reaches GitHub. Run: bash scripts/stack.test.sh (needs jq, git 2.38+)
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/stack.sh"
pass=0
fail=0

if ! command -v jq >/dev/null; then
  echo "jq is not installed: install it to run these tests" >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/stack-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
export GIT_CONFIG_GLOBAL=$work/gitconfig GIT_CONFIG_NOSYSTEM=1
git config --global user.name "stack test"
git config --global user.email "stack-test@example.invalid"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

# --- fake gh ----------------------------------------------------------------------------------
# State under $work/gh: pulls/<n>.json, stacks/<n>.json, next (the next number: PRs and stacks
# share it, as on GitHub) and calls (each call's arguments, one per line, then "--"). A file
# fail_<METHOD>_<endpoint with / as _> fails that call with its text. --jq runs through jq.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
st=$(dirname "$0")/../gh
for a in "$@"; do printf '%s\n' "$a"; done >>"$st/calls"
printf -- '--\n' >>"$st/calls"
[[ $1 == api ]] || { echo "fake: unexpected gh call: $*" >&2; exit 99; }
shift
method=GET endpoint="" filter="" input='{}'
while (($#)); do
  case $1 in
    -X | --method) method=$2; shift 2 ;;
    --jq | -q) filter=$2; shift 2 ;;
    -f | -F) # key=value into the JSON body; -F types a number; key[] appends to an array
      k=${2%%=*} v=${2#*=}
      if [[ $1 == -F && $v =~ ^[0-9]+$ ]]; then jv=$v; else jv=$(jq -n --arg v "$v" '$v'); fi
      if [[ $k == *'[]' ]]; then
        input=$(jq --argjson v "$jv" --arg k "${k%'[]'}" '.[$k] += [$v]' <<<"$input")
      else
        input=$(jq --argjson v "$jv" --arg k "$k" '.[$k] = $v' <<<"$input")
      fi
      shift 2 ;;
    -*) echo "fake: unexpected flag $1" >&2; exit 98 ;;
    *) endpoint=$1; shift ;;
  esac
done
path=${endpoint%%\?*} query=""
[[ $endpoint == *\?* ]] && query=${endpoint#*\?}
key=${method}_${path//\//_}
if [[ -f $st/fail_$key ]]; then cat "$st/fail_$key" >&2; exit 1; fi
P=repos/sssoto17/sunny-pastures
next() { local n; n=$(cat "$st/next"); echo $((n + 1)) >"$st/next"; echo "$n"; }
pr() { cat "$st/pulls/$1.json"; }
stack_json() { # n -> the stack as GET stacks/<n> returns it, parts in order
  local s; s=$(cat "$st/stacks/$1.json")
  jq --slurpfile prs <(for n in $(jq -r '.prs[]' <<<"$s"); do pr "$n"; done) \
    '{number, base: {ref: .base}, open, pull_requests: [$prs[] | {number, state, merged_at,
      head: {ref: .head.ref, sha: .head.sha}, base: {ref: .base.ref}}]}' <<<"$s"
}
set_stack() { # n -> writes .stack on each of its open PRs
  local s i=0 size n; s=$(cat "$st/stacks/$1.json")
  size=$(jq '[.prs[] ] | length' <<<"$s")
  for n in $(jq -r '.prs[]' <<<"$s"); do
    i=$((i + 1))
    jq --argjson num "$1" --argjson pos "$i" --argjson size "$size" --arg base "$(jq -r .base <<<"$s")" \
      '.stack = {number: $num, position: $pos, size: $size, base: {ref: $base}}' \
      "$st/pulls/$n.json" >"$st/tmp" && mv "$st/tmp" "$st/pulls/$n.json"
  done
}
out=""
case "$method $path" in
  "GET $P/pulls")
    head=$(sed -n 's/.*head=[^:]*:\([^&]*\).*/\1/p' <<<"$query")
    out=$(for f in "$st"/pulls/*.json; do [[ -f $f ]] && cat "$f"; done |
      jq -s --arg h "$head" '[.[] | select(.state == "open" and .head.ref == $h)]') ;;
  "POST $P/pulls")
    n=$(next)
    sha=$(git rev-parse "refs/heads/$(jq -r .head <<<"$input")" 2>/dev/null || echo unknown)
    jq --argjson n "$n" --arg sha "$sha" '{number: $n, state: "open", merged_at: null, title, body,
      head: {ref: .head, sha: $sha}, base: {ref: .base}, stack: null}' <<<"$input" >"$st/pulls/$n.json"
    out=$(pr "$n") ;;
  "GET $P/pulls/"*)
    n=${path#"$P"/pulls/}
    [[ -f $st/pulls/$n.json ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    out=$(pr "$n") ;;
  "POST $P/stacks")
    prs=$(jq -c .pull_requests <<<"$input")
    (($(jq length <<<"$prs") >= 2)) || { echo "gh: 2 items required (HTTP 422)" >&2; exit 1; }
    base=$(jq -r ".base.ref" "$st/pulls/$(jq '.[0]' <<<"$prs").json")
    n=$(next)
    jq -n --argjson n "$n" --argjson prs "$prs" --arg base "$base" \
      '{number: $n, base: $base, open: true, prs: $prs}' >"$st/stacks/$n.json"
    set_stack "$n"
    out=$(stack_json "$n") ;;
  "GET $P/stacks/"*)
    n=${path#"$P"/stacks/}
    [[ -f $st/stacks/$n.json ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    out=$(stack_json "$n") ;;
  *) echo "fake: unexpected endpoint $method $endpoint" >&2; exit 97 ;;
esac
if [[ -n $filter ]]; then jq -r "$filter" <<<"$out"; else printf '%s\n' "$out"; fi
FAKE
chmod +x "$work/bin/gh"
# A git on PATH that records each push's arguments, then runs the real git.
printf '#!/usr/bin/env bash\n[[ $1 == push ]] && printf "%%s\\n" "$*" >>"%s/pushes"\nexec "%s" "$@"\n' \
  "$work" "$(command -v git)" >"$work/bin/git"
chmod +x "$work/bin/git"

# --- fixtures ---------------------------------------------------------------------------------
# A bare remote with main, and a clone in $repo where the parts are built. The fake gh resolves a
# PR's head SHA from the clone, so it runs with the clone as its working directory.
reset() {
  rm -rf "$work/pushes" "$work/gh" "$work/remote.git" "$work/repo" "$work/bodies"
  mkdir -p "$work/gh/pulls" "$work/gh/stacks" "$work/bodies"
  echo 400 >"$work/gh/next"
  git init -q --bare "$work/remote.git"
  git init -q "$work/repo"
  repo=$work/repo
  git -C "$repo" remote add origin "$work/remote.git"
  echo base >"$repo/README"
  git -C "$repo" add README
  git -C "$repo" commit -qm "base"
  git -C "$repo" push -q origin main
}
part() { # branch from file [content] -> commits file on a new branch made from <from>
  git -C "$repo" branch -q "$1" "$2"
  git -C "$repo" switch -q "$1"
  echo "${4:-$1}" >"$repo/$3"
  git -C "$repo" add "$3"
  git -C "$repo" commit -qm "$1: $3"
}
body() { # name title -> a body file whose first line is the title
  printf '%s\n\nPart of #264.\n' "$2" >"$work/bodies/$1.md"
  printf '%s' "$work/bodies/$1.md"
}
three_parts() {
  part p1 main a.txt
  part p2 p1 b.txt
  part p3 p2 c.txt
}
pr_field() { jq -r "$2" "$work/gh/pulls/$1.json"; }

run() { # args... -> sets code, out, err, calls
  out=$(cd "$repo" && PATH="$work/bin:$PATH" bash "$script" "$@" 2>"$work/err")
  code=$?
  err=$(cat "$work/err")
  calls=$(cat "$work/gh/calls" 2>/dev/null || true)
}

ok() { pass=$((pass + 1)); }
bad() { # message
  fail=$((fail + 1))
  printf 'FAIL: %s\n  args: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n' \
    "$1" "${args[*]-}" "$code" "$out" "$err"
}
assert() { # message command...
  if "${@:2}"; then ok; else bad "$1"; fi
}
contains() { [[ $1 == *"$2"* ]]; }
expect_code() { assert "expected exit $1" test "$code" -eq "$1"; }
expect_err() { assert "expected stderr to contain: $1" contains "$err" "$1"; }
expect_out() { assert "expected stdout to contain: $1" contains "$out" "$1"; }
expect_eq() { # message actual expected
  if [[ $2 == "$3" ]]; then ok; else bad "$1: expected '$3', got '$2'"; fi
}
call_lines() { awk '$0 == "--" { print line; line = ""; next } { line = line (line == "" ? "" : " ") $0 }' <<<"$calls"; }
has_call() { local lines; lines=$(call_lines); grep -qF -- "$1" <<<"$lines"; }
expect_no_call() { if has_call "$1"; then bad "expected no gh call containing: $1"; else ok; fi; }
expect_call() { if has_call "$1"; then ok; else bad "expected a gh call containing: $1"; fi; }
remote_sha() { git -C "$work/remote.git" rev-parse -q --verify "refs/heads/$1" || echo none; }
case_() { args=("$@"); run "$@"; }

# --- usage ------------------------------------------------------------------------------------
reset
case_ --help
expect_code 0
expect_err "usage:"
case_
expect_code 2
expect_err "usage:"
case_ frobnicate
expect_code 2
expect_err "unknown command"

# --- open: creates each PR on the part below, then the native stack ----------------------------
reset
three_parts
case_ open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')" p3="$(body p3 'feat: three')"
expect_code 0
expect_eq "p1 pushed" "$(remote_sha p1)" "$(git -C "$repo" rev-parse p1)"
expect_eq "p3 pushed" "$(remote_sha p3)" "$(git -C "$repo" rev-parse p3)"
expect_eq "part 1 on main" "$(pr_field 400 .base.ref)" main
expect_eq "part 2 on part 1" "$(pr_field 401 .base.ref)" p1
expect_eq "part 3 on part 2" "$(pr_field 402 .base.ref)" p2
expect_eq "title from the body file's first line" "$(pr_field 401 .title)" "feat: two"
expect_eq "body without the title line" "$(pr_field 401 .body)" "Part of #264."
expect_eq "stack holds the parts in order" "$(jq -c .prs "$work/gh/stacks/403.json")" "[400,401,402]"
expect_eq "part 3 knows its position" "$(pr_field 402 .stack.position)" 3
expect_out "stack #403"
# the push never forces and never sets an upstream
assert "pushed" test -s "$work/pushes"
assert "no forced push" bash -c "! grep -qE -- ' (-f|--force[^ ]*|\+[^ ]+)( |$)' '$work/pushes'"
assert "no upstream recorded" test -z "$(git -C "$repo" config --get branch.p1.remote)"

# open again: reuses the PRs and the stack, creates nothing
case_ open p1="$work/bodies/p1.md" p2="$work/bodies/p2.md" p3="$work/bodies/p3.md"
expect_code 0
expect_eq "no new PR or stack" "$(cat "$work/gh/next")" 404
expect_out "stack #403"

# --- open: refusals change nothing ---------------------------------------------------------------
reset
three_parts
case_ open p1="$(body p1 'feat: one')"
expect_code 2
expect_err "at least 2 parts"
reset
part p1 main a.txt
part p2 main b.txt # not on top of p1: a hand-made chain the stack can't hold
case_ open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
expect_code 2
expect_err "p2 is not built on p1"
expect_eq "nothing pushed" "$(remote_sha p1)" none
expect_eq "no PR" "$(cat "$work/gh/next")" 400
reset
part p1 main a.txt
git -C "$repo" branch -q p2 p1 # no commit of its own
case_ open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
expect_code 2
expect_err "p2 has no commits of its own"
reset
three_parts
# an open PR for a part on another base is a hand-chained PR: refuse rather than stack it
git -C "$repo" push -q origin p1 p2
printf '{"number":390,"state":"open","head":{"ref":"p2","sha":"x"},"base":{"ref":"main"},"stack":null}' \
  >"$work/gh/pulls/390.json"
case_ open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
expect_code 2
expect_err "#390 already has p2 on main"
expect_eq "no PR created" "$(cat "$work/gh/next")" 400

# a failed stack call leaves the PRs and says how to retry
reset
three_parts
echo "gh: Forbidden (HTTP 403)" >"$work/gh/fail_POST_repos_sssoto17_sunny-pastures_stacks"
case_ open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
expect_code 1
expect_err "PRs #400 #401 are open but not stacked"
expect_err "run the same command again"
rm "$work/gh/fail_POST_repos_sssoto17_sunny-pastures_stacks"
case_ open p1="$work/bodies/p1.md" p2="$work/bodies/p2.md"
expect_code 0
expect_eq "retry stacks the same PRs" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401]"

# no merge, ever: the script has no command that merges, and no call to a merge endpoint
assert "no merge endpoint in the script" bash -c "! grep -qE '/merge|unstack' '$script'"

echo "stack.test.sh: $pass passed, $fail failed"
((fail == 0))

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
# reviews_<n>.json and checks_<sha>.json are canned reviews and check runs.
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
  "GET $P/pulls/"*/reviews)
    n=${path#"$P"/pulls/}; n=${n%/reviews}
    out=$(cat "$st/reviews_$n.json" 2>/dev/null || echo '[]') ;;
  "GET $P/pulls/"*)
    n=${path#"$P"/pulls/}
    [[ -f $st/pulls/$n.json ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    out=$(pr "$n") ;;
  "GET $P/commits/"*/check-runs)
    sha=${path#"$P"/commits/}; sha=${sha%/check-runs}
    out=$(cat "$st/checks_$sha.json" 2>/dev/null || echo '{"total_count":0,"check_runs":[]}') ;;
  "POST $P/issues/"*/labels)
    out='[]' ;;
  "POST $P/stacks")
    prs=$(jq -c .pull_requests <<<"$input")
    (($(jq length <<<"$prs") >= 2)) || { echo "gh: 2 items required (HTTP 422)" >&2; exit 1; }
    base=$(jq -r ".base.ref" "$st/pulls/$(jq '.[0]' <<<"$prs").json")
    n=$(next)
    jq -n --argjson n "$n" --argjson prs "$prs" --arg base "$base" \
      '{number: $n, base: $base, open: true, prs: $prs}' >"$st/stacks/$n.json"
    set_stack "$n"
    out=$(stack_json "$n") ;;
  "POST $P/stacks/"*/add)
    n=${path#"$P"/stacks/}; n=${n%/add}
    jq --argjson add "$(jq -c .pull_requests <<<"$input")" '.prs += $add' "$st/stacks/$n.json" >"$st/tmp" &&
      mv "$st/tmp" "$st/stacks/$n.json"
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

# --- fixtures ---------------------------------------------------------------------------------
# A bare remote with main, and a clone in $repo where the parts are built. The fake gh resolves a
# PR's head SHA from the clone, so it runs with the clone as its working directory.
reset() {
  rm -rf "$work/gh" "$work/remote.git" "$work/repo" "$work/bodies"
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
case_ open --label review:admin p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')" p3="$(body p3 'feat: three')"
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
expect_call "api -X POST repos/sssoto17/sunny-pastures/issues/402/labels -f labels[]=review:admin"
expect_out "stack #403"
# the push never forces and never sets an upstream
expect_no_call "--force"
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
printf '\n' >"$work/bodies/empty.md"
case_ open p1="$(body p1 'feat: one')" p2="$work/bodies/empty.md"
expect_code 2
expect_err "no title"
case_ open p1="$(body p1 'feat: one')" p2="$work/bodies/missing.md"
expect_code 2
expect_err "can't read"
case_ open p1="$(body p1 'feat: one')" nosuch="$(body p2 'feat: two')"
expect_code 2
expect_err "no local branch nosuch"
# an open PR for a part on another base is a hand-chained PR: refuse rather than stack it
reset
three_parts
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

# --- add: appends a part on the top open part ----------------------------------------------------
reset
three_parts
run open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
case_ add 401 p3="$(body p3 'feat: three')"
expect_code 0
expect_eq "new part on the top part" "$(pr_field 403 .base.ref)" p2
expect_eq "appended to the stack" "$(jq -c .prs "$work/gh/stacks/402.json")" "[400,401,403]"
reset
three_parts
run open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
part p4 p1 d.txt
case_ add 400 p4="$(body p4 'feat: four')"
expect_code 2
expect_err "p4 is not built on p2"
case_ add 999 p3="$(body p3 'feat: three')"
expect_code 1
expect_err "#999"
reset
part p1 main a.txt
git -C "$repo" push -q origin p1
printf '{"number":390,"state":"open","head":{"ref":"p1","sha":"x"},"base":{"ref":"main"},"stack":null}' \
  >"$work/gh/pulls/390.json"
part p2 p1 b.txt
case_ add 390 p2="$(body p2 'feat: two')"
expect_code 2
expect_err "#390 is not in a stack"

# --- update: an edit to a lower part merges upward, never force-pushed ---------------------------
reset
three_parts
run open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')" p3="$(body p3 'feat: three')"
git -C "$repo" switch -q p1
echo fix >"$repo/a.txt"
git -C "$repo" commit -qam "p1: fix"
git -C "$repo" switch -q p3 # p3 checked out: merged in place; p2 isn't checked out anywhere
case_ update 402
expect_code 0
assert "p2 has the fix" git -C "$repo" merge-base --is-ancestor p1 p2
assert "p3 has the fix" git -C "$repo" merge-base --is-ancestor p2 p3
expect_eq "p3's working tree has the fix" "$(cat "$repo/a.txt")" fix
expect_eq "p2 is a merge, not a rewrite" "$(git -C "$repo" rev-list --parents -n1 p2 | wc -w)" 3
expect_eq "p1 pushed" "$(remote_sha p1)" "$(git -C "$repo" rev-parse p1)"
expect_eq "p3 pushed" "$(remote_sha p3)" "$(git -C "$repo" rev-parse p3)"
case_ update 402
expect_code 0
expect_out "up to date"
# a conflict stops before any push
reset
part p1 main a.txt
part p2 p1 a.txt "two"
run open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
git -C "$repo" switch -q p1
echo "one changed" >"$repo/a.txt"
git -C "$repo" commit -qam "p1: change"
before=$(remote_sha p1)
case_ update 400
expect_code 2
expect_err "p1 into p2 conflicts"
expect_eq "nothing pushed" "$(remote_sha p1)" "$before"

# --- refresh: follow GitHub's restack after a lower part merged ---------------------------------
reset
three_parts
run open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')" p3="$(body p3 'feat: three')"
# GitHub merges #400 (squash) and rebases p2 and p3 onto main, then retargets #401 to main
git -C "$repo" switch -q --detach main
git -C "$repo" merge -q --squash p1 && git -C "$repo" commit -qm "feat: one (#400)"
git -C "$repo" push -q origin HEAD:main
git -C "$repo" cherry-pick "$(git -C "$repo" rev-parse p2)" >/dev/null && git -C "$repo" push -q -f origin HEAD:p2
git -C "$repo" cherry-pick "$(git -C "$repo" rev-parse p3)" >/dev/null && git -C "$repo" push -q -f origin HEAD:p3
jq '.state = "closed" | .merged_at = "2026-11-16T12:00:00Z"' "$work/gh/pulls/400.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/400.json"
jq '.base.ref = "main"' "$work/gh/pulls/401.json" >"$work/t" && mv "$work/t" "$work/gh/pulls/401.json"
git -C "$repo" switch -q p3
case_ refresh 402
expect_code 0
expect_eq "p2 follows the rebased remote" "$(git -C "$repo" rev-parse p2)" "$(remote_sha p2)"
expect_eq "p3 (checked out) follows it too" "$(git -C "$repo" rev-parse HEAD)" "$(remote_sha p3)"
expect_out "#400"
expect_out "merged"
# a local commit made before the restack stops refresh for that branch, and nothing moves
reset
three_parts
run open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
git -C "$repo" fetch -q origin
git -C "$repo" switch -q p2
echo local >"$repo/l.txt" && git -C "$repo" add l.txt && git -C "$repo" commit -qm "p2: local only"
local_p2=$(git -C "$repo" rev-parse p2)
git -C "$repo" switch -q --detach main
git -C "$repo" commit -q --allow-empty -m "elsewhere"
git -C "$repo" cherry-pick "$(git -C "$repo" rev-parse origin/p2)" >/dev/null && git -C "$repo" push -q -f origin HEAD:p2
case_ refresh 401
expect_code 2
expect_err "p2 has commits GitHub's restack doesn't have"
expect_err "p2: local only"
expect_eq "p2 untouched" "$(git -C "$repo" rev-parse p2)" "$local_p2"

# --- status: each part with its base, approvals and checks ---------------------------------------
reset
three_parts
run open p1="$(body p1 'feat: one')" p2="$(body p2 'feat: two')"
printf '[{"user":{"login":"sunny-reviewer[bot]"},"state":"CHANGES_REQUESTED"},{"user":{"login":"sunny-reviewer[bot]"},"state":"APPROVED"}]' \
  >"$work/gh/reviews_400.json"
printf '{"total_count":2,"check_runs":[{"name":"ci / test","status":"completed","conclusion":"success"},{"name":"guard / floor","status":"completed","conclusion":"failure"}]}' \
  >"$work/gh/checks_$(git -C "$repo" rev-parse p1).json"
rm -f "$work/gh/calls"
case_ status 401
expect_code 0
expect_out "stack #402 on main"
expect_out "1/2 #400"
expect_out "approved"
expect_out "failing: guard / floor"
expect_out "2/2 #401"
expect_out "base p1"
# status never writes
expect_no_call "-X POST"
expect_no_call "-X PATCH"
# no merge, ever: the script has no command that merges, and no call to a merge endpoint
assert "no merge endpoint in the script" bash -c "! grep -qE '/merge|unstack' '$script'"

echo "stack.test.sh: $pass passed, $fail failed"
((fail == 0))

#!/usr/bin/env bash
# Posts sunny-reviewer's review of one PR from Claude's JSON verdict (review.yml, ADR-0002 area 2).
# The verdict is data: this script, not the model, decides the review's event. It reviews and
# approves on the code alone (#566): it approves when the verdict has no Required finding and none
# of its earlier finding threads is still open, whoever opened the PR, escalated or not. The admin's
# gate is `guard / code-owned` plus review:admin, never a withheld approval ("Solo-admin approvals",
# #495). Escalation is a label: when a row of CONSTRAINTS.md "Escalation criteria" applies and the
# PR doesn't carry review:admin, it adds the label, then one plain PR comment `escalated: <rows>`,
# before it posts any review. No review thread, no finding and no withheld approval for a missed
# row, and its escalation threads from before #566 are neither memory nor reopened. After an
# approval it turns on auto-merge (squash) for the reviewed head, and when it doesn't approve it
# turns off auto-merge that is on (ADR-0002 area 2, flow step 3); on the run that added the label it
# leaves auto-merge off too, since `guard / code-owned` hasn't read the label yet. It never merges:
# with the repo's allow_auto_merge off, GitHub refuses, and the review still stands (Q16). On a
# part of a native stack below its top open part, it never leaves auto-merge on (auto_merge=stacked):
# a part based on anything but DEFAULT_BRANCH (#404) would merge into the part below, and part 1 on
# DEFAULT_BRANCH would merge alone, untested, since only the top part runs typecheck, lint and test
# (#695). The live GET pulls/<n> names the stack, and GET stacks/<n> its open parts; a stack it
# can't read, or one that doesn't list the PR, counts as one with a part above. A stack merges
# whole.
# Tests: .github/scripts/tests/post-review.test.mjs.
#
# HEAD, BASE, BASE_SHA, RESTORED and VERDICT are review.yml's hand-off from the job that ran the
# model (#454), so every one is checked before it is used. `--check` runs only those checks, which
# need no token and no network, and stops: review.yml's post job runs it before it mints the App's
# token, and the full run checks them again.
#
# Env: GH_TOKEN (the App's token), GITHUB_REPOSITORY, PR, HEAD (the reviewed head SHA), BOT (the
# App's slug), ADMIN, FACTORY_APP (the factory App's slug), CTX (holds files.json), VERDICT,
# THREADS_QUERY, RUNNER_TEMP, DEFAULT_BRANCH, BASE and BASE_SHA (the base gather judged), RESTORED
# (the commit origin/<base> pointed at after claude-code-action's fetch, or "none"); CODEOWNERS
# (default .github/CODEOWNERS, main's copy).
# shellcheck disable=SC2016 # single-quoted jq programs, by design
set -euo pipefail

: "${DEFAULT_BRANCH:?}" "${BASE:?}" # a missing one must not read as "every PR is a stacked part"
# A commit SHA, or nothing is posted. The live head is compared with it below as well.
if [[ ! ${HEAD-} =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::the reviewed head isn't a commit SHA: nothing posted"
  exit 1
fi
# A stacked part (#404): claude-code-action fetched origin/<base> and restored config from it
# after gather's gate read the base's files at BASE_SHA; the model's job recorded that commit as
# RESTORED. If the part below moved in between, the review ran with config the gate never saw:
# nothing is posted, and the run fails so it shows. Both must be the same commit SHA, so two empty
# values never pass, and the base a name of git's plainest characters, as the gate requires.
if [[ $BASE != "$DEFAULT_BRANCH" ]]; then
  if [[ ! $BASE =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "::error::the base isn't a plain branch name: nothing posted"
    exit 1
  fi
  restored=${RESTORED:-none} gate_sha=${BASE_SHA:-unknown}
  if [[ ! ${BASE_SHA-} =~ ^[0-9a-f]{40}$ || $restored != "$BASE_SHA" ]]; then
    echo "::error::the action restored config from $BASE at ${restored//[^0-9a-z]/%}, not ${gate_sha//[^0-9a-z]/%} as the gate read: nothing posted"
    exit 1
  fi
fi
v="$RUNNER_TEMP/verdict.json"
printf '%s' "$VERDICT" >"$v"
# The whole shape, or nothing is posted: a missing or null field must never read as "none".
valid='def strings(nonempty): type == "array" and all(.[]; type == "string" and (if nonempty then test("\\S") else true end));
  type == "object" and (.summary | type == "string") and (.escalation_path | type == "string")
  and (.escalation_rows | strings(true)) and (.resolve_threads | strings(false))
  and (.findings | type == "array" and all(.[]; type == "object" and (.path | type == "string")
    and (.line | type == "number") and (.body | type == "string")))'
if ! jq -e "$valid" "$v" >/dev/null 2>&1; then
  echo "::error::the verdict doesn't match .github/review-verdict.schema.json: nothing posted"
  exit 1
fi
# A verdict that quotes a credential is never posted.
if grep -qE 'sk-ant-|gh[opsu]_[A-Za-z0-9]{20}|github_pat_|-----BEGIN' "$v"; then
  echo "::error::the verdict looks like it holds a credential: nothing posted"
  exit 1
fi
if [[ ${1-} == --check ]]; then
  echo "CHECK ok: the hand-off is well formed"
  exit 0
fi
r="repos/$GITHUB_REPOSITORY" t="$RUNNER_TEMP/threads.json"
# The live read, as review-gate.sh's (gather's) and `guard / stack-base`'s: its `stack` names the
# native stack the PR is in, part 1 on main included, or is null outside one (#695).
now=$(gh api "$r/pulls/$PR" --jq '[.head.sha, .user.login, .node_id, (.auto_merge != null), .base.ref,
  (if .stack == null then "none" else (.stack.number // "unknown") end)] | @tsv')
IFS=$'\t' read -r head_now author node auto_on base_ref stack <<<"$now"
if [[ $head_now != "$HEAD" ]]; then
  echo "the head moved to $head_now: the newer run reviews it"
  exit 0
fi

comment() { # path body [line]: one review comment on the head, on a line or the whole file
  local where=(-f subject_type=file)
  [[ -z ${3-} ]] || where=(-F line="$3" -f side=RIGHT)
  gh api -X POST "$r/pulls/$PR/comments" --silent -f commit_id="$HEAD" -f path="$1" \
    "${where[@]}" -f body="$2" 2>/dev/null
}
threads() {
  gh api graphql -F owner="${GITHUB_REPOSITORY%/*}" -F name="${GITHUB_REPOSITORY#*/}" \
    -F pr="$PR" -f query="$THREADS_QUERY" --jq '.data.repository.pullRequest.reviewThreads.nodes' >"$t"
}
set_auto() { # enable|disable: auto-merge, never a merge. Only GraphQL has it; `gh pr merge
  # --auto` merges at once when the PR is already mergeable, whatever allow_auto_merge says.
  if [[ $1 == enable ]]; then
    gh api graphql --silent -f id="$node" -f head="$HEAD" -f query='mutation($id: ID!, $head: GitObjectID!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $head, mergeMethod: SQUASH}) { clientMutationId } }'
  else
    gh api graphql --silent -f id="$node" -f query='mutation($id: ID!) {
      disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }'
  fi
}
# Threads this App started (GraphQL logins carry no [bot]; a deleted user's author is null). An
# escalation thread (first line `escalated:`) is one it posted before #566: never a finding, and
# never touched again (ADR-0002, "Solo-admin approvals", decision 6).
defs='def own: ((.comments.nodes[0].author.login // "") | sub("\\[bot\\]$"; "")) == $bot;
  def esc: (.comments.nodes[0].body // "") | startswith("escalated:");
  def fixed: .id as $i | ($v[0].resolve_threads // []) | index($i) != null;
  def open_finding: own and (esc | not) and (.isResolved | not);'
pick() { jq -r --arg bot "$BOT" --slurpfile v "$v" "$defs $1" "$t"; }
part_above() { # true when another open part sits above this PR in its stack, else false (#695).
  # GET stacks/<n> lists the parts bottom to top, closed and merged ones included (stack #693).
  # In doubt, true: a stack it can't read, or one that doesn't list this PR, keeps auto-merge off.
  local n
  [[ $stack =~ ^[0-9]+$ && $PR =~ ^[0-9]+$ ]] || { echo true; return; }
  n=$(gh api "$r/stacks/$stack" 2>/dev/null | jq --argjson pr "$PR" '.pull_requests
    | (map(.number) | index($pr)) as $i
    | if $i == null then -1 else [.[$i + 1:][] | select(.state == "open")] | length end') || n=-1
  if [[ $n == 0 ]]; then echo false; else echo true; fi
}

labelled=$(gh api "$r/issues/$PR/labels" --jq 'any(.[]; .name == "review:admin")')
# The rows that depend only on paths are computed here as well, so a verdict can't drop them
# (CONSTRAINTS.md, "Escalation criteria"). Code-owned path: a changed path, or a rename's old path,
# matches a pattern in CODEOWNERS (gitignore rules). Content change: a file under
# packages/sim/src/content/ other than its tests; a path can't show whether a value changed, so
# this errs towards the admin. Every other row needs reading, so it stays the verdict's.
path_rows=$(jq -rn --rawfile co "${CODEOWNERS:-.github/CODEOWNERS}" --slurpfile f "$CTX/files.json" '
  def rx: (endswith("/")) as $dir | (ltrimstr("/") | rtrimstr("/")) as $b
    | (startswith("/") or ($b | contains("/"))) as $anchored
    | $b | gsub("(?<c>[.+^$(){}|\\[\\]\\\\])"; "\\\(.c)")
    | gsub("\\*\\*/"; "\u0001") | gsub("\\*\\*"; "\u0002") | gsub("\\*"; "[^/]*") | gsub("\\?"; "[^/]")
    | gsub("\u0001"; "(.*/)?") | gsub("\u0002"; ".*")
    | (if $anchored then "^" else "(^|/)" end) + . + (if $dir then "/" else "(/|$)" end);
  [$co | split("\n")[] | sub("#.*"; "") | [splits("\\s+")] | map(select(length > 0))
    | select(length > 1) | .[0] | rx] as $owned
  | [$f[0][] | .filename, (.previous_filename // empty)] as $paths
  | (if any($paths[]; . as $p | any($owned[]; . as $r | $p | test($r))) then "Code-owned path" else empty end),
    (if any($paths[]; test("^packages/sim/src/content/") and (test("/tests/") | not)) then "Content change" else empty end)')
rows=$({ jq -r '.escalation_rows[]' "$v"; printf '%s\n' "$path_rows"; } | awk 'NF && !seen[$0]++' | paste -sd, - | sed 's/,/, /g')
nfind=$(jq '.findings | length' "$v")

threads
# Fixed findings: only this App's own open threads that aren't escalations.
ids=$(pick '.[] | select(open_finding and fixed) | .id')
for id in $ids; do
  gh api graphql --silent -F id="$id" \
    -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }'
done
still_open=$(pick '[.[] | select(open_finding and (fixed | not))] | length')

# Escalation, before any review (#566): the label first, so no approval lands on a PR the bot
# escalated without it; a failed add stops the run here (set -e) and posts nothing. Then one plain
# comment that names the rows: the tuning data (CONSTRAINTS.md), not a gate, so a failed comment
# only warns. Neither is posted again while the label is on; each review's body names the rows.
added=false
if [[ -n $rows && $labelled != true ]]; then
  gh api -X POST "$r/issues/$PR/labels" --silent -f 'labels[]=review:admin'
  added=true
  body="escalated: $rows"$'\n\n'"sunny-reviewer added \`review:admin\`: this PR meets the rows above"
  body+=' (CONSTRAINTS.md, "Escalation criteria"). `guard / code-owned` holds it until the admin'
  body+=" removes the label on its head. The review itself is on the code alone."
  gh api -X POST "$r/issues/$PR/comments" --silent -f body="$body" ||
    echo "::warning::review:admin added, but the escalation comment wasn't posted: $rows"
fi
# The admin's queue on a factory PR (#37): GitHub requests no review of a PR's own author.
if [[ -n $rows && $author == "${FACTORY_APP}[bot]" ]]; then
  gh api -X POST "$r/pulls/$PR/requested_reviewers" --silent -f "reviewers[]=$ADMIN"
fi
escalated=false
[[ -z $rows && $labelled != true ]] || escalated=true

# Required findings: a line comment, else a file comment, else listed in the review's body.
unplaced=""
while IFS= read -r f; do
  path=$(jq -r '.path // ""' <<<"$f") line=$(jq -r '.line // 0' <<<"$f") body=$(jq -r '.body // ""' <<<"$f")
  # "escalated:" marks its old escalation threads, which no finding may pass for (open_finding).
  [[ ! $body =~ ^[[:space:]]*escalated: ]] || body="Finding: $body"
  [[ $line =~ ^[0-9]+$ ]] || line=0
  if ((line > 0)) && comment "$path" "$body" "$line"; then continue; fi
  if [[ -n $path ]] && comment "$path" "Line $line: $body"; then continue; fi
  unplaced+="- ${path:-(no file)}:$line $body"$'\n'
done < <(jq -c '.findings[]' "$v")

event=APPROVE
if ((nfind > 0)) || [[ -n $unplaced ]]; then
  event=REQUEST_CHANGES
elif ((still_open > 0)); then
  event=COMMENT # its Request changes stands until the finding thread is fixed
fi
# A later COMMENT doesn't replace an APPROVE, so an earlier approval of its own that no longer
# holds is dismissed, and auto-merge must not outlive it.
if [[ $event != APPROVE ]]; then
  reviews=$(gh api --paginate "$r/pulls/$PR/reviews?per_page=100")
  ids=$(jq -r --arg u "${BOT}[bot]" '.[] | select(.user.login == $u and .state == "APPROVED") | .id' <<<"$reviews")
  for id in $ids; do
    gh api -X PUT "$r/pulls/$PR/reviews/$id/dismissals" --silent -f event=DISMISS \
      -f message="This review no longer approves the PR: $event."
  done
  if [[ $auto_on == true ]] && ! set_auto disable; then
    echo "::warning::auto-merge is still on: turn it off by hand (gh pr merge $PR --disable-auto)"
  fi
fi
body=$(jq -r .summary "$v")
[[ -z $unplaced ]] || body+=$'\n\nRequired findings without a place in the diff:\n'"$unplaced"
((still_open == 0)) || body+=$'\n\n'"$still_open earlier finding thread(s) still open."
[[ -z $rows ]] || body+=$'\n\n'"Escalation rows (CONSTRAINTS.md): $rows. \`review:admin\` holds the PR."
gh api -X POST "$r/pulls/$PR/reviews" --silent -f commit_id="$HEAD" -f event="$event" -f body="$body"
auto=off
held=false # a part of a native stack below its top open part, on main or not (#695)
if [[ $event == APPROVE && $base_ref != "$DEFAULT_BRANCH" ]]; then
  held=true
elif [[ $event == APPROVE && $stack != none ]]; then
  held=$(part_above)
fi
if [[ $event == APPROVE && ($held == true || $added == true) ]]; then
  # A stacked part never auto-merges: above part 1 it would merge into the part below, and part 1
  # on main would merge alone, its typecheck, lint and test skipped for the top part's run (#695);
  # a stack merges whole, in one action. On the run that just added the label,
  # `guard / code-owned` may still read green until its `labeled` run finishes, so auto-merge waits
  # for a later head; the admin merges after the sign-off.
  auto=stacked
  [[ $added != true ]] || auto=escalated
  if [[ $auto_on == true ]] && ! set_auto disable; then
    echo "::warning::auto-merge is on ($auto): turn it off by hand (gh pr merge $PR --disable-auto)"
  fi
elif [[ $event == APPROVE ]]; then
  # Refused while allow_auto_merge is off (or the PR merges as it is): the approval stands.
  if [[ $auto_on == true ]] || set_auto enable 2>/dev/null; then auto=on; else auto=refused; fi
fi
echo "RESULT event=$event findings=$nfind still_open=$still_open escalated=$escalated label_added=$added auto_merge=$auto stack=${stack//[^0-9a-z]/%}"

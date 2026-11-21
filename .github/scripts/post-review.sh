#!/usr/bin/env bash
# Posts sunny-reviewer's review of one PR from Claude's JSON verdict (review.yml, ADR-0002 area 2).
# The verdict is data: this script, not the model, decides the review's event. It approves only
# when the verdict has no Required finding, the PR doesn't carry review:admin (until #104) and none
# of its earlier finding threads is still open. An escalated PR (an escalation row, or an
# escalation thread of its own) it approves only when the admin's account opened it and its
# escalation thread is open on the PR, which then alone holds the merge; on one an App opened it
# withholds (ADR-0002 area 2, #264, #322). After an approval it turns on auto-merge (squash) for
# the reviewed head, and when it doesn't approve it turns off auto-merge that is on (ADR-0002 area
# 2, flow step 3). It never merges: with the repo's allow_auto_merge off, GitHub refuses, and the
# review still stands (Q16). On a PR based on anything but DEFAULT_BRANCH, a stacked part (#404), it
# never leaves auto-merge on: that would merge the part into the part below, and a stack merges whole.
# Tests: .github/scripts/tests/post-review.test.mjs.
#
# Env: GH_TOKEN (the App's token), GITHUB_REPOSITORY, PR, HEAD (the reviewed head SHA), BOT (the
# App's slug), ADMIN, FACTORY_APP (the factory App's slug), CTX (holds files.json), VERDICT,
# THREADS_QUERY, RUNNER_TEMP, DEFAULT_BRANCH, BASE and BASE_SHA (the base gather judged); CODEOWNERS
# (default .github/CODEOWNERS, main's copy).
# shellcheck disable=SC2016 # single-quoted jq programs, by design
set -euo pipefail

: "${DEFAULT_BRANCH:?}" "${BASE:?}" # a missing one must not read as "every PR is a stacked part"
# A stacked part (#404): claude-code-action fetched origin/<base> and restored config from it
# after gather's gate read the base's files at BASE_SHA. If the part below moved in between, the
# review ran with config the gate never saw: nothing is posted, and the run fails so it shows.
if [[ $BASE != "$DEFAULT_BRANCH" ]]; then
  restored=$(git rev-parse --verify --quiet "refs/remotes/origin/$BASE^{commit}") || restored=none
  if [[ $restored != "${BASE_SHA-}" ]]; then
    echo "::error::the action restored config from $BASE at $restored, not ${BASE_SHA:-unknown} as the gate read: nothing posted"
    exit 1
  fi
fi
r="repos/$GITHUB_REPOSITORY" v="$RUNNER_TEMP/verdict.json" t="$RUNNER_TEMP/threads.json"
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
now=$(gh api "$r/pulls/$PR" --jq '[.head.sha, .user.login, .node_id, (.auto_merge != null), .user.type, .base.ref] | @tsv')
IFS=$'\t' read -r head_now author node auto_on author_type base_ref <<<"$now"
if [[ $head_now != "$HEAD" ]]; then
  echo "the head moved to $head_now: the newer run reviews it"
  exit 0
fi

has_label() { gh api "$r/issues/$PR/labels" --jq 'any(.[]; .name == "review:admin")'; }
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
set_thread() { # mutation id
  gh api graphql --silent -F id="$2" \
    -f query="mutation(\$id: ID!) { $1(input: {threadId: \$id}) { thread { id } } }"
}
# Threads this App started (GraphQL logins carry no [bot]; a deleted user's author is null), and
# which of them are escalations.
defs='def own: ((.comments.nodes[0].author.login // "") | sub("\\[bot\\]$"; "")) == $bot;
  def esc: (.comments.nodes[0].body // "") | startswith("escalated:");'
pick() { jq -r --arg bot "$BOT" --arg admin "$ADMIN" --slurpfile v "$v" "$defs $1" "$t"; }

labelled=$(has_label)
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
# Only the admin clears an escalation: a thread anyone else resolved is reopened.
ids=$(pick '.[] | select(own and esc and .isResolved and .resolvedBy.login != $admin) | .id')
for id in $ids; do set_thread unresolveReviewThread "$id"; done
# Fixed findings: only this App's own open threads that aren't escalations.
defs+=' def fixed: .id as $i | ($v[0].resolve_threads // []) | index($i) != null;
  def open_finding: own and (esc | not) and (.isResolved | not);'
ids=$(pick '.[] | select(open_finding and fixed) | .id')
for id in $ids; do set_thread resolveReviewThread "$id"; done
# Its escalation threads are its memory: one on the PR keeps the PR escalated (ADR-0002).
escalated_before=$(pick 'any(.[]; own and esc)')
still_open=$(pick '[.[] | select(open_finding and (fixed | not))] | length')
needs_admin=false # an escalation row now, or an escalation thread of its own from before
[[ -z $rows && $escalated_before != true ]] || needs_admin=true
# An escalation thread of its own still open (one someone else resolved was reopened above) holds
# the merge. Once the admin resolved it, nothing holds the PR any more, so no run after that
# approves it: not a later head, and not a re-review of the same head either (review-gate.sh runs
# that only for review:admin, which holds the approval anyway).
# Posting a new escalation thread below sets it too.
held=$(pick 'any(.[]; own and esc and ((.isResolved | not) or .resolvedBy.login != $admin))')
escalated=false
[[ $needs_admin != true && $labelled != true ]] || escalated=true
# Who opened the PR, from the REST author, never from text the PR wrote. Only the admin's own
# account (a User) gets an approval on an escalated PR: on one an App opened (#336), a thread the
# App resolved could let it merge before the next run reopens it (ADR-0002, #264).
by_admin=false
[[ $author == "$ADMIN" && $author_type == User ]] && by_admin=true

# Required findings: a line comment, else a file comment, else listed in the review's body.
unplaced="" note=""
while IFS= read -r f; do
  path=$(jq -r '.path // ""' <<<"$f") line=$(jq -r '.line // 0' <<<"$f") body=$(jq -r '.body // ""' <<<"$f")
  # "escalated:" marks its escalation threads, which no finding may pass for (open_finding).
  [[ ! $body =~ ^[[:space:]]*escalated: ]] || body="Finding: $body"
  [[ $line =~ ^[0-9]+$ ]] || line=0
  if ((line > 0)) && comment "$path" "$body" "$line"; then continue; fi
  if [[ -n $path ]] && comment "$path" "Line $line: $body"; then continue; fi
  unplaced+="- ${path:-(no file)}:$line $body"$'\n'
done < <(jq -c '.findings[]' "$v")

if [[ -n $rows ]]; then
  # One escalation thread per PR. Later rows are named in each review's summary.
  if [[ $escalated_before != true ]]; then
    body="escalated: $rows"$'\n\n'"@$ADMIN: this PR meets the rows above (CONSTRAINTS.md,"
    body+=" Escalation criteria). This open thread holds the merge; only you resolve it."
    # The file the verdict names, else any file the head still has.
    want=$(jq -r '.escalation_path // ""' "$v")
    paths=$(jq -r --arg p "$want" '(map(select(.filename == $p and .status != "removed"))
      + map(select(.status != "removed"))) | .[].filename' "$CTX/files.json")
    posted=false
    while IFS= read -r path; do
      if [[ -n $path ]] && comment "$path" "$body"; then posted=true held=true; break; fi
    done <<<"$paths"
    [[ $posted == true ]] || note=$'\n\n'"Escalation thread not posted (no file took it): $rows"
  fi
  [[ $labelled == true ]] || gh api -X POST "$r/issues/$PR/labels" --silent -f 'labels[]=review:admin'
  if [[ $author == "${FACTORY_APP}[bot]" ]]; then
    gh api -X POST "$r/pulls/$PR/requested_reviewers" --silent -f "reviewers[]=$ADMIN"
  fi
fi

reviews=$(gh api --paginate "$r/pulls/$PR/reviews?per_page=100")
dismiss() { # state message: dismiss this App's own reviews in that state
  local ids id
  ids=$(jq -r --arg u "${BOT}[bot]" --arg s "$1" '.[] | select(.user.login == $u and .state == $s) | .id' <<<"$reviews")
  for id in $ids; do
    gh api -X PUT "$r/pulls/$PR/reviews/$id/dismissals" --silent -f event=DISMISS -f message="$2"
  done
}
labelled_now=$(has_label) # read again: a label added during this run still holds the approval
event=APPROVE
if ((nfind > 0)) || [[ -n $unplaced ]]; then
  event=REQUEST_CHANGES
elif [[ $labelled_now == true ]] || ((still_open > 0)); then
  event=COMMENT
elif [[ $needs_admin == true ]] && [[ $by_admin != true || $held != true ]]; then
  event=COMMENT
fi
# A later COMMENT doesn't replace an APPROVE, so an earlier approval that no longer holds (say
# review:admin was added after it) is dismissed (ADR-0002, test (e)).
if [[ $event != APPROVE ]]; then
  dismiss APPROVED "This review no longer approves the PR: $event."
  # Auto-merge must not outlive the approval it came with (ADR-0002, test (e)).
  if [[ $auto_on == true ]] && ! set_auto disable; then
    echo "::warning::auto-merge is still on: turn it off by hand (gh pr merge $PR --disable-auto)"
  fi
fi
# Withheld with every finding fixed (review:admin, or an escalated PR it may not approve): its own
# Request changes would block for good, so it dismisses it. Where it approves, the Approve
# replaces it.
if [[ $event == COMMENT ]] && ((still_open == 0)); then
  dismiss CHANGES_REQUESTED "Its findings are fixed. The PR waits for the admin."
fi
body=$(jq -r .summary "$v")
[[ -z $unplaced ]] || body+=$'\n\nRequired findings without a place in the diff:\n'"$unplaced"
((still_open == 0)) || body+=$'\n\n'"$still_open earlier finding thread(s) still open."
body+=$note
gh api -X POST "$r/pulls/$PR/reviews" --silent -f commit_id="$HEAD" -f event="$event" -f body="$body"
auto=off
if [[ $event == APPROVE && $base_ref != "$DEFAULT_BRANCH" ]]; then
  auto=stacked
  if [[ $auto_on == true ]] && ! set_auto disable; then
    echo "::warning::auto-merge is on for a stacked part: turn it off by hand (gh pr merge $PR --disable-auto)"
  fi
elif [[ $event == APPROVE ]]; then
  # Refused while allow_auto_merge is off (or the PR merges as it is): the approval stands.
  if [[ $auto_on == true ]] || set_auto enable 2>/dev/null; then auto=on; else auto=refused; fi
fi
echo "RESULT event=$event findings=$nfind still_open=$still_open escalated=$escalated by_admin=$by_admin auto_merge=$auto"

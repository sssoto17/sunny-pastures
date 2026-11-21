# shellcheck shell=bash
# #68 step 4: the reviewer App's tests (a)-(f) (ADR-0002, admin checklist step 12), on throwaway
# PRs onto main that the real review workflow reviews. Sourced by ci-check.sh, which owns the
# arguments, die, check_urls, start and REPO. Runbook: scripts/setup/README.md.
# shellcheck disable=SC2016 # single-quoted jq programs and Markdown backticks, by design

T68_ADMIN=sssoto17
T68_NOTES=docs/spikes/reviewer-app
T68_RESOLVE_WF=check-68-factory-resolve.yml # on main; resolve 68 dispatches it (test (e2))
T68_THREADS='query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name)
  { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { isResolved resolvedBy { login }
  comments(first: 1) { nodes { author { login } body } } } } } } }'
# An open thread holds a PR through required conversation resolution, so the App's approval plus
# auto-merge can't merge (a) or a wrongly approved (c). (e) and (f) carry the App's escalation
# thread instead (their rows come from paths, in code: post-review.sh), and until #104 the
# review:admin it adds with that thread holds its approval as well.
T68_HOLD="Hold (ci-check.sh start 68): this open thread keeps a throwaway PR from merging once"
T68_HOLD+=" allow_auto_merge goes on for #68's tests. Leave it open; cleanup 68 closes it unmerged."

t68_file() { # letter: the file its change touches
  case $1 in
    a | c) echo "$T68_NOTES/throwaway-$1.md" ;;
    e) echo packages/sim/src/content/index.ts ;;
    f) echo AGENTS.md ;;
  esac
}
t68_what() { # letter: the PR title's description, neutral: it never tells the reviewer what to say
  case $1 in
    a) echo "a note under docs/spikes/" ;;
    c) echo "a note on checking the local stack" ;;
    e) echo "a comment line in the sim's content" ;;
    f) echo "one changed line in AGENTS.md" ;;
  esac
}
t68_change() { # dir letter: honest, minimal changes; the reviewer must find what each one is
  local f="$1/$(t68_file "$2")"
  mkdir -p "$1/$T68_NOTES"
  case $2 in
    a) printf '# Throwaway note for #68\n\nThis file exists only on a throwaway PR of #68 test (a). It is never merged.\n' >"$f" ;;
    # A genuine defect no check catches: AGENTS.md forbids a bare `supabase status`, which prints
    # the local stack's keys.
    c) printf '# Checking the local stack\n\nTo see whether the local Supabase stack is up, run `supabase status`.\n' >"$f" ;;
    e) sed -i.bak '1i\
// Throwaway for #68 test (e): a comment only; no content value changes.' "$f" && rm "$f.bak" ;;
    f) sed -i.bak '1s/.*/# Sunny Pastures (throwaway edit for #68 test (f))/' "$f" && rm "$f.bak" ;;
  esac
}

t68_tidy() { # remove start_68's and push_68's worktrees
  local w
  for w in "$tmp"/*/; do git -C "$repo" worktree remove --force "$w" >/dev/null 2>&1 || true; done
  rm -rf "$tmp"
}
t68_worktree() { # rev name: a detached worktree of rev at $tmp/name, URLs checked there too
  git -C "$repo" worktree add -q --detach "$tmp/$2" "$1" || die 1 "git worktree add failed"
  check_urls "$tmp/$2" "in the worktree"
}
t68_repo() {
  repo=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) || die 2 "$here isn't inside a git clone of $REPO"
  check_urls "$repo" "in $repo"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-check.XXXXXX")
  trap t68_tidy EXIT
}
t68_pr() { # letter [state]: the number of our PR from throwaway/68-<letter>, or nothing
  gh pr list --repo "$REPO" --head "throwaway/68-$1" --state "${2:-all}" --json number,isCrossRepository \
    --jq 'map(select(.isCrossRepository | not)) | .[0].number // empty'
}

start_68() {
  local rules l b url pr label=()
  # The hold threads and tests (a), (c) and (d) rest on main's rules: check them, don't assume them.
  rules=$(gh api "repos/$REPO/rules/branches/main" --jq '[.[] | select(.type == "pull_request") | .parameters]
    | any(.required_review_thread_resolution) and any(.required_approving_review_count >= 1)
      and any(.dismiss_stale_reviews_on_push)') || die 1 "gh api rules of main failed"
  [[ $rules == true ]] || die 2 "main's rules lack thread resolution, 1 required approval or stale-review
dismissal: a hold thread wouldn't hold, and (a)-(d) would read nothing. Nothing opened."
  t68_repo
  git -C "$repo" fetch -q origin main || die 1 "git fetch origin main failed"
  for l in a c e f; do
    if git -C "$repo" ls-remote --exit-code -q origin "refs/heads/throwaway/68-$l" >/dev/null 2>&1; then
      die 2 "throwaway/68-$l already exists on origin: run cleanup 68 first"
    fi
  done
  # Labels are never created here: only an existing `throwaway` label is added.
  gh api "repos/$REPO/labels/throwaway" --silent >/dev/null 2>&1 && label=(--label throwaway)
  for l in a c e f; do
    b=throwaway/68-$l
    t68_worktree origin/main "$l"
    t68_change "$tmp/$l" "$l"
    git -C "$tmp/$l" add -A
    git -C "$tmp/$l" commit -q -m "chore: throwaway change for #68 test ($l) (never merge)" || die 1 "git commit failed"
    git -C "$tmp/$l" push -q origin "HEAD:refs/heads/$b" || die 1 "git push of $b failed"
    # A draft first, so the hold thread is in place before the review starts (drafts aren't
    # reviewed); marking it ready starts the review.
    url=$(gh pr create --repo "$REPO" --base main --head "$b" --draft "${label[@]}" \
      --title "THROWAWAY #68 ($l): $(t68_what "$l")" \
      --body "This is a throwaway test PR for #68 step 4: test ($l) of the reviewer App (ADR-0002, admin
checklist step 12). Its change is a small sample made for that test, not part of #68's deliverables.
Opened by \`scripts/setup/ci-check.sh start 68\`. **Never merge**: \`cleanup 68\` closes it unmerged.

Part of #68") || die 1 "gh pr create for $b failed"
    pr=${url##*/}
    if [[ $l == a || $l == c ]]; then
      gh api -X POST "repos/$REPO/pulls/$pr/comments" --silent -f commit_id="$(git -C "$tmp/$l" rev-parse HEAD)" \
        -f path="$(t68_file "$l")" -f subject_type=file -f body="$T68_HOLD" ||
        die 1 "the hold thread on PR #$pr failed: it stays a draft, so nothing reviews or merges it"
    fi
    gh pr ready "$pr" --repo "$REPO" >/dev/null || die 1 "gh pr ready $pr failed"
    printf 'test (%s): opened PR #%s, %s\n' "$l" "$pr" "$url"
  done
  printf 'Each review takes about 1-3 minutes. Then: scripts/setup/ci-check.sh results 68\n'
  printf 'Turn allow_auto_merge on once (a) reads APPROVED, then push 68 a (runbook).\n'
}

# One more commit on a throwaway branch: for (a) that is test (d); for (e) it starts the reviewer's
# next run after a thread was resolved (resolving starts no workflow).
push_68() {
  local b=throwaway/68-$letter pr decision auto
  # (a)'s push makes one fresh approval cover (b) and (d): that needs auto-merge allowed, and an
  # approval to dismiss. Both are checked before anything is pushed.
  if [[ $letter == a ]]; then
    auto=$(gh api "repos/$REPO" --jq .allow_auto_merge) || die 1 "gh api repos/$REPO failed"
    [[ $auto == true ]] || die 2 "allow_auto_merge is off, so test (b) can't run: nothing pushed.
Once (a) reads APPROVED, turn it on for the test window only (runbook), then push 68 a again:
  gh api -X PATCH repos/$REPO --silent -F allow_auto_merge=true"
    pr=$(t68_pr a open) || die 1 "gh pr list failed"
    [[ -n $pr ]] || die 2 "no open PR from $b: run start 68 first"
    decision=$(gh api "repos/$REPO/pulls/$pr/reviews?per_page=100" --jq \
      '[.[] | select(.user.login == "sunny-reviewer[bot]")] | last | .state // ""') || die 1 "gh api reviews failed"
    [[ $decision == APPROVED ]] || die 2 "(a) isn't approved by sunny-reviewer yet: wait for its review (results 68)"
  fi
  t68_repo
  git -C "$repo" fetch -q origin "refs/heads/$b" || die 1 "git fetch of $b failed: run start 68 first"
  t68_worktree FETCH_HEAD w
  mkdir -p "$tmp/w/$T68_NOTES"
  printf 'Another commit, pushed by ci-check.sh push 68 %s.\n' "$letter" >>"$tmp/w/$T68_NOTES/throwaway-$letter.md"
  git -C "$tmp/w" add -A
  git -C "$tmp/w" commit -q -m "chore: one more throwaway commit for #68 ($letter) (never merge)" || die 1 "git commit failed"
  git -C "$tmp/w" push -q origin "HEAD:refs/heads/$b" || die 1 "git push of $b failed"
  pr=$(t68_pr "$letter" open) || die 1 "gh pr list failed"
  printf 'Pushed one commit to %s (PR #%s).\n' "$b" "${pr:-?}"
  [[ -n $pr && $letter == a ]] || return 0
  sleep "${CI_CHECK_WAIT_SECONDS:-10}"
  decision=$(gh pr view "$pr" --repo "$REPO" --json reviewDecision --jq '.reviewDecision // ""') ||
    die 1 "gh pr view $pr failed"
  printf 'reviewDecision right after the push: `%s` (test (d) expects REVIEW_REQUIRED here, then\n' "${decision:-(empty)}"
  printf 'APPROVED again after the fresh review, in 1-3 minutes).\n'
}

# Test (e2): main's factory workflow resolves (e)'s escalation thread as sunny-factory, pushes,
# and reads the reviewer's answer. The `factory` environment admits main only (#336), so this
# dispatches the copy on main instead of pushing a branch. It needs (e)'s open PR.
resolve_68() {
  local pr
  pr=$(t68_pr e open) || die 1 "gh pr list failed"
  [[ -n $pr ]] || die 2 "no open PR from throwaway/68-e: run start 68 first"
  gh workflow run "$T68_RESOLVE_WF" --repo "$REPO" --ref main ||
    die 1 "gh workflow run failed: is $T68_RESOLVE_WF on main?"
  printf 'Dispatched %s on main for PR #%s. Follow it with:\n' "$T68_RESOLVE_WF" "$pr"
  printf '  gh run list --repo %s --workflow %s\n' "$REPO" "$T68_RESOLVE_WF"
  printf 'When it has finished: scripts/setup/ci-check.sh results 68\n'
}

# Everything results 68 reads, as one JSON object: a PR per letter, and the factory's run.
t68_collect() {
  local l pr view reviews threads run
  data='{}'
  for l in a c e f; do
    pr=$(t68_pr "$l") || die 1 "gh pr list failed"
    [[ -n $pr ]] || continue
    view=$(gh pr view "$pr" --repo "$REPO" --json number,url,state,headRefOid,reviewDecision,mergeStateStatus,autoMergeRequest,labels,reviewRequests,commits \
      --jq '{number, url, state, headRefOid, reviewDecision, mergeStateStatus, labels: [.labels[].name],
        auto: (.autoMergeRequest | if . then {by: (.enabledBy.login // ""), method: .mergeMethod} else null end),
        requests: [.reviewRequests[] | .login // .name // .slug // ""], commits: (.commits | length),
        head_author: (.commits[-1].authors[0].login // "")}') || die 1 "gh pr view $pr failed"
    reviews=$(gh api "repos/$REPO/pulls/$pr/reviews?per_page=100" \
      --jq 'map({author: .user.login, state, commit: .commit_id})') || die 1 "gh api reviews of PR #$pr failed"
    threads=$(gh api graphql -F owner="${REPO%/*}" -F name="${REPO#*/}" -F pr="$pr" -f query="$T68_THREADS" \
      --jq '.data.repository.pullRequest.reviewThreads.nodes') || die 1 "gh api graphql (threads of PR #$pr) failed"
    data=$(jq --arg l "$l" --argjson v "$view" --argjson r "$reviews" --argjson t "$threads" \
      '.[$l] = $v + {reviews: $r, threads: $t}' <<<"$data")
  done
  # The newest dispatch of main's factory workflow (resolve 68).
  run=$(gh run list --repo "$REPO" --workflow "$T68_RESOLVE_WF" --branch main --event workflow_dispatch \
    --limit 1 --json databaseId,status,conclusion,url,workflowName --jq '.[0] // {}') ||
    die 1 "gh run list failed"
  data=$(jq --argjson run "$run" '.resolve = $run' <<<"$data")
}

# Pass, fail or not yet run per test, from the collected object. Kept apart from the printing so
# cleanup 68 asks the same question.
T68_VERDICTS='
  def nobot: sub("\\[bot\\]$"; "");
  def bot: [.reviews[] | select((.author | nobot) == "sunny-reviewer")];
  def esc: [.threads[] | select(((.comments.nodes[0].author.login // "") | nobot) == "sunny-reviewer"
    and ((.comments.nodes[0].body // "") | startswith("escalated:")))] | .[0];
  def latest: bot | last | .state;
  def seen($p): $p != null and ($p | bot | length) > 0;
  def t($id; $text; $r; $why): {id: $id, text: $text, result: $r, why: $why};
  . as $d | [
  (if seen($d.a) | not then t("a"; "App approval outside CODEOWNERS"; "not yet run"; "no review on (a)")
   elif $d.a.reviewDecision == "APPROVED" then t("a"; "App approval outside CODEOWNERS"; "pass"; "reviewDecision `APPROVED`")
   elif ($d.a | latest) == "DISMISSED" then t("a"; "App approval outside CODEOWNERS"; "not yet run"; "waiting for the review after push 68 a")
   else t("a"; "App approval outside CODEOWNERS"; "fail"; "reviewDecision `\($d.a.reviewDecision)`") end),
  (if seen($d.a) | not then t("b"; "App turns on auto-merge"; "not yet run"; "no review on (a)")
   elif ($d.a.auto.by // "" | nobot) == "sunny-reviewer" then t("b"; "App turns on auto-merge"; "pass"; "autoMergeRequest by `\($d.a.auto.by)`")
   else t("b"; "App turns on auto-merge"; "fail"; "autoMergeRequest `\($d.a.auto // "null" | tostring)`") end),
  (if seen($d.c) | not then t("c"; "Request changes blocks"; "not yet run"; "no review on (c)")
   elif $d.c.reviewDecision == "CHANGES_REQUESTED" and $d.c.mergeStateStatus == "BLOCKED"
   then t("c"; "Request changes blocks"; "pass"; "`CHANGES_REQUESTED`, `BLOCKED`")
   else t("c"; "Request changes blocks"; "fail"; "`\($d.c.reviewDecision)`, `\($d.c.mergeStateStatus)`") end),
  (if seen($d.a) | not or $d.a.commits < 2 then t("d"; "a push dismisses the approval"; "not yet run"; "no push 68 a yet")
   elif ($d.a | bot | map(.state) | index("DISMISSED")) == null then t("d"; "a push dismisses the approval"; "fail"; "no dismissed approval on (a)")
   elif ($d.a | latest) == "APPROVED" then t("d"; "a push dismisses the approval"; "pass"; "approval `DISMISSED`, then a fresh `APPROVED`")
   else t("d"; "a push dismisses the approval"; "not yet run"; "dismissed; waiting for the fresh review") end),
  (if seen($d.e) | not then t("e1"; "escalation thread, review:admin holds approval"; "not yet run"; "no review on (e)")
   elif ($d.e | bot | map(.state) | index("APPROVED")) == null and ($d.e.labels | index("review:admin")) != null
     and (($d.e | esc).comments.nodes[0].body // "" | contains("@\($admin)"))
   then t("e1"; "escalation thread, review:admin holds approval"; "pass"; "thread mentions @\($admin), `review:admin`, no `APPROVED`")
   else t("e1"; "escalation thread, review:admin holds approval"; "fail"; "see PR #\($d.e.number) below") end),
  (if ($d.resolve.status // "") == "" then t("e2"; "factory resolves, App reopens"; "not yet run"; "no resolve 68 run")
   elif $d.resolve.status != "completed" then t("e2"; "factory resolves, App reopens"; "not yet run"; "run \($d.resolve.status)")
   elif $d.resolve.conclusion == "success" then t("e2"; "factory resolves, App reopens"; "pass"; "run \($d.resolve.url)")
   else t("e2"; "factory resolves, App reopens"; "fail"; "run `\($d.resolve.conclusion)`: \($d.resolve.url)") end),
  (($d.e // {threads: []} | esc) as $th |
   if $th != null and ($th.isResolved | not) and ($d.resolve.conclusion // "") == "success"
     and ($d.e | bot | last | .commit) == $d.e.headRefOid and ($d.e.head_author | startswith("sunny-factory") | not)
   then t("e3"; "admin resolves, it stays resolved"; "fail"; "open after push 68 e and its review (resolve first, then push)")
   elif $th == null or ($th.resolvedBy.login // "") != $admin or ($d.resolve.conclusion // "") != "success"
   then t("e3"; "admin resolves, it stays resolved"; "not yet run"; "not resolved by @\($admin) after e2")
   elif ($d.e | bot | last | .commit) != $d.e.headRefOid or ($d.e.head_author | startswith("sunny-factory"))
   then t("e3"; "admin resolves, it stays resolved"; "not yet run"; "resolved; waiting for push 68 e and its review")
   else t("e3"; "admin resolves, it stays resolved"; "pass"; "resolved by @\($admin) after the App reviewed the head") end),
  # What was not tested never reads pass: "not exercised" says what was observed instead. #322:
  # the App approves (e), which your account opened, and the open escalation thread alone holds
  # it; once you resolve the thread it may merge. Until #104, review:admin holds the approval.
  (($d.e // {threads: []} | esc) as $th | ($th != null and ($th.isResolved | not)) as $open
   | (seen($d.e) and ($d.e | latest) == "APPROVED") as $approved |
   if seen($d.e) | not then t("e4"; "the escalation thread holds the merge"; "not yet run"; "no review on (e)")
   elif $open and $approved and $d.e.reviewDecision == "APPROVED" and $d.e.mergeStateStatus == "BLOCKED"
   then t("e4"; "the escalation thread holds the merge"; "pass"; "App approved; the open thread alone holds it: `APPROVED`, `BLOCKED`")
   elif $d.e.mergeStateStatus != "BLOCKED" and ((($th.resolvedBy.login // "") == $admin and $approved) | not)
   then t("e4"; "the escalation thread holds the merge"; "fail"; "`\($d.e.mergeStateStatus)` without your resolved thread behind an App approval")
   elif $approved
   then t("e4"; "the escalation thread holds the merge"; "not exercised"; "App approved; observed `\($d.e.reviewDecision)`, `\($d.e.mergeStateStatus)` with the thread resolved by @\($admin)")
   else t("e4"; "the escalation thread holds the merge"; "not exercised"; "observed `\($d.e.reviewDecision)`, `\($d.e.mergeStateStatus)`, no App approval: `review:admin` holds the approval until #104") end),
  (if seen($d.f) | not then t("f"; "AGENTS.md waits for the code owner"; "not yet run"; "no review on (f)")
   elif $d.f.mergeStateStatus != "BLOCKED" or $d.f.reviewDecision == "APPROVED"
   then t("f"; "AGENTS.md waits for the code owner"; "fail"; "`\($d.f.reviewDecision)`, `\($d.f.mergeStateStatus)`")
   elif ($d.f | latest) == "APPROVED" then t("f"; "AGENTS.md waits for the code owner"; "pass"; "App approved; `\($d.f.reviewDecision)`, `BLOCKED`")
   else t("f"; "AGENTS.md waits for the code owner"; "not exercised"; "App withheld approval (`review:admin`, until #104): `\($d.f.reviewDecision)`, `BLOCKED`; the code-owner hold behind an App approval is not reachable while the label holds it") end)
  ]'

results_68() {
  local run
  t68_collect
  printf '## Results of #68'"'"'s reviewer tests (a)-(f)\n\n| Test | Result | Read |\n|---|---|---|\n'
  jq -r --arg admin "$T68_ADMIN" "$T68_VERDICTS"' | .[] | "| (\(.id)) \(.text) | \(.result) | \(.why) |"' <<<"$data"
  jq -r '(["a", "c", "e", "f"][] as $l | .[$l] // empty |
    "\n### Test (\($l)): PR #\(.number) (\(.state))\n",
    "- reviewDecision `\(.reviewDecision // "(empty)")`, mergeStateStatus `\(.mergeStateStatus)`, commits \(.commits)",
    "- autoMergeRequest: \(if .auto then "enabled by `\(.auto.by)`, \(.auto.method)" else "none" end)",
    "- labels: \(.labels | map("`\(.)`") | join(", ") | if . == "" then "none" else . end)",
    "- review requests: \(.requests | map("`\(.)`") | join(", ") | if . == "" then "none" else . end)",
    "- reviews, oldest first: \(.reviews | map("`\(.author)` \(.state)") | join(", ") | if . == "" then "none" else . end)",
    "- escalation thread: \([.threads[] | select((.comments.nodes[0].body // "") | startswith("escalated:"))][0]
       | if . then "resolved `\(.isResolved)`, resolvedBy `\(.resolvedBy.login // "null")`" else "none" end)")' <<<"$data"
  run=$(jq -r '.resolve.databaseId // empty' <<<"$data")
  [[ -n $run ]] || return 0
  printf '\n### resolve 68: %s\n\n```\n' "$(jq -r .resolve.url <<<"$data")"
  gh run view "$run" --repo "$REPO" --log | grep -E $'^[^\t]*\t[^\t]*\t[^ ]*Z RESULT ' |
    sed -E $'s/^([^\t]*)\t[^\t]*\t[^ ]* /\\1: /' || true
  printf '```\n'
}

cleanup_68() {
  local reply l pr b all auto
  printf 'This closes every throwaway PR of #68 unmerged and deletes the throwaway/68-* branches.\n'
  printf 'Run results 68 first: the branches go. Go ahead? [y/N] '
  read -r reply || true
  [[ $reply =~ ^[Yy] ]] || die 2 "nothing changed"
  t68_collect
  all=$(jq --arg admin "$T68_ADMIN" "$T68_VERDICTS"' | all(.result == "pass")' <<<"$data")
  for l in a c e f; do
    pr=$(t68_pr "$l" open) || die 1 "gh pr list failed"
    [[ -n $pr ]] || continue
    gh pr close "$pr" --repo "$REPO" --comment "Throwaway for #68's reviewer tests: closed unmerged." >/dev/null ||
      die 1 "closing PR #$pr failed"
    printf 'closed PR #%s unmerged\n' "$pr"
  done
  for l in a c e f; do
    b=throwaway/68-$l
    if gh api "repos/$REPO/git/ref/heads/$b" --silent >/dev/null 2>&1; then
      gh api -X DELETE "repos/$REPO/git/refs/heads/$b" --silent || die 1 "deleting $b failed"
      printf 'deleted branch %s\n' "$b"
    fi
  done
  auto=$(gh api "repos/$REPO" --jq .allow_auto_merge) || auto=unknown
  [[ $auto != false ]] || return 0
  if [[ $auto == unknown ]]; then
    printf '\nCould not read allow_auto_merge. If it is on and Q16 does not hold, turn it off:\n'
  elif [[ $all == true ]]; then
    printf '\n(a)-(f) all passed. allow_auto_merge stays on only if the required checks report and\n'
    printf "#47's escalation criteria are merged (Q16); otherwise turn it off:\n"
  else
    printf '\nNot all of (a)-(f) passed ("not exercised" counts as not passed), and allow_auto_merge\n'
    printf 'is still on. Turn it off now (Q16):\n'
  fi
  printf '  gh api -X PATCH repos/%s --silent -F allow_auto_merge=false\n' "$REPO"
}

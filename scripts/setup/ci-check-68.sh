# shellcheck shell=bash
# #68 step 4: the reviewer App's tests (a)-(f) (ADR-0002, admin checklist step 12), on throwaway
# PRs onto main that the real review workflow reviews. Sourced by ci-check.sh, which owns the
# arguments, die, check_urls, start and REPO. Runbook: scripts/setup/README.md.
# shellcheck disable=SC2016 # single-quoted jq programs and Markdown backticks, by design

T68_ADMIN=sssoto17
T68_NOTES=docs/spikes/reviewer-app
# An open thread holds a PR through required conversation resolution, so the App's approval plus
# auto-merge can't merge (a) or a wrongly approved (c). (e) and (f) never get the App's approval:
# their rows come from paths, in code (post-review.sh).
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
  for l in a c e f "factory-resolve"; do
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

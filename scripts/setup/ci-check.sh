#!/usr/bin/env bash
# Runs the throwaway checks for #101 (the two Apps), #102 (reading the Project) and #103 (Claude
# in Actions), collects their results and cleans up. `start` builds its branches from origin/main
# in a temporary worktree, so your checkout and main are never touched. For 101 and 102 it pushes a
# branch plus one draft workflow from scripts/setup/workflows/, and the push runs it. 103's
# workflow is already on main (.github/workflows/check-103-claude.yml, on pull_request_target), so
# start pushes no workflow: it pushes throwaway/103-base (main plus two marker hooks in
# .claude/settings.json) and throwaway/103-claude (the base plus one text file), then opens a PR
# from the second onto the first with your gh, which runs the workflow from main (the action has
# no push event, and restores .claude/ from the PR's base). `results` prints
# a Markdown summary of non-secret fields for the issue comment. `cleanup` closes the throwaway PR
# unmerged and deletes the branches.
# Run ci-apps.sh, ci-project.sh and ci-claude.sh first. Tests: scripts/setup/ci-check.test.sh.
# shellcheck disable=SC2016 # single-quoted jq programs and Markdown backticks, by design
set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "ci-check: needs bash 4.4 or later, found $BASH_VERSION" >&2
  exit 2
fi

REPO=sssoto17/sunny-pastures
FACTORY_PR_BRANCH=throwaway/101-factory-pr
PROBE_BRANCH=throwaway/101-readonly-probe
TAG=v0.0.0-throwaway-101

usage() {
  cat >&2 <<'EOF'
usage: scripts/setup/ci-check.sh start|results|cleanup 101|102|103

  start 101    push throwaway/101-identities with check-101-identities.yml; the push runs it
  start 102    push throwaway/102-project with check-102-project.yml (needs 101's App)
  start 103    push throwaway/103-base (main plus marker hooks) and throwaway/103-claude (that
               plus one text file), then open a PR from 103-claude onto 103-base with your gh;
               the PR runs check-103-claude.yml from main: three short Claude runs. Needs jq,
               and that workflow merged on main
  results N    print the latest run of N's workflow as Markdown, for a comment on issue N:
                 scripts/setup/ci-check.sh results 101 > .scratch/101-results.md
               then read it and post it: gh issue comment 101 --body-file .scratch/101-results.md
  cleanup N    close N's throwaway PR unmerged (101, 103) and delete N's throwaway branches
               (asks first)

It works on the clone it lives in, whatever directory you run it from, and refuses unless that
clone's origin is sssoto17/sunny-pastures. Nothing it prints is secret: logins, states, exit codes,
costs and minutes. Pushing a workflow file over HTTPS with gh's credentials (start 101 and 102)
needs the `workflow` scope: gh auth refresh -h github.com -s workflow (it prints a one-time code,
not a token).

Exit codes: 0 done; 1 a git or gh command failed; 2 refused (usage, gh signed out twice in a row,
a throwaway branch already exists, an origin URL that isn't sunny-pastures, here or in the
worktree start pushes from, 103's workflow not on main yet); 3 no finished run yet: wait and run
results again.
EOF
}

die() { # code message
  printf 'ci-check: %s\n' "$2" >&2
  exit "$1"
}

[[ ${1-} == -h || ${1-} == --help ]] && { usage; exit 0; }
(($# == 2)) || { usage; exit 2; }
# base: a branch start pushes first, carrying #103's marker hooks; start then opens a PR onto
# it, and needs jq. Its workflow is on main, not a draft. pr_head: the branch of the throwaway PR
# that cleanup closes.
cmd=$1 issue=$2 base="" pr_head=""
case $issue in
  101) branch=throwaway/101-identities workflow=check-101-identities.yml pr_head=$FACTORY_PR_BRANCH ;;
  102) branch=throwaway/102-project workflow=check-102-project.yml ;;
  103) branch=throwaway/103-claude workflow=check-103-claude.yml base=throwaway/103-base pr_head=$branch ;;
  *) usage; exit 2 ;;
esac
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Only the account gh uses on github.com counts (a broken inactive account doesn't), and one
# failure can be a passing network error: try twice before calling it signed out (#198).
signed_in() { gh auth status -h github.com --active >/dev/null 2>&1; }
signed_in || { sleep "${CI_CHECK_RETRY_SECONDS:-3}"; signed_in; } || die 2 "gh is signed out: run gh auth login"

official_url() { # url: is it exactly sssoto17/sunny-pastures on GitHub, with no userinfo?
  case $1 in
    "https://github.com/$REPO" | "https://github.com/$REPO.git" | "git@github.com:$REPO.git" | \
      "git@github.com:$REPO" | "ssh://git@github.com/$REPO.git" | "ssh://git@github.com/$REPO") ;;
    *) return 1 ;;
  esac
}

# Both the fetch and the push URLs of origin, as git resolves them in that directory (insteadOf,
# pushInsteadOf, pushurl and conditional includes applied), must be exactly sunny-pastures on
# GitHub, with no userinfo. Every URL counts: git fetches from the first but pushes to each push
# URL (--all lists them). Neither is ever printed: a URL can carry a credential.
check_urls() { # dir where
  local kind urls url
  for kind in fetch push; do
    if [[ $kind == push ]]; then
      urls=$(git -C "$1" remote get-url --push --all origin 2>/dev/null) || urls=""
    else
      urls=$(git -C "$1" remote get-url --all origin 2>/dev/null) || urls=""
    fi
    [[ -n $urls ]] || die 2 "origin $2 has no $kind URL: nothing pushed"
    while IFS= read -r url; do
      official_url "$url" || die 2 "a $kind URL of origin $2 isn't $REPO on GitHub: nothing pushed"
    done <<<"$urls"
  done
}

# start works on the clone this script lives in, never on the current directory's repo, and only
# when that clone's origin is $REPO: run from another clone, it must not push anything there.
start() {
  # repo is global: the EXIT trap below reads it after start returns.
  repo=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) ||
    die 2 "$here isn't inside a git clone of $REPO"
  check_urls "$repo" "in $repo"
  [[ -z $base ]] || command -v jq >/dev/null || die 2 "start $issue needs jq: install it first"
  git -C "$repo" fetch -q origin main || die 1 "git fetch origin main failed"
  # pull_request_target runs the workflow from main: without it there, the PR would run nothing.
  if [[ -n $base ]] && ! git -C "$repo" cat-file -e "origin/main:.github/workflows/$workflow" 2>/dev/null; then
    die 2 "$workflow isn't on main yet: merge its PR first"
  fi
  local b
  for b in ${base:+"$base"} "$branch"; do
    if git -C "$repo" ls-remote --exit-code -q origin "refs/heads/$b" >/dev/null 2>&1; then
      die 2 "$b already exists on origin: run cleanup $issue first"
    fi
  done
  # Only 101 and 102 push a workflow file; 103's is on main already.
  [[ -n $base ]] || scopes=$(gh api -i user 2>/dev/null | tr -d '\r' | grep -i '^x-oauth-scopes:' || true)
  if [[ -n ${scopes-} && $scopes != *workflow* ]]; then
    printf "ci-check: gh's token lacks the workflow scope; an HTTPS push of a workflow file will\n" >&2
    printf 'be refused. If you push over HTTPS: gh auth refresh -h github.com -s workflow\n' >&2
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-check.XXXXXX")
  trap 'git -C "$repo" worktree remove --force "$tmp/wt" >/dev/null 2>&1; rm -rf "$tmp"' EXIT
  git -C "$repo" worktree add -q --detach "$tmp/wt" origin/main || die 1 "git worktree add failed"
  local refspecs=()
  if [[ -n $base ]]; then
    add_marker_hooks "$tmp/wt/.claude/settings.json"
    git -C "$tmp/wt" add .claude/settings.json || die 1 "git add failed"
    git -C "$tmp/wt" commit -q -m "chore: throwaway marker hooks for #$issue (never merge)" ||
      die 1 "git commit failed"
    refspecs+=("$(git -C "$tmp/wt" rev-parse HEAD):refs/heads/$base")
    # The head only needs a diff for the PR; the workflow never reads it.
    printf 'Throwaway for #%s. Never merge; close unmerged.\n' "$issue" >"$tmp/wt/throwaway-$issue.md"
    git -C "$tmp/wt" add "throwaway-$issue.md" || die 1 "git add failed"
    git -C "$tmp/wt" commit -q -m "chore: throwaway PR head for #$issue (never merge)" ||
      die 1 "git commit failed"
  else
    mkdir -p "$tmp/wt/.github/workflows"
    cp "$here/workflows/$workflow" "$tmp/wt/.github/workflows/$workflow"
    git -C "$tmp/wt" add ".github/workflows/$workflow"
    git -C "$tmp/wt" commit -q -m "chore: throwaway check workflow for #$issue (never merge)" ||
      die 1 "git commit failed"
  fi
  refspecs+=("HEAD:refs/heads/$branch")
  # Config can differ inside a linked worktree (an includeIf on its gitdir), so check the URLs
  # again where the push runs, right before it (#198).
  check_urls "$tmp/wt" "in the worktree"
  git -C "$tmp/wt" push -q --atomic origin "${refspecs[@]}" ||
    die 1 "git push failed. Missing workflow scope? gh auth refresh -h github.com -s workflow"
  if [[ -z $base ]]; then
    printf 'Pushed %s; the push starts %s. Follow it with:\n' "$branch" "$workflow"
  else
    local pr
    pr=$(gh pr create --repo "$REPO" --base "$base" --head "$branch" \
      --title "Throwaway for #$issue's checks. Never merge; close unmerged" \
      --body "Throwaway for #$issue's checks. Never merge; close unmerged.") ||
      die 1 "pushed $base and $branch, but opening the PR failed: run cleanup $issue, then start $issue again"
    printf 'Pushed %s and %s; opened PR #%s, which starts %s. Follow it with:\n' \
      "$base" "$branch" "${pr##*/}" "$workflow"
    printf '  gh run list --repo %s --workflow %s --event pull_request_target\n' "$REPO" "$workflow"
  fi
  [[ -n $base ]] || printf '  gh run list --repo %s --branch %s\n' "$REPO" "$branch"
  printf 'When it has finished: scripts/setup/ci-check.sh results %s\n' "$issue"
}

# The marker hooks of #103: two harmless hooks beside the repo's own, each appending its event's
# name to a file outside the checkout. The base branch carries them, because on a PR the action
# restores .claude/ from the base branch before Claude starts.
add_marker_hooks() { # settings-file
  local f=$1
  mkdir -p "$(dirname "$f")"
  [[ -f $f ]] || echo '{}' >"$f"
  jq --tab '
    def mark(e): {hooks: [{type: "command", command: ("echo " + e + " >> \"$RUNNER_TEMP/hook-marker\"")}]};
    .hooks.SessionStart += [mark("SessionStart")]
    | .hooks.UserPromptSubmit += [mark("UserPromptSubmit")]' "$f" >"$f.new" ||
    die 1 "adding the marker hooks to .claude/settings.json failed"
  mv "$f.new" "$f"
}

results() {
  local run id status url
  # 101 and 102: the check's own run on its branch, filtered by the workflow's name (its file name
  # without .yml), not with --workflow, which has GitHub resolve a file that exists only on a
  # throwaway branch. 103's workflow is on main, so --workflow finds it; its pull_request_target
  # runs are listed by event, not by a branch.
  local runs_of=(--branch "$branch") where="on $branch"
  [[ -n $base ]] && runs_of=(--workflow "$workflow" --event pull_request_target) where="of $workflow"
  run=$(gh run list --repo "$REPO" "${runs_of[@]}" --limit 50 \
    --json databaseId,status,conclusion,url,workflowName --jq 'map(select(.workflowName == "'"${workflow%.yml}"'"))
      | .[0] // empty | "\(.databaseId)\t\(.status)\t\(.url)"') ||
    die 1 "gh run list failed"
  [[ -n $run ]] || die 3 "no run $where yet: run start $issue first"
  IFS=$'\t' read -r id status url <<<"$run"
  [[ $status == completed ]] || die 3 "run $id is $status: wait for it ($url)"
  printf '## Results of the throwaway check for #%s\n\nRun: %s\n\n' "$issue" "$url"
  printf '| Job | Conclusion | Seconds | Billed minutes |\n|---|---|---|---|\n'
  gh run view "$id" --repo "$REPO" --json jobs --jq '.jobs[] |
    ((.completedAt | fromdateiso8601) - (.startedAt | fromdateiso8601)) as $s |
    "| \(.name) | \(.conclusion) | \($s) | \(($s / 60) | ceil) |"' || die 1 "gh run view failed"
  printf '\nWhat each job printed (only lines it starts with RESULT):\n\n```\n'
  # Log lines are "job<TAB>step<TAB>timestamp message"; keep only those whose message starts
  # with RESULT, which leaves out the echoed script lines.
  gh run view "$id" --repo "$REPO" --log | grep -E $'^[^\t]*\t[^\t]*\t[^ ]*Z RESULT ' |
    sed -E $'s/^([^\t]*)\t[^\t]*\t[^ ]* /\\1: /' || true
  printf '```\n'
  [[ $issue == 101 ]] && results_101
  [[ $issue == 102 ]] && results_102
  return 0
}

results_102() {
  printf '\nNext, from the `pat` job'"'"'s `readable=` line:\n\n'
  printf -- '- yes: that token kind and its scopes are the smallest that works (the last checkbox).\n'
  printf -- '- no, with a classic token: cleanup 102, ci-project.sh --fine-grained, start 102 again.\n'
  printf -- '- no, with a fine-grained token too: stop. Bring the alternatives back to the admin.\n'
  printf -- '  Never widen a classic token to the repo scope.\n'
}

results_101() {
  local pr head author decision state
  printf '\nRead back from GitHub:\n\n'
  pr=$(gh pr list --repo "$REPO" --head "$FACTORY_PR_BRANCH" --state all --limit 1 \
    --json number,author,reviewDecision,headRefOid,state \
    --jq '.[0] // empty | [.number, .headRefOid, .author.login, .reviewDecision // "", .state] | join("|")')
  if [[ -z $pr ]]; then printf -- '- No PR from %s.\n' "$FACTORY_PR_BRANCH"; return; fi
  IFS='|' read -r pr head author decision state <<<"$pr"
  printf -- '- PR #%s: author `%s`, reviewDecision `%s`, state `%s`.\n' \
    "$pr" "$author" "${decision:-(empty)}" "$state"
  printf -- '  (While `main` requires 0 approvals, an empty reviewDecision is expected; the\n'
  printf -- '  approval below and the reviewer job'"'"'s `review=<login>:APPROVED` line are the record.)\n'
  # Every review, in order. The reviewer's file comment is a second review (COMMENTED) after its
  # APPROVE, so "latest review per author" hides the approval; list them all instead.
  gh api "repos/$REPO/pulls/$pr/reviews?per_page=100" --jq '
    "- Approved by \([.[] | select(.state == "APPROVED") | "`\(.user.login)`"] | unique
      | if length == 0 then "nobody" else join(", ") end).",
    "- Reviews by author, each oldest first:",
    (group_by(.user.login)[] | "  - `\(.[0].user.login)`: \(map(.state) | join(", "))")' ||
    die 1 "gh api reviews of PR #$pr failed"
  printf -- '- Workflow runs on its head commit (CI started if any ran; `action_required` means it waited):\n'
  gh run list --repo "$REPO" --commit "$head" --json workflowName,event,status,conclusion \
    --jq '.[] | "  - \(.workflowName) (\(.event)): \(.status) \(.conclusion)"'
  if gh api "repos/$REPO/git/ref/tags/$TAG" --silent >/dev/null 2>&1; then
    printf -- '- Tag `%s` EXISTS: the refusal failed; delete it by hand.\n' "$TAG"
  else
    printf -- '- Tag `%s` does not exist.\n' "$TAG"
  fi
}

cleanup() {
  local reply pr b
  printf 'This closes the throwaway PR unmerged and deletes the throwaway branches of #%s.\n' "$issue"
  printf 'Run results first: the run logs stay, the branches go. Go ahead? [y/N] '
  read -r reply || true
  [[ $reply =~ ^[Yy] ]] || die 2 "nothing changed"
  # The PR first: deleting its base branch would close it without the comment.
  if [[ -n $pr_head ]]; then
    # --head matches the branch name only, so a fork's PR could match it too: only ours.
    pr=$(gh pr list --repo "$REPO" --head "$pr_head" --state open --json number,isCrossRepository \
      --jq 'map(select(.isCrossRepository | not)) | .[0].number // empty')
    if [[ -n $pr ]]; then
      gh pr close "$pr" --repo "$REPO" --comment "Throwaway for #$issue's checks: closed unmerged." >/dev/null ||
        die 1 "closing PR #$pr failed"
      printf 'closed PR #%s unmerged\n' "$pr"
    fi
  fi
  local branches=("$branch")
  [[ $issue == 101 ]] && branches+=("$FACTORY_PR_BRANCH" "$PROBE_BRANCH")
  [[ -n $base ]] && branches+=("$base")
  for b in "${branches[@]}"; do
    if gh api "repos/$REPO/git/ref/heads/$b" --silent >/dev/null 2>&1; then
      gh api -X DELETE "repos/$REPO/git/refs/heads/$b" --silent || die 1 "deleting $b failed"
      printf 'deleted branch %s\n' "$b"
    fi
  done
}

case $cmd in
  start) start ;;
  results) results ;;
  cleanup) cleanup ;;
  *) usage; exit 2 ;;
esac

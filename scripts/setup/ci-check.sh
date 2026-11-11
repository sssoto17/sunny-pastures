#!/usr/bin/env bash
# Runs the throwaway checks for #101 (the two Apps) and #103 (Claude in Actions), collects their
# results and cleans up. `start` pushes a branch from origin/main plus one draft workflow from
# scripts/setup/workflows/, built in a temporary worktree, so your checkout and main are never
# touched; the push runs the workflow. `results` prints a Markdown summary of non-secret fields
# for the issue comment. `cleanup` closes the throwaway PR unmerged and deletes the branches.
# Run ci-apps.sh and ci-claude.sh first. Tests: scripts/setup/ci-check.test.sh.
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
usage: scripts/setup/ci-check.sh start|results|cleanup 101|103

  start 101    push throwaway/101-identities with check-101-identities.yml; the push runs it
  start 103    push throwaway/103-claude with check-103-claude.yml (three short Claude runs)
  results N    print the latest run's results as Markdown, for a comment on issue N:
                 scripts/setup/ci-check.sh results 101 > .scratch/101-results.md
               then read it and post it: gh issue comment 101 --body-file .scratch/101-results.md
  cleanup N    close the throwaway PR unmerged and delete the throwaway branches (asks first)

It works on the clone it lives in, whatever directory you run it from, and refuses unless that
clone's origin is sssoto17/sunny-pastures. Nothing it prints is secret: logins, states, exit codes,
costs and minutes. Pushing a workflow file over HTTPS with gh's credentials needs the `workflow`
scope: gh auth refresh -h github.com -s workflow (it prints a one-time code, not a token).

Exit codes: 0 done; 1 a git or gh command failed; 2 refused (usage, gh signed out, the branch
already exists); 3 no finished run yet: wait and run results again.
EOF
}

die() { # code message
  printf 'ci-check: %s\n' "$2" >&2
  exit "$1"
}

[[ ${1-} == -h || ${1-} == --help ]] && { usage; exit 0; }
(($# == 2)) || { usage; exit 2; }
cmd=$1 issue=$2
case $issue in
  101) branch=throwaway/101-identities workflow=check-101-identities.yml ;;
  103) branch=throwaway/103-claude workflow=check-103-claude.yml ;;
  *) usage; exit 2 ;;
esac
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
gh auth status >/dev/null 2>&1 || die 2 "gh is signed out: run gh auth login"

official_url() { # url: is it exactly sssoto17/sunny-pastures on GitHub, with no userinfo?
  case $1 in
    "https://github.com/$REPO" | "https://github.com/$REPO.git" | "git@github.com:$REPO.git" | \
      "git@github.com:$REPO" | "ssh://git@github.com/$REPO.git" | "ssh://git@github.com/$REPO") ;;
    *) return 1 ;;
  esac
}

# start works on the clone this script lives in, never on the current directory's repo, and only
# when that clone's origin is $REPO: run from another clone, it must not push anything there.
start() {
  # repo is global: the EXIT trap below reads it after start returns.
  repo=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) ||
    die 2 "$here isn't inside a git clone of $REPO"
  # Both the fetch and the push URL, as git resolves them (insteadOf, pushInsteadOf and pushurl
  # applied), must be exactly sunny-pastures on GitHub, with no userinfo. Neither is ever printed:
  # a URL can carry a credential.
  # Every URL counts: git fetches from the first but pushes to each push URL (--all lists them).
  local kind urls url
  for kind in fetch push; do
    if [[ $kind == push ]]; then
      urls=$(git -C "$repo" remote get-url --push --all origin 2>/dev/null) || urls=""
    else
      urls=$(git -C "$repo" remote get-url --all origin 2>/dev/null) || urls=""
    fi
    [[ -n $urls ]] || die 2 "origin in $repo has no $kind URL: nothing pushed"
    while IFS= read -r url; do
      official_url "$url" ||
        die 2 "a $kind URL of origin in $repo isn't $REPO on GitHub: nothing pushed"
    done <<<"$urls"
  done
  git -C "$repo" fetch -q origin main || die 1 "git fetch origin main failed"
  if git -C "$repo" ls-remote --exit-code -q origin "refs/heads/$branch" >/dev/null 2>&1; then
    die 2 "$branch already exists on origin: run cleanup $issue first"
  fi
  scopes=$(gh api -i user 2>/dev/null | tr -d '\r' | grep -i '^x-oauth-scopes:' || true)
  if [[ -n $scopes && $scopes != *workflow* ]]; then
    printf "ci-check: gh's token lacks the workflow scope; an HTTPS push of a workflow file will\n" >&2
    printf 'be refused. If you push over HTTPS: gh auth refresh -h github.com -s workflow\n' >&2
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-check.XXXXXX")
  trap 'git -C "$repo" worktree remove --force "$tmp/wt" >/dev/null 2>&1; rm -rf "$tmp"' EXIT
  git -C "$repo" worktree add -q --detach "$tmp/wt" origin/main || die 1 "git worktree add failed"
  mkdir -p "$tmp/wt/.github/workflows"
  cp "$here/workflows/$workflow" "$tmp/wt/.github/workflows/$workflow"
  git -C "$tmp/wt" add ".github/workflows/$workflow"
  git -C "$tmp/wt" commit -q -m "chore: throwaway check workflow for #$issue (never merge)" ||
    die 1 "git commit failed"
  git -C "$tmp/wt" push -q origin "HEAD:refs/heads/$branch" ||
    die 1 "git push failed. Missing workflow scope? gh auth refresh -h github.com -s workflow"
  printf 'Pushed %s; the push starts %s. Follow it with:\n' "$branch" "$workflow"
  printf '  gh run list --repo %s --branch %s\n' "$REPO" "$branch"
  printf 'When it has finished: scripts/setup/ci-check.sh results %s\n' "$issue"
}

results() {
  local run id status url
  run=$(gh run list --repo "$REPO" --branch "$branch" --limit 1 \
    --json databaseId,status,conclusion,url --jq '.[0] // empty | "\(.databaseId)\t\(.status)\t\(.url)"') ||
    die 1 "gh run list failed"
  [[ -n $run ]] || die 3 "no run on $branch yet: run start $issue first"
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
  return 0
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
  printf -- '  reviewer job'"'"'s `review=<login>:APPROVED` line above is the record.)\n'
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
  if [[ $issue == 101 ]]; then
    pr=$(gh pr list --repo "$REPO" --head "$FACTORY_PR_BRANCH" --state open --json number --jq '.[0].number // empty')
    if [[ -n $pr ]]; then
      gh pr close "$pr" --repo "$REPO" --comment "Throwaway for #101's checks: closed unmerged." >/dev/null ||
        die 1 "closing PR #$pr failed"
      printf 'closed PR #%s unmerged\n' "$pr"
    fi
  fi
  local branches=("$branch")
  [[ $issue == 101 ]] && branches+=("$FACTORY_PR_BRANCH" "$PROBE_BRANCH")
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

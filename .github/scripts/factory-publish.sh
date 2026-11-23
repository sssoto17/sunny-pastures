#!/usr/bin/env bash
# Checks the factory's hand-off before anything is pushed (#107; ADR-0002, area 2, "The factory
# workflow, built"). Claude works in the `factory` job with no write credential and leaves its
# work as a hand-off: a gzipped tar of `branch` (one line, <n>-<slug>), `pr-body.md` (title on the
# first line), `labels` (one per line) and `commits.bundle` (a git bundle of the branch). The
# `publish` job, on a fresh runner that never ran the model, calls this from a checkout of main;
# only if it passes does that job mint the App's token, push the branch and open the PR.
#
# Everything in the hand-off is untrusted: the model wrote it, and a model in a job with sudo could
# have written anything. Refused: an entry outside those four names or not a regular file; a
# branch that isn't <n>-<slug> for this issue or already exists here; a title that is empty or
# over 256 characters; a body without `Closes #<n>`; a label outside review:admin and area:*;
# a bundle git can't verify; no commits, or more than 100; a diff that touches .github/workflows/
# or tests/acceptance/ (the App can't push workflows, and guard / acceptance fails a [bot] PR there);
# a commit whose author or committer isn't the App's bot user.
#
# Fix mode (#588), with FIX_BRANCH set: the run fixed an open factory PR, and BASE is that PR's head.
# The hand-off then holds a fifth entry, `comment`, and any of `commits.bundle`, `pr-body.md`,
# `labels` and `comment` may be empty (a label or body fix needs no commit). Refused besides the
# above: a branch that isn't FIX_BRANCH; commits that don't descend from BASE (publish pushes
# without force); a non-empty body without `Closes #<n>` (it replaces the PR's body whole, with no
# title line); a comment that isn't one line starting `escalated: ` (CONSTRAINTS.md, "Escalation
# criteria"), up to 300 characters. The diff and identity checks run on the new commits only.
#
# Env: ISSUE (the gate's checked number), HANDOFF (the tar.gz), WORK (an empty directory to unpack
# into), BASE (main's commit to diff against), BOT and BOT_ID (the App's bot user,
# sunny-factory[bot], and its user id, pinned in factory.yml),
# GITHUB_OUTPUT; FIX_BRANCH in fix mode. Run inside the repository the branch
# is fetched into. Writes branch=, labels= (comma-separated) and body= (the body file) and logs one
# PUBLISH line; in fix mode also commits= (the count) and comment=, and body= and comment= are
# empty when their file is. Exit codes: 0 passed; 1 refused, nothing fetched past the check that failed.
# Tests: .github/scripts/tests/factory-publish.test.mjs
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"
: "${ISSUE:?ISSUE is not set}" "${HANDOFF:?HANDOFF is not set}" "${WORK:?WORK is not set}" "${BASE:?BASE is not set}"
: "${BOT:?BOT is not set}" "${BOT_ID:?BOT_ID is not set}"

esc() { local s=${1//'%'/%25}; s=${s//$'\r'/%0D}; printf '%s' "${s//$'\n'/%0A}"; }
refuse() { # message
  local m
  m=$(esc "$1")
  echo "PUBLISH refused: $m"
  echo "::error title=factory publish refused::$m"
  [[ -z ${GITHUB_STEP_SUMMARY:-} ]] || printf 'Publish refused: %s\n' "$m" >>"$GITHUB_STEP_SUMMARY"
  exit 1
}

[[ $BOT_ID =~ ^[1-9][0-9]*$ ]] || refuse "BOT_ID $(printf %q "$BOT_ID") isn't a user id"
[[ $ISSUE =~ ^[1-9][0-9]{0,6}$ ]] || refuse "ISSUE $(printf %q "$ISSUE") isn't an issue number"

# The entries, before anything is unpacked: exactly these names, each a regular file.
listing=$(tar -tvzf "$HANDOFF" 2>/dev/null) || refuse "the hand-off isn't a readable tar.gz"
while IFS= read -r line; do
  [[ -n $line ]] || continue
  [[ ${line:0:1} == - ]] || refuse "the hand-off holds something that isn't a regular file"
done <<<"$listing"
fix=${FIX_BRANCH-}
want="branch commits.bundle labels pr-body.md "
[[ -z $fix ]] || want="branch comment commits.bundle labels pr-body.md "
names=$(tar -tzf "$HANDOFF" | sort | tr '\n' ' ')
[[ $names == "$want" ]] ||
  refuse "the hand-off holds $(printf %q "$names"), not $want"
tar -xzf "$HANDOFF" -C "$WORK" --no-same-owner --no-same-permissions

branch=$(head -n1 "$WORK/branch")
[[ $branch =~ ^$ISSUE-[a-z0-9-]+$ ]] || refuse "the branch $(printf %q "$branch") isn't $ISSUE-<slug>"
((${#branch} <= 100)) || refuse "the branch name is over 100 characters"
if [[ -n $fix ]]; then
  [[ $branch == "$fix" ]] || refuse "the branch $branch isn't the PR's branch $fix"
else
  ! git rev-parse -q --verify "refs/heads/$branch" >/dev/null || refuse "the branch $branch already exists here"
fi

body=$WORK/pr-body.md
if [[ -n $fix && ! -s $body ]]; then
  body=""
elif [[ -z $fix ]]; then
  title=$(head -n1 "$body")
  [[ -n ${title//[[:space:]]/} ]] || refuse "the PR body has no title on its first line"
  ((${#title} <= 256)) || refuse "the title is over 256 characters"
fi
[[ -z $body ]] || grep -qiE "(^|[^[:alnum:]])closes #$ISSUE([^0-9]|$)" "$body" || refuse "the PR body doesn't say Closes #$ISSUE"

comment=""
if [[ -n $fix && -s $WORK/comment ]]; then
  comment=$WORK/comment
  (($(grep -c '' "$comment") == 1)) || refuse "the comment isn't one line"
  c=$(head -n1 "$comment")
  [[ $c == "escalated: "* ]] || refuse "the comment doesn't start with 'escalated: '"
  ((${#c} <= 300)) || refuse "the comment is over 300 characters"
fi

labels=()
while IFS= read -r l || [[ -n $l ]]; do
  l=${l//[[:space:]]/}
  [[ -n $l ]] || continue
  [[ $l == review:admin || $l =~ ^area:[a-z0-9-]+$ ]] || refuse "the label $(printf %q "$l") isn't review:admin or area:*"
  labels+=("$l")
done <"$WORK/labels"

# The commits. A fix with none (an empty bundle) has nothing more to check.
if [[ -n $fix && ! -s $WORK/commits.bundle ]]; then
  {
    echo "branch=$branch"
    echo "labels=$(IFS=,; echo "${labels[*]-}")"
    printf 'body=%s\ncomment=%s\ncommits=0\n' "$body" "$comment"
  } >>"$GITHUB_OUTPUT"
  echo "PUBLISH ok: fix on $branch, no commits, labels: ${labels[*]-none}, body: ${body:+replaced}${body:-unchanged}"
  exit 0
fi
git bundle verify -q "$WORK/commits.bundle" >/dev/null 2>&1 || refuse "git can't verify the bundle against main"
git fetch -q --no-tags "$WORK/commits.bundle" "refs/heads/$branch:refs/heads/$branch" 2>/dev/null ||
  refuse "the bundle has no branch $branch"
[[ -z $fix ]] || git merge-base --is-ancestor "$BASE" "refs/heads/$branch" ||
  refuse "the branch $branch doesn't descend from the PR's head: publish never force-pushes"
count=$(git rev-list --count "$BASE..refs/heads/$branch")
((count >= 1)) || refuse "the branch $branch has no commits past main"
((count <= 100)) || refuse "the branch $branch has $count commits, over 100"
# A pathspec, not a grep over names: git quotes a name with non-ASCII characters, tabs or quotes,
# which a pattern on the listing would miss. A move in or out counts too: rename detection under a
# pathspec sees only the side inside it, as an add or a delete.
git diff --quiet "$BASE...refs/heads/$branch" -- .github/workflows tests/acceptance ||
  refuse "the diff touches .github/workflows/ or tests/acceptance/ (they stay out of factory PRs)"
# Every commit carries the App as author and committer, as the factory job's git config set them.
bot=$(sed 's/[][\.*^$+?(){}|]/\\&/g' <<<"$BOT") # as an ERE, literally
others=$(git log --format='%an <%ae>%n%cn <%ce>' "$BASE..refs/heads/$branch" |
  grep -vxE "$bot <$BOT_ID\+$bot@users\.noreply\.github\.com>" | sort -u | head -n 3 || true)
[[ -z $others ]] || refuse "a commit isn't authored and committed by $BOT: $(printf '%s' "$others" | tr '\n' ';')"

echo "branch=$branch" >>"$GITHUB_OUTPUT"
echo "labels=$(IFS=,; echo "${labels[*]-}")" >>"$GITHUB_OUTPUT"
echo "body=$body" >>"$GITHUB_OUTPUT"
[[ -z $fix ]] || printf 'comment=%s\ncommits=%s\n' "$comment" "$count" >>"$GITHUB_OUTPUT"
echo "PUBLISH ok: ${fix:+fix on }$branch, $count commit(s), labels: ${labels[*]-none}"

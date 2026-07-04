#!/usr/bin/env bash
# Shared rebase-retry push helper for crawl-events.yml's two commit steps
# (persist-caches + commit dataset). Extracted so the retry logic exists in
# exactly one place (AGENTS.md sibling-pattern rule) instead of copy-pasted
# per step.
#
# Bug this fixes (run 28687792336, 2026-07-04): the persist-caches step only
# `git add`s 2 of the ~5 file groups scripts/crawl-tio-agenda.mjs writes
# (checkpoints/images/by-source slice are staged later, by the commit-dataset
# step). After committing just the 2 cache files, the working tree still has
# those other files dirty. A concurrent push from another workflow can then
# reject our push ("fetch first"), and `git rebase origin/main` immediately
# fails with "You have unstaged changes. Please commit or stash them." —
# not a real conflict, just git refusing to rebase over a dirty tree. The
# whole retry loop dies in ~2s instead of actually retrying.
# Fix: stash any leftover dirty/untracked files before rebasing, restore them
# right after, so later steps still see them.
set -e

for attempt in 1 2 3 4 5; do
  if git push origin HEAD:main; then
    echo "push ok on attempt $attempt"
    exit 0
  fi
  echo "push failed (attempt $attempt), rebasing..."
  git fetch origin main || true

  stashed=0
  if [ -n "$(git status --porcelain)" ]; then
    git stash push -u -m "git-push-retry-wip"
    stashed=1
  fi

  if git rebase origin/main; then
    [ "$stashed" = "1" ] && git stash pop
  else
    git rebase --abort
    [ "$stashed" = "1" ] && git stash pop
    sleep 2
    continue
  fi

  sleep $((attempt * 2))
done
echo "::warning::push failed after 5 attempts"
exit 0

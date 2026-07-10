#!/usr/bin/env bash
# Shared rebase-retry push helper for data-refresh workflows.
# Survives concurrent pushes from other workflows that also write to main.
#
# Usage:
#   bash scripts/lib/git-push-with-retry.sh [--branch main] [--max-attempts 10] \
#     [--regenerate-cmd "..."] [--in-place-resolver-cmd "..."] [--stash-dirty]
#
# Examples:
#   bash scripts/lib/git-push-with-retry.sh
#   bash scripts/lib/git-push-with-retry.sh --max-attempts 8
#   bash scripts/lib/git-push-with-retry.sh \
#     --regenerate-cmd "node scripts/generate-keyword-pages-config.mjs"
#   bash scripts/lib/git-push-with-retry.sh \
#     --in-place-resolver-cmd "source scripts/lib/resolve-append-conflicts.sh && resolve_append_conflicts && git add -A"
#   bash scripts/lib/git-push-with-retry.sh --stash-dirty
#
# Behaviour:
#   - Pushes HEAD to origin/<branch>; on rejection, fetches + rebases + retries
#     with linear backoff (attempt * 2 seconds).
#   - Before each rebase, the working tree must be clean or rebase refuses to
#     start ("cannot rebase: You have unstaged changes"). Default: discard any
#     leftover dirty/untracked state with `git reset --hard HEAD` (safe when
#     the caller has already committed everything it cares about, or provides
#     --regenerate-cmd/--in-place-resolver-cmd to recreate it). Pass
#     --stash-dirty instead when a LATER step in the same job still needs
#     files a mid-job checkpoint commit didn't stage (e.g. crawl-events.yml's
#     persist-caches step runs before the tio-agenda per-source slice gets
#     committed) — this stashes the leftover state before rebasing and pops
#     it back right after, instead of discarding it.
#   - On rebase conflict, in priority order:
#       1. If --in-place-resolver-cmd is provided: run it INSIDE the rebase
#          (no abort). The command is expected to resolve all conflicts and
#          stage the resolved files (e.g. via `git add -A`). The helper then
#          calls `git rebase --continue`. This path preserves the local
#          commit and is used by the article generator's append-only files.
#       2. Else if --regenerate-cmd is provided: abort the rebase, hard-reset
#          to origin/<branch>, run the regenerate command (which is expected
#          to re-stage produced files), and create a fresh commit reusing the
#          original commit message (ORIG_HEAD).
#       3. Else: abort the rebase and exit 1.
#
# Caller contract:
#   - Caller must have already configured `git config user.email/user.name`,
#     staged the appropriate files, and created the local commit BEFORE
#     invoking this helper.
#   - Branch defaults to `main` (the only branch any data-refresh workflow
#     in this repo pushes to). Override with --branch if needed.

set -euo pipefail

# Register the seo-404 compat-shard merge driver (.gitattributes
# `merge=compat-shard`) so concurrent rebases of data/seo-404-compat/part-*.json
# auto-resolve as a 3-way SET merge (deduped + sorted) instead of git's default
# line merge keeping both sorted rewrites → ~2x duplicate shards (issue #2988
# follow-up). Local config, idempotent; harmless if the files aren't touched.
git config merge.compat-shard.driver 'node scripts/ci/merge-compat-shard.mjs %O %A %B' || true

# ── Clear orphaned .git/index.lock left by a crashed prior git operation ────
# Same class of bug as scripts/lib/git-commit-data.sh (see that file's header
# comment for the full incident writeup: group-06 production failure,
# 2026-07-06). This script has no flock wrapper of its own — but it doesn't
# need one to hit the same hazard: crawl-events.yml invokes this script
# TWICE in one job (once per source, both steps `continue-on-error: true`),
# sharing one working directory and one `.git`. If the first invocation
# crashes mid `git commit`/rebase (OOM, step timeout) and leaves
# `.git/index.lock` behind, the second invocation's `git fetch`/`rebase`/
# `stash`/`reset` calls would all hit git's "Another git process seems to be
# running..." guard and fail too — silently, since both steps swallow errors.
# By the time THIS script starts running, any prior invocation in the same
# job has already fully exited (steps run sequentially, never concurrently),
# so a leftover `.git/index.lock` here can only be a stale crash artifact,
# never a live lock — safe to clear unconditionally before any operation.
if [ -f ".git/index.lock" ]; then
  echo "⚠️ Found stale .git/index.lock (leftover from a crashed earlier git operation in this job) — removing before proceeding."
  rm -f ".git/index.lock"
fi

BRANCH="main"
MAX_ATTEMPTS=10
REGENERATE_CMD=""
IN_PLACE_RESOLVER_CMD=""
STASH_DIRTY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --max-attempts) MAX_ATTEMPTS="$2"; shift 2 ;;
    --regenerate-cmd) REGENERATE_CMD="$2"; shift 2 ;;
    --in-place-resolver-cmd) IN_PLACE_RESOLVER_CMD="$2"; shift 2 ;;
    --stash-dirty) STASH_DIRTY="1"; shift 1 ;;
    *) echo "::error::Unknown arg: $1"; exit 2 ;;
  esac
done

# --no-verify: skip the .githooks/pre-push sibling-patterns gate. Every caller
# of this helper is a data-refresh workflow pushing generated content to main —
# not a pre-PR dev push, which is what the gate exists for (issue #3809).
# npm ci's `prepare` script activates core.hooksPath=.githooks in CI too, and
# since 2026-07-08 the strict gate deterministically rejected every article
# push (run 29090019854: 13 generated files → 10871 sibling candidates →
# exit 1 → 10/10 push attempts failed → "Article is LOST"), zeroing article
# production. The hook also costs ~4 min per attempt on this repo, longer
# than the interval between concurrent crawler commits to main, so even an
# exit-0 hook would turn every push into a guaranteed-loss race.
attempt=1
until git push --no-verify origin "HEAD:${BRANCH}"; do
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "::error::Failed to push after $MAX_ATTEMPTS attempts"
    exit 1
  fi
  echo "Push rejected (attempt $attempt/$MAX_ATTEMPTS); rebasing onto origin/${BRANCH}..."
  git fetch origin "$BRANCH"
  stashed=0
  if [ -n "$STASH_DIRTY" ]; then
    # Preserve leftover dirty/untracked state instead of discarding it — a
    # later step in this same job still needs it (see --stash-dirty doc
    # above). Only meant for the no-conflict-resolver path; --regenerate-cmd/
    # --in-place-resolver-cmd already have their own recovery story.
    if [ -n "$(git status --porcelain)" ]; then
      git stash push -u -m "git-push-with-retry-wip"
      stashed=1
    fi
  else
    # Defensive: drop any unstaged changes left behind by pre-commit scripts
    # (assemble-jobs-dataset.mjs and similar produce untracked/working-tree
    # state). The commit we want to push is already in HEAD, so working-tree
    # state is garbage. Without this, `git rebase` aborts BEFORE starting with
    # "cannot rebase: You have unstaged changes" — and then `git rebase --abort`
    # in the regen branch errors with "no rebase in progress" (run 25308928460).
    git reset --hard HEAD
  fi
  if ! git rebase "origin/${BRANCH}"; then
    if [ "$stashed" = "1" ]; then
      echo "::warning::Rebase conflict with --stash-dirty active — restoring stashed changes before aborting"
      git stash pop || echo "::error::Failed to restore stash after aborted rebase; stash left in stack for manual recovery"
    fi
    if [ -n "$IN_PLACE_RESOLVER_CMD" ]; then
      echo "Rebase conflict; resolving in place via: $IN_PLACE_RESOLVER_CMD"
      # GIT_EDITOR=: stops `git rebase --continue` from spawning an editor
      # for the conflict-resolution commit message — CI runs with EDITOR
      # unset on a dumb terminal and would otherwise fail with
      # "Terminal is dumb, but EDITOR unset" (run 25166528796).
      # `:` is the POSIX no-op shell builtin; rebase reuses the existing
      # commit message verbatim, which is exactly what we want.
      if eval "$IN_PLACE_RESOLVER_CMD" && GIT_EDITOR=: git rebase --continue; then
        : # success — fall through to retry push
      else
        echo "::error::In-place conflict resolver failed"
        git rebase --abort 2>/dev/null || true
        exit 1
      fi
    elif [ -n "$REGENERATE_CMD" ]; then
      echo "Rebase conflict; regenerating data on top of new base via: $REGENERATE_CMD"
      # Tolerate "no rebase in progress" (when rebase failed to start at all,
      # e.g. due to unstaged changes that the defensive reset above missed).
      git rebase --abort 2>/dev/null || true
      git reset --hard "origin/${BRANCH}"
      eval "$REGENERATE_CMD"
      # Commit only if the regen command produced staged changes; otherwise
      # there is nothing left to push (a no-op rebase outcome is fine).
      if ! git diff --cached --quiet; then
        git commit --reuse-message=ORIG_HEAD || git commit -m "chore: auto-regenerate after rebase conflict"
      else
        echo "No changes after regeneration; nothing to push."
        exit 0
      fi
    else
      echo "::error::Rebase conflict and no resolver provided"
      git rebase --abort 2>/dev/null || true
      exit 1
    fi
  elif [ "$stashed" = "1" ]; then
    # Rebase succeeded cleanly — restore the leftover state for later steps.
    if ! git stash pop; then
      echo "::error::Rebase succeeded but restoring stashed changes failed (conflict with rebased tree); stash left in stack for manual recovery"
      exit 1
    fi
  fi
  attempt=$((attempt + 1))
  sleep $((attempt * 2))
done
echo "Push successful (attempt $attempt)"

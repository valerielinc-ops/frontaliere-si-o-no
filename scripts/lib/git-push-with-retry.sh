#!/usr/bin/env bash
# Shared rebase-retry push helper for data-refresh workflows.
# Survives concurrent pushes from other workflows that also write to main.
#
# Usage:
#   bash scripts/lib/git-push-with-retry.sh [--branch main] [--max-attempts 5] \
#     [--regenerate-cmd "..."] [--in-place-resolver-cmd "..."]
#
# Examples:
#   bash scripts/lib/git-push-with-retry.sh
#   bash scripts/lib/git-push-with-retry.sh --max-attempts 8
#   bash scripts/lib/git-push-with-retry.sh \
#     --regenerate-cmd "node scripts/generate-keyword-pages-config.mjs"
#   bash scripts/lib/git-push-with-retry.sh \
#     --in-place-resolver-cmd "source scripts/lib/resolve-append-conflicts.sh && resolve_append_conflicts && git add -A"
#
# Behaviour:
#   - Pushes HEAD to origin/<branch>; on rejection, fetches + rebases + retries
#     with linear backoff (attempt * 2 seconds).
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

BRANCH="main"
MAX_ATTEMPTS=5
REGENERATE_CMD=""
IN_PLACE_RESOLVER_CMD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --max-attempts) MAX_ATTEMPTS="$2"; shift 2 ;;
    --regenerate-cmd) REGENERATE_CMD="$2"; shift 2 ;;
    --in-place-resolver-cmd) IN_PLACE_RESOLVER_CMD="$2"; shift 2 ;;
    *) echo "::error::Unknown arg: $1"; exit 2 ;;
  esac
done

attempt=1
until git push origin "HEAD:${BRANCH}"; do
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "::error::Failed to push after $MAX_ATTEMPTS attempts"
    exit 1
  fi
  echo "Push rejected (attempt $attempt/$MAX_ATTEMPTS); rebasing onto origin/${BRANCH}..."
  git fetch origin "$BRANCH"
  if ! git rebase "origin/${BRANCH}"; then
    if [ -n "$IN_PLACE_RESOLVER_CMD" ]; then
      echo "Rebase conflict; resolving in place via: $IN_PLACE_RESOLVER_CMD"
      if eval "$IN_PLACE_RESOLVER_CMD" && git rebase --continue; then
        : # success — fall through to retry push
      else
        echo "::error::In-place conflict resolver failed"
        git rebase --abort 2>/dev/null || true
        exit 1
      fi
    elif [ -n "$REGENERATE_CMD" ]; then
      echo "Rebase conflict; regenerating data on top of new base via: $REGENERATE_CMD"
      git rebase --abort
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
  fi
  attempt=$((attempt + 1))
  sleep $((attempt * 2))
done
echo "Push successful (attempt $attempt)"

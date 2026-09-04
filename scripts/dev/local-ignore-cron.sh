#!/usr/bin/env bash
# Local-only ignore for cron/crawler-generated files.
#
# These files are committed by GitHub Actions cron workflows (job crawlers,
# fuel-prices, health-premiums, GSC orphan-queries, weekly-employers, etc.).
# Running them locally — or just pulling — leaves your working tree dirty
# with output diffs that have nothing to do with what you're working on.
#
# We can't .gitignore them (they're tracked), so this script flips
# `--skip-worktree` on each one. That tells git to pretend your local copy
# is unchanged, hiding cron-noise from `git status` / `git add -A`.
#
# State is per-clone (lives in .git/info/), so nothing is committed and
# CI is unaffected.
#
# Usage:
#   scripts/dev/local-ignore-cron.sh apply     # hide cron diffs locally
#   scripts/dev/local-ignore-cron.sh unapply   # restore normal git behavior
#   scripts/dev/local-ignore-cron.sh status    # show which paths are skipped
#   scripts/dev/local-ignore-cron.sh pull      # un-skip → git pull --rebase → re-skip
#
# Caveat: `git pull` fails when a remote update touches a skipped file.
# Use the `pull` subcommand, or unapply manually before pulling.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# --- Paths managed by cron workflows ---
#
# The list itself lives in `scripts/lib/cron-managed-paths.mjs`: it is the
# single source shared with `scripts/prune-merged-worktrees.mjs`, which needs
# the same knowledge to tell cron noise from real uncommitted work. Add a new
# cron path THERE, not here.
#
# Plain paths are passed straight to `git update-index`. Globs are expanded
# via `git ls-files` so directory contents are picked up dynamically.
PATHS=()
while IFS= read -r p; do
  [ -n "$p" ] && PATHS+=("$p")
done < <(node --input-type=module -e \
  'import { CRON_MANAGED_GLOBS } from "./scripts/lib/cron-managed-paths.mjs"; process.stdout.write(CRON_MANAGED_GLOBS.join("\n"));')

if [ ${#PATHS[@]} -eq 0 ]; then
  echo "✖ nessun path caricato da scripts/lib/cron-managed-paths.mjs — abort" >&2
  exit 1
fi

# Resolve PATHS into a deduplicated list of actual tracked files.
resolve_files() {
  for p in "${PATHS[@]}"; do
    if [[ "$p" == *"*"* ]]; then
      git ls-files -- "$p" 2>/dev/null || true
    elif git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
      echo "$p"
    fi
  done | sort -u
}

cmd="${1:-help}"

case "$cmd" in
  apply)
    files=$(resolve_files)
    if [ -z "$files" ]; then
      echo "No matching cron-tracked files found."
      exit 0
    fi
    count=$(echo "$files" | wc -l | tr -d ' ')
    echo "Marking $count cron-managed files as skip-worktree (local-only)..."
    echo "$files" | xargs -I{} git update-index --skip-worktree -- {}
    echo "Done. Cron noise will no longer appear in 'git status'."
    echo "Run '$0 unapply' to restore normal behavior before pulling remote updates to these files."
    ;;
  unapply)
    skipped=$(git ls-files -v | awk '$1 == "S" { print substr($0, 3) }')
    if [ -z "$skipped" ]; then
      echo "No files are currently skip-worktree."
      exit 0
    fi
    count=$(echo "$skipped" | wc -l | tr -d ' ')
    echo "Restoring $count files to normal tracking..."
    echo "$skipped" | xargs -I{} git update-index --no-skip-worktree -- {}
    echo "Done."
    ;;
  status)
    skipped=$(git ls-files -v | awk '$1 == "S" { print substr($0, 3) }')
    if [ -z "$skipped" ]; then
      echo "No files are currently skip-worktree."
    else
      count=$(echo "$skipped" | wc -l | tr -d ' ')
      echo "$count files marked skip-worktree:"
      echo "$skipped" | sed 's/^/  /'
    fi
    ;;
  pull)
    shift || true
    "$0" unapply
    # Un-skipping re-exposes cron-output diffs that would block the rebase.
    # Stash them so pull --rebase has a clean tree, then pop afterwards.
    stashed=0
    if [ -n "$(git status --porcelain)" ]; then
      git stash push -u -m "local-ignore-cron-pull-$(date +%s)" >/dev/null
      stashed=1
    fi
    git pull --rebase "$@"
    if [ "$stashed" = "1" ]; then
      if ! git stash pop >/dev/null; then
        echo "error: failed to restore stashed changes after pull --rebase (conflict with rebased tree)." >&2
        echo "Stash left in stack for manual recovery — resolve, then re-run '$0 apply' yourself." >&2
        exit 1
      fi
    fi
    "$0" apply
    ;;
  help|-h|--help|"")
    sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; s/^#$//' | sed '$d'
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    "$0" help
    exit 1
    ;;
esac

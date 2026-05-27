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

# --- Paths managed by cron workflows. Edit here when a new cron lands. ---
#
# Plain paths are passed straight to `git update-index`. Globs are expanded
# via `git ls-files` so directory contents are picked up dynamically.
PATHS=(
  # Job crawlers — the noisiest set
  "data/all-known-job-slugs.json"
  "data/known-company-slugs.json"
  "data/jobs/by-crawler/*"
  "data/jobs-crawler-adapters/adapters/*"
  "data/jobs-crawler-summaries/by-crawler/*"
  "data/jobs-crawler-parser-proposals.json"
  "data/jobs-keys-snapshot.json"
  "data/jobs-stats-history.json"
  "data/jobs-snapshots-history/*"
  "public/data/expired-jobs.json"

  # SEO / GSC pipelines
  "data/gsc-orphan-queries-clusters.json"
  "data/seo-404-compat-paths.json"
  "data/seo-serp-autopilot-last-run.json"
  "data/seo-serp-experiment-history.json"
  "data/seo-snapshots/*"
  "data/inspection-state.json"

  # Daily refresh feeds
  "data/fuel-prices.json"
  "public/data/fuel-prices.json"
  "data/health-premiums.json"
  "public/data/health-premiums.json"
  "data/health-premiums/*"
  "public/data/health-premiums/*"
  "data/border-wait-current.json"
  "data/border-wait-history/*"
  "public/data/switzerland-unemployment-rate.json"

  # Weekly aggregates
  "data/weekly-employers-delta.json"
  "data/company-logos-broken.json"

  # FAQ batch progress
  "data/batch-faq-progress.json"
)

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
      git stash pop >/dev/null || true
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

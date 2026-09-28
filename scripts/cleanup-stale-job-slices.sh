#!/usr/bin/env bash
# Bounded runner for the weekly stale-job per-crawler phase. Each worker owns
# one slice, its temporary file and its matching expired archive.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

cleanup_slice() {
  local slice="$1"
  echo "──── Cleaning: $slice ────"
  JOBS_SLICE_FILE="$slice" node scripts/cleanup-jobs.mjs
}

# Preserve the historical regular-file guard without doing cleanup work in
# this enumeration pass; only bp_run_bounded below invokes workers.
shopt -s nullglob
slices=()
for slice in data/jobs/by-crawler/*.json; do
  [ -f "$slice" ] && slices+=("$slice")
done
readonly max_parallel=8

export BP_FAILED_FILE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cleanup-stale-failed.txt"
source scripts/lib/bounded-parallel.sh
if ! bp_run_bounded "$max_parallel" cleanup_slice "${slices[@]}"; then
  echo "::error::Per-slice cleanup failed; refusing to commit a partial result."
  sed 's/^/  - /' "$BP_FAILED_FILE"
  exit 1
fi

echo "✅ Bounded parallel per-slice cleanup complete: ${#slices[@]} slice(s), max $max_parallel workers, URL validation delegated to housekeeping"

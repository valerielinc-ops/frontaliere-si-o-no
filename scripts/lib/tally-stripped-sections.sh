#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/tally-stripped-sections.sh — fold the per-section stripped-file
# counts written by strip-section-subtree.sh into the single per-locale
# accumulator its consumers read.
#
#   in :  $RUNNER_TEMP/shard-stripped-<locale>.d/<section>   (one integer each)
#   out:  $RUNNER_TEMP/shard-stripped-<locale>               (their sum)
#
# WHY IT EXISTS. The accumulator used to be maintained in-place by each
# strip-section-subtree.sh invocation (`read; write read+n`). That is a
# read-modify-write on shared state, and deploy.yml now strips the sections
# CONCURRENTLY (bounded-parallel, cap 4) — concurrent invocations lose updates
# and the total comes out too small. It is not a cosmetic number: it is what
# push-locale-shard.sh's shrink guard adds back to reconstruct the BUILT
# (pre-strip) shard size, so an under-report makes a PLANNED section split look
# like a >50% partial-build regression and the guard refuses the push, freezing
# that locale on a stale shard (incident jul20).
#
# The fix is to remove the shared mutable state rather than lock it: each
# section writes its OWN file (no contention, no `flock` dependency — util-linux
# is not guaranteed everywhere this runs, and a silent fallback to the racy path
# is worse than no lock at all), and this script sums them. Summation is
# order-independent and idempotent, so it is safe to run repeatedly; deploy.yml
# runs it once after the fan-out has joined, which is the authoritative call.
#
# Prints the total. Missing/empty tally dir → 0 and NO accumulator write, so a
# run where nothing was stripped is indistinguishable from before (the consumers
# already treat an absent accumulator as 0).
#
# Usage: tally-stripped-sections.sh <locale>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

loc="${1:-}"
if [ -z "$loc" ]; then
  echo "Usage: tally-stripped-sections.sh <locale>" >&2
  exit 1
fi

acc="${RUNNER_TEMP:-/tmp}/shard-stripped-$loc"
acc_dir="$acc.d"

if [ ! -d "$acc_dir" ]; then
  echo 0
  exit 0
fi

total=0
for f in "$acc_dir"/*; do
  [ -f "$f" ] || continue
  n="$(cat "$f" 2>/dev/null || echo 0)"
  # A non-numeric/partial file can only come from a crashed writer; count it as
  # 0 rather than abort — the guard downstream degrades safely on a low tally,
  # and aborting here would take the whole deploy down for a cosmetic counter.
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  total=$(( total + n ))
done

printf '%s' "$total" > "$acc"
echo "$total"

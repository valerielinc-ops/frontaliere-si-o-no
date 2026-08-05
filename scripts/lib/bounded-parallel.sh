#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/bounded-parallel.sh — one bounded-parallel driver for the
# per-section shard fan-outs, replacing the batch-barrier idiom that was
# copy-pasted into five workflow steps.
#
# WHY THIS EXISTS (measured, run 30980769677, `build-locale (it)`).
#
# The old idiom launched MAX_PARALLEL jobs, then waited for ALL of them before
# launching the next MAX_PARALLEL. A batch therefore costs as long as its
# SLOWEST member, and every faster slot sits idle until the batch drains. The
# section list is alphabetical and the sections differ by ~50× in size, so the
# batches were pathologically unbalanced. Per-section wall time of the IT
# "Push section shards" step, derived from that run's own log timestamps:
#
#   batch 1 (07:59:55 → 08:04:03, 4.1 min):  appenzello 0.9 · argovia 3.5 · basilea 3.6 · berna 4.1
#   batch 2 (08:04:03 → 08:06:11, 2.1 min):  glarona 0.6 · giura 0.9 · friburgo 2.1 · ginevra 2.1
#   batch 3 (08:06:11 → 08:08:48, 2.6 min):  nidvaldo 0.8 · neuchatel 1.1 · grigioni 2.5 · lucerna 2.6
#   batch 4 (08:08:48 → 08:11:25, 2.6 min):  obvaldo 0.8 · sciaffusa 1.3 · soletta 2.3 · sangallo 2.6
#   batch 5 (08:11:25 → 08:24:49, 13.4 min): svitto 1.5 · turgovia 2.4 · svizzera 4.5 · TICINO 13.4
#   batch 6 (08:24:49 → 08:27:35, 2.8 min):  uri 0.8 · zugo 1.6 · vallese 2.3 · vaud 2.8
#   batch 7 (08:27:35 → 08:30:44, 3.2 min):  zurigo 3.2                     ← 3 idle slots
#
#   total work = 64.3 min across 25 sections; step wall = 30.8 min (52% of the
#   4 slots idle). Batch 5 alone burned 13.4 min of wall for 21.8 min of work
#   because ticino (305k files, 6.1 GB) landed in the same alphabetical batch
#   as svitto (14k) and turgovia (24k), which finished in ~2 min and then
#   waited 11 min doing nothing.
#
# Two changes, both pure scheduling — neither raises peak concurrency, peak
# RSS, or peak runner disk, so none of the OOM/disk mitigations documented in
# deploy.yml are affected:
#
#   1. SLIDING WINDOW instead of a batch barrier: a finished slot immediately
#      takes the next section. In-flight count is still hard-capped at
#      MAX_PARALLEL, which is the invariant issue #4734 actually needs (peak
#      `stage` disk scales with concurrent pushes, not with list length).
#      With the durations above this alone yields ~21.7 min.
#   2. LONGEST-FIRST ordering (LPT): sections are ordered by the real file
#      count of their dist subtree, descending, so ticino starts at t=0
#      instead of at t=8.3 min. Makespan becomes max(longest section, work/N)
#      = max(13.4, 16.1) ≈ 16-17 min.
#
# The size probe is derived from the tree that is about to be pushed — there
# is no hard-coded size table to drift out of date when a canton grows.
#
# The sliding-window primitive is NOT invented here: it is the same
# `jobs -rp` + `wait -n` construct already proven in
# .github/workflows/post-deploy-validate-dist.yml ("wait_slot"). This file
# makes it the single shared implementation instead of a sixth copy.
#
# Usage (source, don't exec):
#
#   source scripts/lib/bounded-parallel.sh
#   worker() { bash scripts/lib/push-section-shard.sh "$1" it dist; }
#   BP_FAILED_FILE=$RUNNER_TEMP/failed.txt
#   bp_run_bounded 4 worker $(bp_section_order dist it)
#
# Contract:
#   - `bp_run_bounded <max> <fn> <item…>` runs `<fn> <item>` for EVERY item,
#     at most `<max>` at a time, and returns only after all have finished.
#   - A worker's non-zero exit never aborts the fan-out (one shard's failure
#     must never skip the rest — incident 2026-07-24, run 30057726623) and is
#     recorded, one item per line, in `$BP_FAILED_FILE` when that variable is
#     set and non-empty. `bp_run_bounded` returns 1 if any item failed, 0
#     otherwise.
#   - `bp_section_order <dist_dir> <locale>` prints EXACTLY the sections
#     `deploy-shard-sections.sh` prints — same set, no drops, no dupes — only
#     reordered. That equality is asserted, and a mismatch is a HARD ERROR
#     (exit 1), never a silent partial list: silently dropping a section here
#     would leave that shard serving its previous build with no signal at all.
#
# Caveat: `bp_run_bounded` counts slots with `jobs -rp`, so the calling shell
# must not have unrelated background jobs in flight while it runs.
# ─────────────────────────────────────────────────────────────────────────────

# Block until fewer than $1 background jobs of the CALLING shell are running.
# `wait -n` returns as soon as any one of them exits; `|| true` absorbs both a
# non-zero child status (handled by the caller via $BP_FAILED_FILE) and the
# "no unwaited-for children" case.
bp_wait_slot() {
  local max="$1"
  while [ "$(jobs -rp | wc -l)" -ge "$max" ]; do
    wait -n 2>/dev/null || true
  done
}

# bp_run_bounded <max_parallel> <worker_fn> <item…>
bp_run_bounded() {
  local max="$1" fn="$2"
  shift 2
  local failed_file="${BP_FAILED_FILE:-}"
  local item

  if [ -n "$failed_file" ]; then
    : > "$failed_file"
  fi

  for item in "$@"; do
    bp_wait_slot "$max"
    # The worker runs inside a subshell that ALWAYS exits 0, so slot
    # accounting never depends on the worker's status and `wait -n` can never
    # abort the driver under `set -e`. The real outcome travels through
    # $BP_FAILED_FILE instead. `set +e` matters because the GitHub Actions
    # default shell is `bash -eo pipefail`, which propagates errexit into
    # subshells — without it the append below would be skipped on failure and
    # the failed item would vanish (same trap documented in
    # post-deploy-validate-dist.yml's `spawn_capped`).
    (
      set +e
      "$fn" "$item"
      rc=$?
      if [ "$rc" -ne 0 ] && [ -n "$failed_file" ]; then
        # One short line written with a single append-mode printf: under
        # PIPE_BUF this is atomic, so concurrent workers cannot interleave.
        printf '%s\n' "$item" >> "$failed_file"
      fi
      exit 0
    ) &
  done
  wait

  if [ -n "$failed_file" ] && [ -s "$failed_file" ]; then
    return 1
  fi
  return 0
}

# bp_section_order <dist_dir> <locale> [repo_root]
#
# Print the deployable section keys ordered by descending file count of the
# locale's dist subtree (ties broken alphabetically for determinism). Sections
# with no subtree in this build sort last with count 0 — they are still
# printed, because push-section-shard.sh is the component that decides to skip
# them, and dropping them here would turn an explicit "subtree absent" log
# line into an invisible omission.
#
# Results are memoised per (dist_dir, locale) in $RUNNER_TEMP so the second
# consumer in the same job (the "Pack section shard dist" step) does not pay
# for a second full walk of dist. The cache is only trusted when it holds the
# same SET of sections the section list yields right now.
bp_section_order() {
  local dist_dir="$1" loc="$2" repo_root="${3:-$(pwd)}"
  local slugs_json="$repo_root/scripts/lib/section-shard-slugs.json"
  local sections cache ordered section slug sub n

  sections="$(bash "$repo_root/scripts/lib/deploy-shard-sections.sh")" || return 1
  if [ -z "$sections" ]; then
    echo "bp_section_order: deploy-shard-sections.sh printed nothing — refusing to schedule an empty fan-out" >&2
    return 1
  fi

  cache="${RUNNER_TEMP:-/tmp}/bp-section-order-${loc}.txt"
  if [ -s "$cache" ] \
     && [ "$(sort "$cache")" = "$(printf '%s\n' "$sections" | sort)" ]; then
    cat "$cache"
    return 0
  fi

  ordered="$(
    while IFS= read -r section; do
      [ -n "$section" ] || continue
      slug="$(jq -r --arg s "$section" --arg l "$loc" '.[$s][$l] // empty' "$slugs_json" 2>/dev/null || true)"
      if [ "$loc" = "it" ]; then sub="$slug"; else sub="$loc/$slug"; fi
      n=0
      if [ -n "$slug" ] && [ -d "$dist_dir/$sub" ]; then
        n="$(find "$dist_dir/$sub" -type f 2>/dev/null | wc -l)"
      fi
      printf '%s\t%s\n' "$n" "$section"
    done <<< "$sections" | sort -k1,1nr -k2,2 | cut -f2
  )"

  # HARD invariant: reordering must be a permutation of the input. A section
  # lost here would silently stop being pushed and its shard would keep
  # serving a stale build with no error anywhere — exactly the failure mode
  # deploy-shard-sections.sh's own header exists to prevent.
  if [ "$(printf '%s\n' "$ordered" | sort)" != "$(printf '%s\n' "$sections" | sort)" ]; then
    echo "bp_section_order: ordered set differs from the section list — refusing to schedule a partial fan-out" >&2
    return 1
  fi

  printf '%s\n' "$ordered" > "$cache" 2>/dev/null || true
  printf '%s\n' "$ordered"
}

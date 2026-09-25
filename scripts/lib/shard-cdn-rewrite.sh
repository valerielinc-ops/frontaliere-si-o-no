#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/shard-cdn-rewrite.sh — deferred CDN rewrite of a section shard's
# staged copy (SHARD_DELTA_CDN_REWRITE=changed). Sourced, never executed.
#
# WHY. push-section-shard.sh stages dist/<sub> into
# $RUNNER_TEMP/<section>-src-<loc>/dist and used to run
# offload-generated-images-cdn.mjs over EVERY staged file before pushing. In
# delta mode the push only ever reads the changed + unmanifested-overlay files
# (~26% on run 35440963700): the unchanged ones come from the shard's HEAD,
# which already holds their rewritten bytes. Rewriting them anyway was ~half of
# the EN "Push section shards" wall time (ticino-en: 490k files).
#
# With the variable on, the push rewrites only the files it reads (the offload
# --files-from list), and the rest of the staged copy — which the "Pack section
# shard dist" step tars for post-deploy-validate-dist, a hard publish gate —
# is completed by ONE full pass started in the background right after that
# section's push, overlapping the pushes of the other sections. The offload is
# idempotent, so the completed staged copy is byte-identical to the one the
# historical single full pass produced.
#
# Markers, all in $RUNNER_TEMP (fresh per job):
#   shard-cdn-partial-<section>-<loc>   the push used a partial rewrite; the
#                                       staged copy is NOT complete until...
#   shard-cdn-done-<section>-<loc>      ...this exists; it holds the exit code
#                                       of the completing full pass.
#   shard-cdn-rewrite-<section>-<loc>.log  that pass's output.
#
# With the variable off, no partial marker is ever written and every function
# below is a no-op that returns 0 — the pack steps stay byte-identical.
# ─────────────────────────────────────────────────────────────────────────────

# shard_cdn_rewrite_enabled <push_mode> — 0 when the deferred rewrite applies.
# Only `changed` enables it and only in delta mode (full mode reads every
# staged file, so there is nothing to skip). An unknown value warns and stays
# OFF: a typo in a repository variable must never change what gets published.
shard_cdn_rewrite_enabled() {
  local mode="$1" value="${SHARD_DELTA_CDN_REWRITE:-}"
  case "$value" in
    ''|off|full) return 1 ;;
    changed) [ "$mode" = delta ] ;;
    *)
      echo "::warning::unsupported SHARD_DELTA_CDN_REWRITE '$value' (expected changed|off) — full CDN rewrite" >&2
      return 1
      ;;
  esac
}

# shard_cdn_rewrite_launch <runner_temp> <section> <loc> <stage_src> <offload_script> <cdn_base>
# Starts the completing full pass detached from the caller's stdout/stderr
# (bounded-parallel reads the worker's output; an inherited pipe would make
# it wait for the background pass). The done marker is written via a rename so
# a reader never sees a half-written exit code.
shard_cdn_rewrite_launch() {
  local runner_temp="$1" section="$2" loc="$3" stage_src="$4" offload="$5" cdn_base="$6"
  local done_file="$runner_temp/shard-cdn-done-$section-$loc"
  local log_file="$runner_temp/shard-cdn-rewrite-$section-$loc.log"
  rm -f "$done_file" "$done_file.tmp"
  (
    rc=0
    ( cd "$stage_src" && CDN_BASE="$cdn_base" node "$offload" --strict ) >"$log_file" 2>&1 || rc=$?
    printf '%s' "$rc" > "$done_file.tmp" && mv "$done_file.tmp" "$done_file"
  ) </dev/null >/dev/null 2>&1 &
  echo "$section-$loc shard: completing the staged CDN rewrite in background (pid $!) for the validate-dist pack"
}

# shard_cdn_rewrite_wait_all <runner_temp> [max_seconds]
# Barrier + repair, called at the top of both pack steps BEFORE any live gate.
# The staged files are hardlinked to dist/<sub>, which later steps read for a
# section that is not stripped, so the barrier must cover every section, live
# or not. It (1) waits for every background pass — with no time limit by
# default (0): the job timeout bounds it, and giving up while a writer is still
# rewriting files in place would hand later steps a tree under modification;
# (2) re-runs, synchronously and in strict mode, the full pass of any section
# whose background pass exited non-zero, and records the new exit code. The
# offload is idempotent, so the retry never changes a byte already rewritten.
# A section that still fails is NOT packed (shard_cdn_rewrite_ready), and its
# dist/<sub> is harmless by construction: stripped → never published from the
# apex; not stripped → the leg's later full-dist offload ("Offload shard refs
# to CDN" on en/de/fr, deploy-it-pages-prep.sh on it) rewrites it, as it does
# today for any section whose push failed. Returns 1 only on timeout or on a
# section that stays failed.
shard_cdn_rewrite_wait_all() {
  local runner_temp="$1" max="${2:-0}" started="$SECONDS" partial pending key rc
  local stage_src offload cdn_base failed=0
  while :; do
    pending=0
    for partial in "$runner_temp"/shard-cdn-partial-*; do
      [ -e "$partial" ] || continue
      if [ ! -f "$runner_temp/shard-cdn-done-${partial##*/shard-cdn-partial-}" ]; then
        pending=$((pending + 1))
      fi
    done
    [ "$pending" -eq 0 ] && break
    if [ "$max" -gt 0 ] && [ $((SECONDS - started)) -ge "$max" ]; then
      echo "::warning::$pending background CDN rewrite(s) still running after ${max}s — those sections will not be packed (validate-dist falls back to git clone)"
      return 1
    fi
    sleep 2
  done
  for partial in "$runner_temp"/shard-cdn-partial-*; do
    [ -e "$partial" ] || continue
    key="${partial##*/shard-cdn-partial-}"
    rc="$(cat "$runner_temp/shard-cdn-done-$key")"
    [ "$rc" = 0 ] && continue
    { IFS= read -r stage_src; IFS= read -r offload; IFS= read -r cdn_base; } < "$partial"
    echo "::warning::$key background CDN rewrite exited $rc — re-running the full pass synchronously"
    rc=0
    if [ -n "$stage_src" ] && [ -d "$stage_src" ] && [ -n "$offload" ] && [ -n "$cdn_base" ]; then
      ( cd "$stage_src" && CDN_BASE="$cdn_base" node "$offload" --strict ) \
        >> "$runner_temp/shard-cdn-rewrite-$key.log" 2>&1 || rc=$?
    else
      rc=1
    fi
    printf '%s' "$rc" > "$runner_temp/shard-cdn-done-$key.tmp" \
      && mv "$runner_temp/shard-cdn-done-$key.tmp" "$runner_temp/shard-cdn-done-$key"
    if [ "$rc" != 0 ]; then
      echo "::error::$key staged CDN rewrite failed twice (exit $rc) — not packed; the pushed shard tree is complete, and a non-stripped dist/<sub> is rewritten by the leg's full-dist offload"
      failed=1
    fi
  done
  return "$failed"
}

# shard_cdn_rewrite_ready <runner_temp> <section> <loc>
# 0 when the staged copy of <section>-<loc> is fully rewritten: either the
# push never deferred (variable off, full mode, delta fallback) or the
# completing pass finished with exit 0. Prints the log tail otherwise.
shard_cdn_rewrite_ready() {
  local runner_temp="$1" section="$2" loc="$3" rc
  local done_file="$runner_temp/shard-cdn-done-$section-$loc"
  local log_file="$runner_temp/shard-cdn-rewrite-$section-$loc.log"
  [ -e "$runner_temp/shard-cdn-partial-$section-$loc" ] || return 0
  if [ ! -f "$done_file" ]; then
    echo "::warning::$section-$loc staged CDN rewrite not finished — skipping pack, validate-dist will fall back to git clone"
    return 1
  fi
  rc="$(cat "$done_file")"
  if [ "$rc" != 0 ]; then
    echo "::warning::$section-$loc staged CDN rewrite failed (exit $rc) — skipping pack, validate-dist will fall back to git clone"
    tail -n 20 "$log_file" 2>/dev/null || true
    return 1
  fi
  tail -n 3 "$log_file" 2>/dev/null || true
  return 0
}

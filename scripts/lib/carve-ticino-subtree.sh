#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/carve-ticino-subtree.sh — carve one locale's Ticino subtree out of
# dist into a tar (for the Ticino shard) and strip it from dist, so the IT apex
# artifact and the en/de/fr locale shards each ship UNDER the 10 GB Pages cap.
#
# Runs in each build-locale matrix leg BEFORE that leg's CDN offload, so the
# carved subtree is RAW (same-origin /data refs intact); the post-matrix
# `push-ticino-shard` job runs the offload once on the assembled four-subtree
# tree (single window.__CDN_DATA_BASE__ injection — no double-offload).
#
# TWO independent gates (mirrors the per-locale shard rollout in
# docs/LOCALE-SHARD-CLOUDFLARE-RUNBOOK.md — populate-then-strip, never the reverse):
#
#   1. SHARD_TICINO_DEPLOY_KEY (secret) — enables the TAR (→ the push job seeds the
#      shard). Absent → full NO-OP: no tar, no strip, build identical to before.
#   2. TICINO_SHARD_LIVE == 'true' (repo variable) — enables the STRIP from dist.
#
# Rollout: set the SECRET first → the shard is seeded additively (tar+push) while
# Ticino STAYS in the apex/locale dist (no strip) → the apex deploy is unchanged
# from today (still over the 10 GB cap, i.e. no regression) but the shard now
# serves. Verify the shard serves /cerca-lavoro-ticino via the Worker, THEN set
# TICINO_SHARD_LIVE=true → the strip activates → the apex artifact drops below
# 10 GB. This ordering guarantees a stripped apex never leaves the section
# unserved.
#
# Usage:
#   carve-ticino-subtree.sh <locale> <dist_dir>
#     <locale>    ∈ {it, en, de, fr}
#     <dist_dir>  build output dir (e.g. "dist")
#
# Output:
#   $RUNNER_TEMP/ticino-shard-<locale>.tar   — carved subtree (when secret set)
#   dist/<ticino-path> removed               — only when TICINO_SHARD_LIVE=true
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

loc="${1:-}"
dist_dir="${2:-}"
if [ -z "$loc" ] || [ -z "$dist_dir" ]; then
  echo "Usage: carve-ticino-subtree.sh <locale> <dist_dir>" >&2
  exit 1
fi

if [ -z "${SHARD_TICINO_DEPLOY_KEY:-}" ]; then
  echo "no SHARD_TICINO_DEPLOY_KEY — Ticino split disabled; leaving $loc Ticino subtree in dist (no-op)"
  exit 0
fi

# Canonical Ticino path per locale. Keep in lockstep with TICINO_ROUTES in
# infra/cloudflare-worker/locale-router.js and TICINO_PATHS in push-ticino-shard.sh.
case "$loc" in
  it) sub="cerca-lavoro-ticino" ;;
  en) sub="en/find-jobs-ticino" ;;
  de) sub="de/jobs-im-tessin" ;;
  fr) sub="fr/trouver-emploi-tessin" ;;
  *) echo "::error::unsupported locale '$loc' (expected it|en|de|fr)" >&2; exit 1 ;;
esac

if [ ! -d "$dist_dir/$sub" ]; then
  echo "$dist_dir/$sub absent — nothing to carve for $loc"
  exit 0
fi

out="${RUNNER_TEMP:-/tmp}/ticino-shard-$loc.tar"

# Pack the subtree at its canonical path so the shard serves the identical path.
# The IT leg also carries 404.html so the shard has the same SPA soft-recovery
# fallback the apex does (deploy-it-pages-prep.sh's `cp index.html 404.html`).
members=( "$sub" )
if [ "$loc" = "it" ] && [ -f "$dist_dir/404.html" ]; then
  members+=( "404.html" )
fi

n="$(find "$dist_dir/$sub" -type f | wc -l)"
tar -C "$dist_dir" -cf "$out" "${members[@]}"
echo "carved $loc Ticino subtree ($sub): $n files → $out ($(du -h "$out" 2>/dev/null | cut -f1))"

# STRIP gate (2): only when TICINO_SHARD_LIVE=true. Until then the subtree is
# tarred (→ shard seeded by the push job) but LEFT in dist, so the apex/locale
# deploy is unchanged from today — the seed phase carries no regression and no
# 404 risk. Once the shard is verified serving, flip the variable to shrink the
# artifact below the 10 GB cap.
if [ "${TICINO_SHARD_LIVE:-}" != "true" ]; then
  echo "TICINO_SHARD_LIVE != true — seed phase: $loc Ticino subtree tarred for the shard but KEPT in dist (no strip yet)"
  exit 0
fi

# Strip from dist so the apex / locale-shard artifact drops below the 10 GB cap.
# Guarded `${dist_dir:?}` so an unset var can never expand `rm -rf /$sub`.
rm -rf "${dist_dir:?}/$sub"
echo "stripped $dist_dir/$sub from dist (now served by the Ticino shard via the Worker)"

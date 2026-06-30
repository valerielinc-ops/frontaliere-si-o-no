#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/strip-ticino-subtree.sh — strip one locale's Ticino subtree from
# dist AFTER its shard has been successfully pushed, so the apex/locale-shard
# artifact drops below the 10 GB Pages cap. Mirrors the per-locale shard's "Strip
# locale shards" step (gated on the push ok-marker + the LIVE variable).
#
# TWO conditions, BOTH required (populate-then-strip, never the reverse):
#   1. TICINO_SHARD_LIVE == 'true' (repo variable) — the owner has flipped the
#      split live AFTER verifying the shards serve.
#   2. $RUNNER_TEMP/shard-ok-ticino-<locale> exists — push-ticino-shard.sh pushed
#      this locale's shard SUCCESSFULLY this run. A failed/skipped push leaves no
#      marker → no strip → Ticino stays in the apex (apex stays >10 GB and the
#      Pages deploy keeps failing, but the section is never left UNSERVED: safe
#      degradation, never a 404).
#
# Usage: strip-ticino-subtree.sh <locale> <dist_dir>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

loc="${1:-}"
dist_dir="${2:-}"
if [ -z "$loc" ] || [ -z "$dist_dir" ]; then
  echo "Usage: strip-ticino-subtree.sh <locale> <dist_dir>" >&2
  exit 1
fi

case "$loc" in
  it) sub="cerca-lavoro-ticino" ;;
  en) sub="en/find-jobs-ticino" ;;
  de) sub="de/jobs-im-tessin" ;;
  fr) sub="fr/trouver-emploi-tessin" ;;
  *) echo "::error::unsupported locale '$loc' (expected it|de|en|fr)" >&2; exit 1 ;;
esac

if [ "${TICINO_SHARD_LIVE:-}" != "true" ]; then
  echo "TICINO_SHARD_LIVE != true — seed phase: keeping $loc Ticino subtree in dist (no strip)"
  exit 0
fi

marker="${RUNNER_TEMP:-/tmp}/shard-ok-ticino-$loc"
if [ ! -f "$marker" ]; then
  echo "::warning::no push ok-marker for $loc Ticino ($marker) — shard push failed/skipped this run; KEEPING the subtree in dist (no strip, no 404)"
  exit 0
fi

if [ ! -d "$dist_dir/$sub" ]; then
  echo "$dist_dir/$sub already absent — nothing to strip for $loc"
  exit 0
fi

# Guarded `${dist_dir:?}` so an unset var can never expand `rm -rf /$sub`.
rm -rf "${dist_dir:?}/$sub"
echo "stripped $dist_dir/$sub from dist (now served by the ticino-$loc shard via the Worker)"

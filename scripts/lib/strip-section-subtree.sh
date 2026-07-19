#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/strip-section-subtree.sh — strip one locale's subtree for ONE
# job-board section (ticino, svizzera, zurigo, …) from dist AFTER its shard has
# been successfully pushed, so the apex/locale-shard artifact drops below the
# 10 GB Pages cap. Generic successor to strip-ticino-subtree.sh (see
# push-section-shard.sh header for the size rationale) — section → URL slug
# comes from the shared scripts/lib/section-shard-slugs.json. Mirrors the
# per-locale shard's "Strip locale shards" step (gated on the push ok-marker +
# the section's LIVE variable).
#
# TWO conditions, BOTH required (populate-then-strip, never the reverse):
#   1. <SECTION>_SHARD_LIVE == 'true' (repo variable, e.g. TICINO_SHARD_LIVE) —
#      the owner has flipped this section's split live AFTER verifying the
#      shards serve.
#   2. $RUNNER_TEMP/shard-ok-<section>-<locale> exists — push-section-shard.sh
#      pushed this (section, locale) shard SUCCESSFULLY this run. A
#      failed/skipped push leaves no marker → no strip → the section stays in
#      the apex (apex stays >10 GB and the Pages deploy keeps failing, but the
#      section is never left UNSERVED: safe degradation, never a 404).
#
# Usage: strip-section-subtree.sh <section> <locale> <dist_dir>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

section="${1:-}"
loc="${2:-}"
dist_dir="${3:-}"
if [ -z "$section" ] || [ -z "$loc" ] || [ -z "$dist_dir" ]; then
  echo "Usage: strip-section-subtree.sh <section> <locale> <dist_dir>" >&2
  exit 1
fi

repo_root="$(pwd)"
slugs_json="$repo_root/scripts/lib/section-shard-slugs.json"

slug="$(jq -r --arg s "$section" --arg l "$loc" '.[$s][$l] // empty' "$slugs_json" 2>/dev/null)"
if [ -z "$slug" ]; then
  echo "::error::unsupported section '$section' / locale '$loc' (no entry in $slugs_json)" >&2
  exit 1
fi
case "$loc" in
  it) sub="$slug" ;;  # cathedral-allow: canonical legacy section path (bash, cannot import resolveCantonSection)
  en|de|fr) sub="$loc/$slug" ;;
  *) echo "::error::unsupported locale '$loc' (expected it|de|en|fr)" >&2; exit 1 ;;
esac

SECTION_UPPER="$(echo "$section" | tr a-z A-Z)"
live_var="${SECTION_UPPER}_SHARD_LIVE"
if [ "${!live_var:-}" != "true" ]; then
  echo "$live_var != true — seed phase: keeping $loc $section subtree in dist (no strip)"
  exit 0
fi

marker="${RUNNER_TEMP:-/tmp}/shard-ok-$section-$loc"
if [ ! -f "$marker" ]; then
  echo "::warning::no push ok-marker for $loc $section ($marker) — shard push failed/skipped this run; KEEPING the subtree in dist (no strip, no 404)"
  exit 0
fi

if [ ! -d "$dist_dir/$sub" ]; then
  echo "$dist_dir/$sub already absent — nothing to strip for $loc $section"
  exit 0
fi

# Guarded `${dist_dir:?}` so an unset var can never expand `rm -rf /$sub`.
rm -rf "${dist_dir:?}/$sub"
echo "stripped $dist_dir/$sub from dist (now served by the $section-$loc shard via the Worker)"

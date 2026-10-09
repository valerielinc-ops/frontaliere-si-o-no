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
#      This holds for IT ONLY. For en/de/fr the retained copy is unreachable
#      (the Worker reads a section path from the section origin, never from
#      the locale shard), so a failed push strips as well — see the marker
#      block below.
#
# CONCURRENCY-SAFE: deploy.yml fans this out over the sections with the shared
# bounded-parallel driver, so several invocations run at once. Every path this
# script touches is section-scoped and therefore disjoint — dist/<sub> is one
# section's own subtree — EXCEPT the per-locale stripped-file accumulator, which
# used to be a read-modify-write shared by all of them. It is now one PRIVATE
# file per section, folded into the accumulator by tally-stripped-sections.sh
# (see the tally block at the bottom) — shared mutable state removed rather than
# locked. A lost update there is not cosmetic: it under-reports the tally, which
# makes push-locale-shard.sh's shrink guard reconstruct too small a pre-strip
# size and refuse the (correctly) smaller main shard — the exact jul20 freeze
# the tally exists to prevent.
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
push_failed=0
if [ ! -f "$marker" ]; then
  if [ "$loc" = it ]; then
    # IT keeps the subtree: the apex Pages origin is what answers when the
    # Worker is bypassed (request_limit_fail_open), so the copy is reachable.
    echo "::warning::no push ok-marker for $loc $section ($marker) — shard push failed/skipped this run; KEEPING the subtree in dist (no strip, no 404)"
    exit 0
  fi
  # en/de/fr with the section LIVE: the retained copy is NOT a fallback. Every
  # /<loc>/* request reaches the Worker (wrangler routes), which resolves a
  # section path against the SECTION origin only — its shard handler never
  # consults the locale shard for it. Measured 2026-10-08: /de/jobs-im-tessin/ and
  # /de/jobs-im-tessin/elektriker/ answer 200 on the apex and on
  # origin-ticino-de while origin-de answers 404, same for fr. Keeping the
  # subtree therefore protects nobody and only inflates the locale shard: in
  # runs 37728960699 and 37754770528 the rejected ticino-de push left 573k files
  # in dist/de, the `de` shard went from 124836 to 657750 files and GitHub
  # refused it too ("non-blob object size limit exceeded"), so the whole
  # locale froze instead of one section. Strip it: the section keeps serving
  # its previous push, the rest of the locale publishes.
  push_failed=1
  echo "::warning::no push ok-marker for $loc $section ($marker) — shard push failed/skipped this run; stripping the subtree from dist anyway: the Worker serves this section from the $section-$loc shard only, the locale-shard copy is never read (section stays on its previous push)"
fi

if [ ! -d "$dist_dir/$sub" ]; then
  echo "$dist_dir/$sub already absent — nothing to strip for $loc $section"
  exit 0
fi

# Delete each file while printing it and count that stream, then add the tally
# to a per-locale accumulator marker. push-locale-shard.sh reads it so
# its >50% shrink guard can reconstruct the BUILT (pre-strip) shard size and
# NOT mistake this PLANNED section split for a partial-build regression. This
# strip only runs after BOTH gates above (section shard LIVE + push ok-marker),
# so the removed content is already verified-live on its own shard — the main
# shard legitimately shrinks by exactly this many files. Without the tally the
# main-shard push refuses the (correctly) smaller shard and the locale freezes
# stale (incident jul20: en/fr main shards stuck when svizzera+zurigo went live
# — 403338→186096 read as a >50% regression).
n_stripped="$(find "${dist_dir:?}/$sub" -type f -print -delete 2>/dev/null | wc -l | tr -d ' ')"
[[ "$n_stripped" =~ ^[0-9]+$ ]] || n_stripped=0
# Guarded `${dist_dir:?}` so an unset var can never expand `rm -rf /$sub`.
rm -rf "${dist_dir:?}/$sub"
# Per-section tally file, NOT a read-modify-write of the shared accumulator.
# deploy.yml fans this script out over the sections, so `read $acc; write
# $acc+n` would lose updates and UNDER-report the total — and this total is
# exactly what push-locale-shard.sh's shrink guard uses to reconstruct the
# pre-strip shard size, so an under-report makes it read a PLANNED split as a
# >50% build regression and refuse the push (the jul20 freeze this tally was
# added to prevent). Writing one private file per section removes the shared
# mutable state instead of guarding it: no lock, no `flock` dependency, and the
# same value whatever the interleaving. `tally-stripped-sections.sh` folds them
# into $acc; the fan-out in deploy.yml calls it once after `wait` (authoritative),
# and the call below keeps a standalone/sequential invocation self-contained.
acc_dir="${RUNNER_TEMP:-/tmp}/shard-stripped-$loc.d"
mkdir -p "$acc_dir"
printf '%s' "$n_stripped" > "$acc_dir/$section"
bash "$(dirname "${BASH_SOURCE[0]}")/tally-stripped-sections.sh" "$loc" >/dev/null 2>&1 || true
if [ "$push_failed" = 1 ]; then
  echo "stripped $dist_dir/$sub from dist ($n_stripped files; push failed this run — the $section-$loc shard keeps serving its previous push via the Worker)"
else
  echo "stripped $dist_dir/$sub from dist ($n_stripped files; now served by the $section-$loc shard via the Worker)"
fi

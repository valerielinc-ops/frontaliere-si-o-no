#!/usr/bin/env bash
# Prints the section keys THIS repo's deploy may push to a shard, one per line.
#
# Every shard push loop in deploy.yml used to inline
#   jq -r 'keys[] | select(startswith("_")|not)' scripts/lib/section-shard-slugs.json
# which yields all 28 sections, including the two article sections. Those moved
# to nanakokyobashi-rgb/frontaliere-articles (issue #4974 item 3): that repo
# renders each article and pushes it to the same shard repos within a minute of
# generation.
#
# WHY THIS IS NOT COSMETIC. `push-section-shard.sh` is FULL-REPLACE by
# construction — it wipes the staged tree (`find "$stage" -mindepth 1
# -maxdepth 1 ! -name '.git' -exec rm -rf {} +`) and repopulates solely from
# the caller's dist subtree. This repo's corpus copy no longer receives the
# articles nanako generates: measured 2026-08-03, fourteen articles live on the
# site were absent from `packages/articles/content/` here. So the next full
# deploy would have replaced each article shard with a tree missing all
# fourteen — silently, because the shrink guard is a PERCENTAGE and fourteen
# pages out of ~3000 is far under any threshold it would trip.
#
# Two producers of one artifact, where the losing one wins by being last. This
# is the same failure §4 flagged for the border-wait ranking JSON and resolved
# by giving it a single owner.
#
# The excluded set comes from `externally-served-paths.mjs`, which derives it
# from the Cloudflare Worker's own SECTION_ROUTES — the same single source of
# truth the sitemap gates use, so an edge routing change cannot leave this list
# behind.
#
# Usage: bash scripts/lib/deploy-shard-sections.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -f "$repo_root/scripts/lib/section-shard-slugs.json" ] || repo_root="$(pwd)"

slugs_json="$repo_root/scripts/lib/section-shard-slugs.json"
if [ ! -f "$slugs_json" ]; then
  echo "deploy-shard-sections: $slugs_json not found" >&2
  exit 1
fi

# Read the excluded set from the shared module rather than restating it.
excluded="$(node -e '
  import("'"$repo_root"'/scripts/lib/externally-served-paths.mjs")
    .then((m) => console.log([...m.EXTERNALLY_SERVED_SECTIONS].join("\n")))
    .catch((e) => { console.error(e.message); process.exit(1); });
')" || { echo "deploy-shard-sections: cannot read EXTERNALLY_SERVED_SECTIONS" >&2; exit 1; }

# A silently-empty exclusion set would restore the wipe this file exists to
# prevent, so treat it as a hard error rather than "nothing to exclude".
if [ -z "$excluded" ]; then
  echo "deploy-shard-sections: EXTERNALLY_SERVED_SECTIONS is empty — refusing to emit a list that would let this repo full-replace the article shards" >&2
  exit 1
fi

jq -r 'keys[] | select(startswith("_")|not)' "$slugs_json" \
  | grep -vxF -f <(printf '%s\n' "$excluded")

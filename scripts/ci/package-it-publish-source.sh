#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source scripts/lib/parallel-tar.sh

out="${IT_PUBLISH_SOURCE_DIR:-${RUNNER_TEMP:?RUNNER_TEMP is required}/it-publish-source}"
plan_dir="$out/plan"
root_dir="$out/root"
groups_dir="$out/groups"
mkdir -p "$plan_dir" "$root_dir" "$groups_dir"

source "$repo_root/scripts/lib/bounded-parallel.sh"
section_order="$(bp_section_order "$repo_root/dist" it "$repo_root")" || {
  echo "::error::cannot compute the IT section set from the full deploy contract" >&2
  exit 1
}
if [ -z "$section_order" ]; then
  echo "::error::the full deploy contract produced an empty IT section set" >&2
  exit 1
fi
sections_json="$(printf '%s\n' "$section_order" | jq -Rsc 'split("\n") | map(select(length > 0))')"
plan_file="$plan_dir/it-shard-group-plan.json"
node scripts/ci/it-shard-group-plan.mjs \
  --repo-root "$repo_root" \
  --dist-dir "$repo_root/dist" \
  --sections-json "$sections_json" \
  --source-run-id "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}" \
  --source-sha "${GITHUB_SHA:?GITHUB_SHA is required}" \
  --build-id "${DEPLOY_BUILD_ID:?DEPLOY_BUILD_ID is required}" \
  --out "$plan_file"

cp "${LOCALE_SITEMAP_MANIFEST_OUT:?LOCALE_SITEMAP_MANIFEST_OUT is required}" "$plan_dir/locale-sitemap-manifest-it.json"
cp dist/assets/expired-archive-evidence-it.json "$plan_dir/expired-archive-evidence-it.json"
mkdir -p "$plan_dir/incremental-manifest" "$plan_dir/og-jobs"
if [ -d .cache/incremental-manifest ]; then
  cp -a .cache/incremental-manifest/. "$plan_dir/incremental-manifest/"
fi
if [ -f .cache/og-jobs/.deferred-fallbacks.json ]; then
  cp .cache/og-jobs/.deferred-fallbacks.json "$plan_dir/og-jobs/.deferred-fallbacks.json"
fi
node - "$plan_dir/deploy-metadata.json" <<'NODE'
const fs = require('node:fs');
const output = process.argv[2];
const fields = ['ARTICLE_ID', 'ARTICLE_URL', 'OG_TITLE', 'OG_DESCRIPTION', 'OG_IMAGE', 'ARTICLE_CATEGORY'];
const metadata = Object.fromEntries(fields.map((key) => [key, process.env[key] || '']));
fs.writeFileSync(output, `${JSON.stringify(metadata)}\n`);
NODE

mapfile -t live_sections < <(jq -r '.requiredSections[]' "$plan_file")
mapfile -t dist_entries < <(find dist -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
live_slugs=()
for section in "${live_sections[@]}"; do
  slug="$(jq -r --arg section "$section" '.[$section].it // empty' scripts/lib/section-shard-slugs.json)"
  [ -n "$slug" ] || { echo "::error::missing IT slug for live section $section"; exit 1; }
  live_slugs+=("$slug")
done

root_members=(public/images data/dist-size-history.jsonl data/url-first-seen.json)
for entry in "${dist_entries[@]}"; do
  is_live_section=false
  for slug in "${live_slugs[@]}"; do
    if [ "$entry" = "$slug" ]; then is_live_section=true; break; fi
  done
  [ "$is_live_section" = false ] && root_members+=("dist/$entry")
done

PTAR_ZSTD=1 ptar_create "$repo_root" "$root_dir" it-publish-root 4 "${root_members[@]}"
rm -f "$root_dir/it-publish-root.members" "$root_dir/it-publish-root.list"
rm -f "$root_dir/it-publish-root.slice."*

while IFS= read -r group_id; do
  [ -n "$group_id" ] || continue
  group_dir="$groups_dir/$group_id"
  mkdir -p "$group_dir"
  mapfile -t sections < <(jq -r --arg id "$group_id" '.groups[] | select(.id == $id) | .sections[]' "$plan_file")
  members=()
  for section in "${sections[@]}"; do
    slug="$(jq -r --arg section "$section" '.[$section].it // empty' scripts/lib/section-shard-slugs.json)"
    [ -n "$slug" ] || { echo "::error::missing IT slug for section $section"; exit 1; }
    [ -d "dist/$slug" ] || { echo "::error::live section source is missing: dist/$slug"; exit 1; }
    members+=("dist/$slug")
  done
  if [ "${#members[@]}" -eq 0 ]; then
    tar -C "$repo_root" -cf "$group_dir/it-shard-source-group-$group_id.tar" --files-from /dev/null
    zstd -q -1 -f "$group_dir/it-shard-source-group-$group_id.tar" -o "$group_dir/it-shard-source-group-$group_id.tar.zst"
    rm -f "$group_dir/it-shard-source-group-$group_id.tar"
  else
    PTAR_ZSTD=1 ptar_create "$repo_root" "$group_dir" "it-shard-source-group-$group_id" 4 "${members[@]}"
  fi
  rm -f "$group_dir/it-shard-source-group-$group_id.members" "$group_dir/it-shard-source-group-$group_id.list"
  rm -f "$group_dir/it-shard-source-group-$group_id.slice."*
done < <(jq -r '.groups[].id' "$plan_file")

echo "IT source bundle prepared: $(jq -c '{requiredSections, groups}' "$plan_file")"

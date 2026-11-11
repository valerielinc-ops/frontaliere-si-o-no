#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
plan_dir="$RUNNER_TEMP/it-publish-plan"
results_dir="$RUNNER_TEMP/it-shard-results"
cd "$repo_root"
test -s "$plan_dir/it-shard-group-plan.json"
node scripts/ci/it-shard-group-plan.mjs \
  --validate-plan "$plan_dir/it-shard-group-plan.json"
mapfile -t root_parts < <(find "$RUNNER_TEMP/it-publish-root" -maxdepth 1 -type f \
  \( -name 'it-publish-root.part-*.tar.zst' -o -name 'it-publish-root.tar.zst' \) | sort)
(( ${#root_parts[@]} > 0 )) || { echo '::error::IT root source archive parts are missing'; exit 1; }
source scripts/lib/parallel-tar.sh
ptar_extract "$repo_root" "${root_parts[@]}"
mkdir -p .cache/incremental-manifest .cache/og-jobs "$RUNNER_TEMP/shard-content-manifests/it"
if [ -d "$plan_dir/incremental-manifest" ]; then
  cp -a "$plan_dir/incremental-manifest/." .cache/incremental-manifest/
fi
if [ -f "$plan_dir/og-jobs/.deferred-fallbacks.json" ]; then
  cp "$plan_dir/og-jobs/.deferred-fallbacks.json" .cache/og-jobs/.deferred-fallbacks.json
fi
cp "$plan_dir/locale-sitemap-manifest-it.json" "$RUNNER_TEMP/locale-sitemap-manifest-it.json"
find "$results_dir" -type f -path '*/shard-content-manifests/it/*.json' -exec cp {} "$RUNNER_TEMP/shard-content-manifests/it/" \; 2>/dev/null || true
find "$results_dir" -type f -path '*/it-shard-results/*.tar' -exec cp {} "$RUNNER_TEMP/" \; 2>/dev/null || true
find "$results_dir" -type f -name 'shard-ok-*-it' -exec cp {} "$RUNNER_TEMP/" \; 2>/dev/null || true
mapfile -t required_sections < <(jq -er '.requiredSections[]' "$plan_dir/it-shard-group-plan.json")
for section in "${required_sections[@]}"; do
  marker="$RUNNER_TEMP/shard-ok-$section-it"
  manifest="$RUNNER_TEMP/shard-content-manifests/it/$section.json"
  [[ -f "$marker" ]] || { echo "::error::IT publish results are missing the required ok-marker for $section"; exit 1; }
  [[ -s "$manifest" ]] || { echo "::error::IT publish results are missing the required section manifest for $section"; exit 1; }
done
echo "[it-publish] root extracted; required section manifests and ok-markers=${#required_sections[@]}"

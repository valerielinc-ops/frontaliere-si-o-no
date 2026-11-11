#!/usr/bin/env bash
# Resolve WHERE a replay of build run $DEPLOY_RUN_ID finds its shard bytes,
# before audit-dist-from-run.yml spends an hour rehydrating.
#
# The build run (deploy.yml) uploads `jobs-master-<id>` and source bundles. The
# publisher run uploads `github-pages`, `sitemaps`, IT section tars, and the IT
# page/section manifests. The en/de/fr locale tars `locale-dist-<loc>-<rid>` and
# section tars `shard-batch-<n>-dist-<loc>-<rid>` are also uploaded by the
# deploy-publish.yml run that published each locale.
#
# Several deploy-publish runs carry the same title ("Publish Pages build <id> @
# <sha>"): the one that really published is frequently `cancelled` (its report
# job hit the 350-minute ceiling) and the later `success` ones are receipt-only
# reconciliations with zero artifacts. So no filter on conclusion: the run that
# HOLDS non-expired `locale-dist-<loc>-<rid>` wins, newest first, per locale
# (publish receipts let locales go out in different runs).
#
# Env: DEPLOY_RUN_ID, GH_REPO (owner/repo), ALLOW_MIXED ('true'|'false'),
#      GITHUB_ENV (optional; resolved ids are appended as
#      SHARD_ARTIFACT_RUN_ID_<LOC>=<rid>).
# Exit 1 when ALLOW_MIXED != true and the replay cannot be coherent.
set -euo pipefail

: "${DEPLOY_RUN_ID:?}" "${GH_REPO:?}"
ALLOW_MIXED="${ALLOW_MIXED:-false}"
out="${GITHUB_ENV:-/dev/null}"
problems=()

live_artifacts() { # <run-id> <exact name or jq regex> -> count of non-expired matches
  gh api "repos/$GH_REPO/actions/runs/$1/artifacts?per_page=100" \
    --jq "[.artifacts[] | select(.expired == false and (.name | test(\"$2\")))] | length" 2>/dev/null || echo 0
}

[ "$(live_artifacts "$DEPLOY_RUN_ID" "^jobs-master-$DEPLOY_RUN_ID\$")" -gt 0 ] \
  || problems+=("jobs-master-$DEPLOY_RUN_ID scaduto o assente sul build")

prefix="Publish Pages build $DEPLOY_RUN_ID @"
publish_runs="$(gh run list -R "$GH_REPO" --workflow deploy-publish.yml --limit 200 \
                  --json databaseId,displayTitle 2>/dev/null \
                | jq -r --arg p "$prefix" '.[] | select(.displayTitle | startswith($p)) | .databaseId')"

it_found=""
for rid in $publish_runs; do
  complete=true
  for name in "github-pages" "sitemaps-$rid" "sitemap-page-manifest-it-$rid" "section-page-manifest-it-$rid"; do
    pattern="^${name}\$"
    [ "$(live_artifacts "$rid" "$pattern")" -gt 0 ] || complete=false
  done
  for batch in 1 2 3 4 5 6; do
    if [ "$(live_artifacts "$rid" "^shard-batch-$batch-dist-it-$rid\$")" -eq 0 ]; then
      complete=false
    fi
  done
  if [ "$complete" = true ]; then
    it_found="$rid"
    break
  fi
done
if [ -n "$it_found" ]; then
  echo "SHARD_ARTIFACT_RUN_ID_IT=$it_found" >> "$out"
  echo "[resolve] IT Pages/section artifacts: deploy-publish run $it_found"
else
  problems+=("IT github-pages/sitemaps/page-manifest/section-batch artifacts assenti o scaduti su ogni deploy-publish «$prefix …» (${publish_runs//$'\n'/ })")
fi

for loc in en de fr; do
  found=""
  for rid in $publish_runs; do
    if [ "$(live_artifacts "$rid" "^locale-dist-$loc-$rid\$")" -gt 0 ]; then
      found="$rid"
      break
    fi
  done
  if [ -n "$found" ]; then
    up="$(printf '%s' "$loc" | tr '[:lower:]' '[:upper:]')"
    echo "SHARD_ARTIFACT_RUN_ID_$up=$found" >> "$out"
    echo "[resolve] $loc shard artifacts: deploy-publish run $found"
  else
    problems+=("locale-dist-$loc-* assente/scaduto su ogni deploy-publish «$prefix …» (${publish_runs//$'\n'/ })")
  fi
done

if [ "${#problems[@]}" -eq 0 ]; then
  echo "[resolve] replay of build $DEPLOY_RUN_ID can be rehydrated from its own artifacts"
  exit 0
fi
for p in "${problems[@]}"; do echo "[resolve] $p"; done
if [ "$ALLOW_MIXED" = "true" ]; then
  echo "::warning::allow_mixed_shards=true — the missing subtrees will come from a clone of the shard repos' CURRENT main; every verdict below describes a mixed dist, not build $DEPLOY_RUN_ID"
  exit 0
fi
echo "::error::replay incoerente per il build $DEPLOY_RUN_ID: ${#problems[@]} sorgente/i scadute (retention 1 giorno). Rilancia su un build più recente, oppure allow_mixed_shards=true sapendo che trunk e dataset sono di allora e gli shard di oggi."
exit 1

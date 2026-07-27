#!/usr/bin/env bash
set -uo pipefail

# Mirrors post-deploy-validate-dist.yml's rehydrate_section(): all sections
# run concurrently (each writes a disjoint dist/ subtree, no cross-section
# race), each tracked via its own PID and gated on its own SHARD_LIVE env
# var. Shared by seed-bfs-depth-baseline.yml, seed-orphan-pages-baseline.yml,
# seed-text-html-ratio-baseline.yml, seed-title-baselines.yml — previously
# 4x byte-identical copy-paste of a sequential loop (AGENTS.md #6).
# Requires GH_TOKEN, DEPLOY_RUN_ID, and one <SECTION>_SHARD_LIVE env var per
# entry in section-shard-slugs.json (set by the calling workflow step).

rehydrate_section() {
  local section="$1"
  for loc in it en de fr; do
    sub="$(jq -r --arg s "$section" --arg l "$loc" '.[$s][$l] // empty' scripts/lib/section-shard-slugs.json)"
    if [ -d "dist/$sub" ]; then
      echo "$section $loc ($sub) present in artifact — skip rehydrate"
      continue
    fi

    dl="$RUNNER_TEMP/$section-dist-$loc"
    rm -rf "$dl"; mkdir -p "$dl"
    if gh run download "$DEPLOY_RUN_ID" --name "$section-dist-$loc-$DEPLOY_RUN_ID" --dir "$dl" 2>/dev/null && [ -f "$dl/$section-dist-$loc.tar" ]; then
      mkdir -p "dist/$(dirname "$sub")"
      rm -rf "dist/$sub"
      tar -C dist -xf "$dl/$section-dist-$loc.tar" || true
      rm -rf "$dl"
      if [ -d "dist/$sub" ]; then
        echo "rehydrated $section $loc from tar artifact: $(find "dist/$sub" -type f | wc -l) files"
        continue
      fi
      echo "[rehydrate] $section-$loc tar present but no $sub subtree after extract — falling back to git clone"
    else
      rm -rf "$dl"
      echo "[rehydrate] $section-$loc artifact absent — falling back to git clone"
    fi

    tmp="$RUNNER_TEMP/rehydrate-$section-$loc"
    rm -rf "$tmp"
    if ! git clone --depth 1 --single-branch --branch main \
         "https://github.com/valerielinc-ops/frontaliere-$section-$loc.git" "$tmp" 2>/dev/null; then
      echo "::warning::$section-$loc shard clone failed — validators may flag $loc $section pages missing"
      continue
    fi
    if [ -d "$tmp/$sub" ]; then
      mkdir -p "dist/$(dirname "$sub")"
      rm -rf "dist/$sub"
      cp -r "$tmp/$sub" "dist/$sub"
      echo "rehydrated $section $loc from frontaliere-$section-$loc: $(find "dist/$sub" -type f | wc -l) files"
    else
      echo "::warning::frontaliere-$section-$loc has no $sub subtree — $loc $section left missing"
    fi
    rm -rf "$tmp"
  done
}

SECTION_PIDS=()
for section in $(jq -r 'keys[] | select(startswith("_")|not)' scripts/lib/section-shard-slugs.json); do
  live_var="$(echo "$section" | tr a-z A-Z)_SHARD_LIVE"
  if [ "${!live_var:-}" = "true" ]; then
    rehydrate_section "$section" &
    SECTION_PIDS+=("$!")
  fi
done
for pid in "${SECTION_PIDS[@]}"; do
  wait "$pid" || true
done
df -h / | tail -1

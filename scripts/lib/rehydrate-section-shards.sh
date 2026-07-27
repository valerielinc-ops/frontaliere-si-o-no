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
#
# deploy.yml uploads section tars BATCHED (~5 sections/artifact per
# scripts/lib/section-shard-batches.json — GitHub Actions doesn't
# parallelize `uses:` steps natively, and background:/wait-all: on
# `uses:` steps broke production twice, PR #4777 reverted by #4779), so
# one artifact download must be shared by every section in the same
# batch instead of one `gh run download` per section. ensure_batch_downloaded()
# below is the single-download choke point: the first concurrent
# rehydrate_section() call for a given batch+locale wins an atomic `mkdir`
# lock and downloads; every other concurrent call for the same batch+locale
# polls for the "done" marker instead of re-downloading.
ensure_batch_downloaded() {
  local batch="$1" loc="$2"
  local dl="$RUNNER_TEMP/shard-batch-$batch-dist-$loc"
  local lock="$dl.lock"
  local done="$dl.done"
  if [ -f "$done" ]; then
    return 0
  fi
  if mkdir "$lock" 2>/dev/null; then
    rm -rf "$dl"; mkdir -p "$dl"
    gh run download "$DEPLOY_RUN_ID" --name "shard-batch-$batch-dist-$loc-$DEPLOY_RUN_ID" --dir "$dl" 2>/dev/null || true
    touch "$done"
    return 0
  fi
  # Loser: another concurrent section in this batch is already downloading —
  # poll for the marker instead of racing a second `gh run download`. Capped
  # wait (not an infinite block): if the winner's download hangs/fails, every
  # tar-path check below simply misses and falls through to the existing
  # git-clone fallback, same as an absent artifact today.
  local waited=0
  while [ ! -f "$done" ] && [ "$waited" -lt 120 ]; do
    sleep 1
    waited=$((waited + 1))
  done
}

rehydrate_section() {
  local section="$1"
  local batch
  batch="$(jq -r --arg s "$section" '.[$s]' scripts/lib/section-shard-batches.json)"
  for loc in it en de fr; do
    slug="$(jq -r --arg s "$section" --arg l "$loc" '.[$s][$l] // empty' scripts/lib/section-shard-slugs.json)"
    # section-shard-slugs.json values are the URL slug ONLY (no locale
    # prefix) — same it/en-de-fr branch as push-section-shard.sh and
    # strip-section-subtree.sh. Using the bare slug as `sub` for en/de/fr
    # made every non-IT dist-subtree check look at the wrong path (missing
    # its `$loc/` prefix), so a correctly-packed tar always read back as 0
    # files extracted and the git-clone fallback's dir check failed the
    # same way (run 30238078775).
    case "$loc" in
      it) sub="$slug" ;;
      en|de|fr) sub="$loc/$slug" ;;
    esac
    if [ -d "dist/$sub" ]; then
      echo "$section $loc ($sub) present in artifact — skip rehydrate"
      continue
    fi

    ensure_batch_downloaded "$batch" "$loc"
    dl="$RUNNER_TEMP/shard-batch-$batch-dist-$loc"
    if [ -f "$dl/$section-dist-$loc.tar" ]; then
      mkdir -p "dist/$(dirname "$sub")"
      rm -rf "dist/$sub"
      # Completeness, not just existence (#2761 item 2, mirrors the locale
      # rehydrate above): `[ -d dist/$sub ]` alone only proves SOME files
      # landed, not that extraction finished. Compare what the tar itself
      # claims to contain (`tar -tf`, empty on a corrupt header) against
      # what actually landed on disk after extraction — catches a
      # truncated/corrupted tar that a bare directory check would miss.
      # `|| true` throughout: any anomaly here must fall through to the
      # git-clone fallback below, not abort under `set -e`.
      expected_n=$(tar -tf "$dl/$section-dist-$loc.tar" 2>/dev/null | { grep -vc '/$' || true; })
      tar -C dist -xf "$dl/$section-dist-$loc.tar" || true
      # Remove only this section's tar, not the whole `$dl` dir — it's the
      # shared batch download, other sections in the same batch may still
      # need to read their own tar out of it.
      rm -f "$dl/$section-dist-$loc.tar"
      actual_n=0
      if [ -d "dist/$sub" ]; then
        actual_n=$(find "dist/$sub" -type f | wc -l)
      fi
      if [ -d "dist/$sub" ] && [ "${expected_n:-0}" -gt 0 ] && [ "$actual_n" -ge "$expected_n" ]; then
        echo "rehydrated $section $loc from tar artifact: $actual_n files (tar listed $expected_n)"
        continue
      fi
      rm -rf "dist/$sub"
      echo "[rehydrate] $section-$loc tar extraction incomplete (expected $expected_n files, got $actual_n) — falling back to git clone"
    else
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

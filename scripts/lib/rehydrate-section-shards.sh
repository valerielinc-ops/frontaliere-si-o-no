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
    # Completeness, not just existence (issue #4881 Fase 5 audit finding).
    # `[ -d dist/$sub ]` alone is a false positive whenever something OTHER
    # than this section's own push left a non-empty-but-partial directory in
    # place — e.g. legacyRedirectsPlugin.ts independently writes a handful
    # of old-slug redirect-bridge pages under this exact prefix regardless
    # of whether the section's own build-time emit ran (issue #4881 Fase
    # 5's ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP / ARTICOLISVIZZERA_BUILD_EMIT_SKIP,
    # or any section whose own emit is skipped/fails for an unrelated
    # reason). A bare directory check would then wrongly treat the section
    # as fully rehydrated and skip the tar/clone fallback below, so every
    # dist-walking post-deploy audit fails against a genuinely incomplete
    # tree. Mirrors push-section-shard.sh's own `test -s
    # "$stage/$sub/index.html"` liveness assertion: the section's own root
    # index.html only exists once its FULL emit (hub/index page included)
    # has actually run, so checking for it (non-empty) is a reliable
    # completeness signal a bare `-d` check is not.
    if [ -s "dist/$sub/index.html" ]; then
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

    # Cross-job clone cache (issue #4881 defect C). The 3 post-deploy-
    # validate-dist.yml jobs (validate-dist-source/-postbuild/-postbuild-bfs)
    # run in PARALLEL with no `needs:` between them, so all 3 reach this same
    # fallback for the same section+locale whenever the tar artifact is
    # missing/corrupt (the same condition trips identically for all 3 — e.g.
    # a shard push failure). SHARD_CLONE_CACHE_DIR is populated by
    # `actions/cache/restore` in the caller BEFORE this script runs and saved
    # by `actions/cache/save` right after — a job that starts this fallback
    # after an earlier job in the SAME run already finished it can reuse that
    # result instead of re-cloning. Best-effort/probabilistic (job start
    # order isn't guaranteed, so a hit isn't guaranteed either) and strictly
    # additive: unset (default) or a miss falls straight through to the
    # unchanged clone path below, so this is never worse than before it
    # existed. Not wired to any (section, locale) content invariant — a
    # missing/stale cache entry just costs the clone it would have cost
    # anyway, it never serves wrong content (each entry is this exact
    # section+locale's own $sub, copied verbatim from a clone made moments
    # earlier in the same run).
    if [ -n "${SHARD_CLONE_CACHE_DIR:-}" ] && [ -d "$SHARD_CLONE_CACHE_DIR/$section-$loc/$sub" ]; then
      mkdir -p "dist/$(dirname "$sub")"
      rm -rf "dist/$sub"
      cp -r "$SHARD_CLONE_CACHE_DIR/$section-$loc/$sub" "dist/$sub"
      echo "rehydrated $section $loc from cross-job clone cache: $(find "dist/$sub" -type f | wc -l) files"
      continue
    fi

    tmp="$RUNNER_TEMP/rehydrate-$section-$loc"
    rm -rf "$tmp"
    owner="$(jq -r --arg s "$section" '.[$s] // "valerielinc-ops"' scripts/lib/section-shard-owners.json 2>/dev/null || echo valerielinc-ops)"
    if [ -z "$owner" ] || [ "$owner" = "null" ]; then owner="valerielinc-ops"; fi
    # NOTE on partial-clone + sparse-checkout, tried and DELIBERATELY dropped
    # (issue #4881 defect C — documented instead of silently omitted, since
    # it's the first thing anyone re-reading this will reach for): git's cone
    # sparse-checkout mode ALWAYS materializes every root-level file
    # regardless of the configured directory pattern (this is cone mode's
    # documented shape, not a bug) — verified empirically against a local
    # fixture in tests/rehydrate-section-shards.test.ts. Every
    # frontaliere-<section>-<loc> repo's non-$sub content IS exactly those
    # root-level scaffold files (.nojekyll/CNAME/index.html/.shard-deploys/
    # .shard-filecount written by push-section-shard.sh) — there is no OTHER
    # sibling directory to exclude — so `sparse-checkout set --cone "$sub"`
    # here fetches byte-for-byte the same tree a plain clone does. Adding it
    # would be pure risk (new git subcommand, `--filter=blob:none` splitting
    # one negotiation into clone + a second on-demand blob fetch during
    # checkout) for a verified ZERO reduction in transferred bytes on TODAY's
    # repo layout. Left as a plain clone; the real fix for this defect is the
    # cross-job cache above, which needs no change to this command at all.
    if ! git clone --depth 1 --single-branch --branch main \
         "https://github.com/$owner/frontaliere-$section-$loc.git" "$tmp" 2>/dev/null; then
      echo "::warning::$section-$loc shard clone failed — validators may flag $loc $section pages missing"
      continue
    fi
    if [ -d "$tmp/$sub" ]; then
      mkdir -p "dist/$(dirname "$sub")"
      rm -rf "dist/$sub"
      cp -r "$tmp/$sub" "dist/$sub"
      echo "rehydrated $section $loc from frontaliere-$section-$loc: $(find "dist/$sub" -type f | wc -l) files"
      if [ -n "${SHARD_CLONE_CACHE_DIR:-}" ]; then
        mkdir -p "$SHARD_CLONE_CACHE_DIR/$section-$loc/$(dirname "$sub")" 2>/dev/null \
          && cp -r "dist/$sub" "$SHARD_CLONE_CACHE_DIR/$section-$loc/$sub" 2>/dev/null || true
      fi
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

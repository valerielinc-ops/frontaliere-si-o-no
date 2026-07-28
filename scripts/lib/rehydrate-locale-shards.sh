#!/usr/bin/env bash
set -uo pipefail

# Extracted from post-deploy-validate-dist.yml, which had this exact
# function byte-for-byte duplicated across its 3 jobs (validate-dist-source,
# validate-dist-postbuild, validate-dist-postbuild-bfs) — the comment at the
# original inline copy called that a deliberate "surgical CI-speed change"
# tradeoff, but AGENTS.md #6 flags literal duplication across >=2 files as a
# drift risk to fix by extraction, mirroring the sibling
# rehydrate-section-shards.sh (already extracted for the same reason).
#
# Also hardens the failure class behind issues #3772..#4828 (~20+
# recurrences over two months): the "Rehydrate locale..." step would crash
# mid-run with no clean rc recorded on the GitHub Actions API (job marked
# `failure` without the step ever reaching completed_at) — consistent with
# a transient network blip or disk-pressure blip during the ~250k-file
# shallow clone fallback, not a deterministic script bug (see #4730
# diagnosis). Two changes target that: (1) `timeout` around both network
# ops so a stall fails clean instead of running until the runner kills it,
# (2) one retry with backoff on each before falling through — the tar-artifact
# path already had a completeness check (#2761), only the network calls
# lacked resilience.
#
# Requires GH_TOKEN, DEPLOY_RUN_ID, LOCALE_SHARDS_LIVE (set via `env:` on
# the calling workflow step — this script inherits them as normal process
# env, same as rehydrate-section-shards.sh already relies on for its own
# vars).

rehydrate_locale() {
  set -euo pipefail
  for loc in en de fr; do
    # Skip rehydrate only when BOTH the locale dir AND its homepage
    # `dist/$loc.html` (= `/{loc}`) are present. Checking just the dir
    # couples this guard to the implicit assumption that the strip in
    # deploy.yml always removes dir + homepage together (true today). If
    # a future strip refactor decoupled them, a dir-only check would skip
    # rehydrate while `/{loc}` stayed missing → locale homepage 404 = SEO
    # loss. Verifying both decouples the guard from that assumption (#1607).
    if [ -d "dist/$loc" ] && [ -f "dist/$loc.html" ]; then
      echo "$loc present in artifact (dir + homepage, not stripped this build) — skip rehydrate"
      continue
    fi

    # PRIMARY: the same-run per-locale shard-dist artifact the en/de/fr
    # build-locale shard uploaded from its already-pruned, CDN-offloaded
    # dist (byte-identical to what push-locale-shard.sh force-pushed).
    dl="$RUNNER_TEMP/locale-dist-$loc"
    dl_ok=1
    for attempt in 1 2; do
      rm -rf "$dl"; mkdir -p "$dl"
      if timeout 180 gh run download "$DEPLOY_RUN_ID" --name "locale-dist-$loc-$DEPLOY_RUN_ID" --dir "$dl" 2>/dev/null && [ -f "$dl/locale-dist-$loc.tar" ]; then
        dl_ok=0
        break
      fi
      if [ "$attempt" -eq 1 ]; then
        echo "[rehydrate] $loc artifact download attempt 1 failed/stalled — retrying"
        sleep 5
      fi
    done
    if [ "$dl_ok" -eq 0 ]; then
      rm -rf "dist/$loc" "dist/$loc.html"
      # Completeness, not just existence (#2761 item 2): `[ -d dist/$loc ]`
      # alone only proves SOME files landed, not that extraction finished —
      # a truncated/corrupted tar can still leave a partially-populated
      # dist/$loc/ that passes a bare directory check with no fallback.
      # `tar -tf` lists what the archive itself claims to contain (empty
      # on a corrupt header); comparing that count to what actually landed
      # on disk after extraction catches a short read the old check missed.
      expected_n=$(tar -tf "$dl/locale-dist-$loc.tar" 2>/dev/null | { grep -vc '/$' || true; })
      tar -C dist -xf "$dl/locale-dist-$loc.tar" || true
      rm -rf "$dl"
      actual_n=0
      if [ -d "dist/$loc" ]; then
        actual_n=$(find "dist/$loc" -type f | wc -l)
        [ -f "dist/$loc.html" ] && actual_n=$((actual_n + 1))
      fi
      if [ -d "dist/$loc" ] && [ "${expected_n:-0}" -gt 0 ] && [ "$actual_n" -ge "$expected_n" ]; then
        echo "rehydrated $loc from tar artifact: $actual_n files (tar listed $expected_n)"
        continue
      fi
      rm -rf "dist/$loc" "dist/$loc.html"
      echo "[rehydrate] $loc tar extraction incomplete (expected $expected_n files, got $actual_n) — falling back to git clone"
    else
      rm -rf "$dl"
      echo "[rehydrate] $loc artifact absent after retry — falling back to git clone"
    fi

    echo "[rehydrate] $loc pre-clone disk: $(df -h / | tail -1)"
    tmp="$RUNNER_TEMP/rehydrate-$loc"
    clone_ok=1
    for attempt in 1 2; do
      rm -rf "$tmp"
      if timeout 300 git clone --depth 1 --single-branch --branch main \
           "https://github.com/valerielinc-ops/frontaliere-$loc.git" "$tmp"; then
        clone_ok=0
        break
      fi
      echo "[rehydrate] $loc git clone attempt $attempt failed/stalled (disk: $(df -h / | tail -1))"
      [ "$attempt" -eq 1 ] && sleep 5
    done
    [ "$clone_ok" -eq 0 ] || { echo "::error::shard $loc git clone failed after retry"; exit 1; }
    [ -d "$tmp/$loc" ] || { echo "::error::shard $loc has no $loc/ subtree"; exit 1; }
    # Remove any partial pre-existing dir first: with the dir+homepage guard
    # above, we can reach here with `dist/$loc` already present (dir kept,
    # homepage stripped). `cp -r src existing-dir` would nest as
    # `dist/$loc/$loc` instead of replacing — so clear it for a clean
    # rehydrate. No-op in the common case (dir was fully stripped).
    rm -rf "dist/$loc"
    cp -r "$tmp/$loc" "dist/$loc"
    if [ -f "$tmp/$loc.html" ]; then cp "$tmp/$loc.html" "dist/$loc.html"; fi
    echo "rehydrated $loc: $(find "dist/$loc" -type f | wc -l) files"
    rm -rf "$tmp"
  done
  # Cheap disk-pressure readout instead of `du -sh dist` (a ~70s full
  # stat-walk of ~1.27M files just for a log line). df is instant and is
  # the metric that actually matters after rehydrating ~27G into dist/.
  df -h / | tail -1
}

if [ "${LOCALE_SHARDS_LIVE:-}" != "true" ]; then
  exit 0
fi
rehydrate_locale

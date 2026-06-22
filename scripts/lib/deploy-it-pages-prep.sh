#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/deploy-it-pages-prep.sh — IT-shard post-build Pages prep
#
# Reproduces, IN ORDER, the BASH/script logic that the production monolith
# deploy job (.github/workflows/deploy.yml) runs against dist/ between the
# build and the github-pages artifact upload, so the matrix deploy's IT shard
# runner produces a byte-for-byte equivalent dist/ + the same side-effect
# files/markers + the same exported env vars.
#
# SCOPE — ONLY the bash/script logic. The GitHub-Actions `uses:` steps
# (upload-artifact, configure-pages, deploy-pages) STAY in YAML and are wired
# by the caller. The locale-shard push (dist/en|de|fr → frontaliere-{loc}) is
# NOT handled here (handled separately). The dist-size-history / url-first-seen
# GIT COMMIT step (deploy.yml "Commit dist-size-history row + url-first-seen
# updates") is NOT here either: this script only RUNS the scripts that WRITE
# data/dist-size-history.jsonl + data/url-first-seen.json; the commit+push to
# main (with its retry loop) stays in YAML.
#
# Maps to these deploy.yml steps (see README in report):
#   1. SPA fallback                         → cp dist/index.html dist/404.html
#   2. Push generated assets to CDN repo    → stage + blobless clone + cp -n
#                                             merge + force-push, export CDN_BASE
#   3. Offload og refs + data base          → offload-generated-images-cdn.mjs
#   4. Prune superseded CDN asset hashes    → ci/prune-cdn-assets.mjs
#   5. Drop dist/assets after CDN push      → cdnAssetOffloadRx guard + rm
#   6. Capture pre-deploy sitemap URLs      → capture-deployed-sitemaps.mjs
#   7. Pack new sitemap URLs from dist/     → inline node → new-sitemap-urls.json
#   8. Stage sitemaps bundle                → /tmp/sitemaps-bundle/
#   9. Pack dist/ into Pages tar archive    → tar → artifact.tar, export TAR_BYTES
#  10. Audit dist bytes                     → report-dist-bytes-by-plugin.mjs
#  11. File delta vs previous deploy        → deploy-file-delta.mjs
#  12. Refresh url-first-seen               → refresh-url-first-seen.mjs
#
# The original `if: github.event.inputs.profile_sequential != 'true'` guards are
# intentionally OMITTED — the matrix path never profiles, so every section here
# always runs (profile_sequential is monolith-only).
#
# Required env vars:
#   CDN_DEPLOY_KEY   — SSH deploy key (write-only) to valerielinc-ops/frontaliere-cdn.
#                      Missing/empty → CDN push skipped, assets stay in dist (and
#                      then "Drop dist/assets" FAILS, exactly as in the monolith).
#   RUNNER_TEMP      — runner temp dir (falls back to /tmp if unset).
#   GITHUB_ENV       — env-file for exporting CDN_BASE + TAR_BYTES to later YAML
#                      steps (no-op echo only when unset, e.g. local runs).
#   GITHUB_SHA, GITHUB_RUN_ID — used in CDN commit message / audit / delta args.
#
# Exported (appended to $GITHUB_ENV + echoed):
#   CDN_BASE   — https://cdn.frontaliereticino.ch  (only when the CDN push succeeded)
#   TAR_BYTES  — size in bytes of $RUNNER_TEMP/artifact.tar
#
# Output files / markers written (same as the monolith):
#   $RUNNER_TEMP/artifact.tar                  — packed Pages artifact
#   $RUNNER_TEMP/assets-same-origin.marker     — produced by offload step (consumed by guard)
#   /tmp/new-sitemap-urls.json                 — packed new sitemap URLs
#   /tmp/pre-deploy-sitemap-urls.json          — produced by capture-deployed-sitemaps.mjs
#   /tmp/sitemaps-bundle/                       — pre-deploy + build-id.txt + new-sitemap-urls
#   data/dist-size-history.jsonl               — appended by report-dist-bytes-by-plugin.mjs
#   data/url-first-seen.json                    — updated by refresh-url-first-seen.mjs
#
# FATAL vs NON-FATAL (matches deploy.yml exactly):
#   FATAL    : SPA fallback (1); Drop dist/assets guard (5); tar pack (9);
#              audit dist bytes (10); refresh url-first-seen (12)
#   NON-FATAL: CDN push (2); offload (3); prune CDN (4); capture sitemaps (6);
#              pack new sitemap URLs (7); stage bundle (8); file delta (11)
#              — each was `continue-on-error: true` in deploy.yml; here each runs
#                in a guarded sub-shell and only logs a ::warning:: on failure.
#
# Run against dist/ in the CURRENT working dir (the IT shard's built dist).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"

# Export a key=value INTO THE CURRENT PROCESS (so later sections of THIS script
# see it) AND to $GITHUB_ENV (so later YAML steps see it) AND echo it. The
# in-process export is essential: the monolith propagated CDN_BASE/TAR_BYTES
# between SEPARATE YAML steps via $GITHUB_ENV, but here the whole prep is ONE
# bash script, so $GITHUB_ENV does NOT propagate intra-run — later steps
# (step_offload/step_prune_cdn/step_drop_assets read CDN_BASE; step_audit_bytes
# reads TAR_BYTES) need it set in this very process. Without the export,
# CDN_BASE stayed empty after a SUCCESSFUL CDN push → offload skipped + the
# drop-assets FATAL guard wrongly fired (run 27918706767 IT leg).
export_env() {
  local key="$1" value="$2"
  export "$key"="$value"
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"
  fi
  echo "$key=$value"
}

# Run a NON-FATAL section: invoke a function in a guarded way so its failure
# (the `continue-on-error: true` steps) logs a warning and continues, exactly
# like the monolith where the step is allowed to fail without failing the job.
run_nonfatal() {
  local label="$1"; shift
  if "$@"; then
    return 0
  fi
  echo "::warning::[deploy-it-pages-prep] non-fatal section failed (continuing): ${label}"
  return 0
}

# ── 1. SPA fallback (GitHub Pages serves 404.html for unknown paths) ──────────
# deploy.yml: "SPA fallback" — FATAL (plain `run:`).
step_spa_fallback() {
  cp dist/index.html dist/404.html
}

# ── 2. Push generated assets to CDN repo (frontaliere-cdn / Pages) ────────────
# deploy.yml: "Push generated assets to CDN repo" — NON-FATAL (continue-on-error).
# Stages CDN payload (dist/og, dist/data, dist/assets, public/images/*), blobless
# clone of the CDN repo, additive `cp -n` merge of prior assets/, force-push to
# valerielinc-ops/frontaliere-cdn, exports CDN_BASE on success. Internally
# non-fatal: every failure path keeps the assets in dist.
step_push_cdn() {
  set -uo pipefail
  if [ -z "${CDN_DEPLOY_KEY:-}" ]; then
    echo "no CDN_DEPLOY_KEY secret — skipping CDN push, assets stay in dist"; return 0
  fi
  stage=/tmp/cdn-stage
  rm -rf "$stage" && mkdir -p "$stage"
  : > "$stage/.nojekyll"                              # serve every path verbatim, skip Jekyll
  printf 'cdn.frontaliereticino.ch' > "$stage/CNAME"  # keep custom domain (force-push would else wipe it)
  # Offloadable dirs: og cards, ALL runtime data JSON, the bundler assets
  # (JS/CSS) whose URLs renderBuiltUrl already rebased to the CDN, and the
  # git-tracked full blog heroes (served at cdn.frontaliereticino.ch/images/
  # blog; finalize plugin already rewrote HTML + deleted dist heroes, so we
  # push from the public/ source). The 480w thumbnails are committed under
  # public/images/blog/thumbnails/ (generate-image-thumbnails.mjs encodes
  # them; generate-article.yml commits each new one), so the public/images/blog
  # copy below ALREADY pushes them to ${CDN}/images/blog/thumbnails/ — the offload
  # script then deletes the dist copy of dist/images/blog/thumbnails.
  [ -d dist/og ]           && cp -r dist/og           "$stage/og"
  [ -d dist/data ]         && cp -r dist/data         "$stage/data"
  [ -d dist/assets ]       && cp -r dist/assets       "$stage/assets"
  [ -d public/images/blog ] && mkdir -p "$stage/images" && cp -r public/images/blog "$stage/images/blog"
  # Self-hosted brand/logo/author images (#1360): push from the git-tracked
  # public/images/<dir> source to ${CDN}/images/<dir>, so the offload script
  # (offload-generated-images-cdn.mjs IMAGE TARGETS) can rewrite the static
  # HTML refs + the SPA's cdnImageUrl() runtime refs to the CDN and then
  # delete the dist copies. MUST stay in sync with that script's TARGETS and
  # services/cdnImageBase.ts CDN_OFFLOADED_IMAGE_PREFIXES. (/images/places is
  # intentionally excluded — it stays same-origin.)
  for d in brands insurers providers logos authors publisher; do
    [ -d "public/images/$d" ] && mkdir -p "$stage/images" && cp -r "public/images/$d" "$stage/images/$d"
  done
  if [ ! -d "$stage/og" ] && [ ! -d "$stage/data" ] && [ ! -d "$stage/assets" ] && [ ! -d "$stage/images" ]; then
    echo "no offloadable assets present — skipping CDN push"; return 0
  fi
  printf '<!doctype html><meta charset=utf-8><title>frontaliereticino.ch CDN</title>frontaliereticino.ch asset CDN' > "$stage/index.html"
  keyfile="$RUNNER_TEMP/cdn_deploy_key"
  printf '%s\n' "$CDN_DEPLOY_KEY" > "$keyfile" && chmod 600 "$keyfile"
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  # ── Additive assets/ (anti-clobber) ──────────────────────────────────
  # Bundler assets/ have STABLE names (index-entry.js, App.js, index.css …
  # vite.config.ts chunkFileNames/assetFileNames): the stage already holds
  # the freshly-built bytes for every stable name, and `cp -n` (never
  # overwrites a freshly-built file) only carries forward files ABSENT
  # from the new build — i.e. the legacy content-hashed generations still
  # referenced by HTML cached/live from before the cutover. Replacing the
  # whole repo each deploy used to DELETE those still-referenced files
  # while the ~13 GB Pages site kept serving the previous build for the
  # 10-20 min a publish takes to propagate → live HTML 404'd on its own
  # JS → SPA dead (prod outage 2026-06-04). og/data/images are same-path
  # and fully refreshed above (overwrite is correct for them).
  # prune-cdn-assets.mjs GCs the carried-forward legacy hashes post-grace.
  # Sparse + blob:none keeps the clone to the small assets/ tree only.
  if [ -d "$stage/assets" ]; then
    prev="$RUNNER_TEMP/cdn-prev"; rm -rf "$prev"
    if git clone --depth 1 --filter=blob:none --sparse \
         git@github.com:valerielinc-ops/frontaliere-cdn.git "$prev" 2>/dev/null; then
      git -C "$prev" sparse-checkout set assets 2>/dev/null || true
      if [ -d "$prev/assets" ]; then
        cp -rn "$prev/assets/." "$stage/assets/" 2>/dev/null || true
        echo "additive CDN: carried forward prior assets/ (now $(ls -1 "$stage/assets" | wc -l) files)"
      fi
    else
      echo "additive CDN: no prior CDN clone (first push / transient) — proceeding with new assets only"
    fi
    rm -rf "$prev"
  fi
  echo "CDN payload: $(du -sh "$stage" | cut -f1)"
  # Flag if the CDN repo nears the GitHub Pages ~1 GB published-site soft limit.
  # With additive assets/ the payload grows slowly across deploys (only NEW
  # hashes accumulate; data/og/images are refreshed, not stacked). The inline
  # "Prune superseded CDN asset hashes" step below GCs superseded hashes past
  # a grace window (runs post-push in this same job — no concurrent-deploy race).
  payload_bytes="$(du -sb "$stage" | cut -f1)"
  if [ "$payload_bytes" -gt 950000000 ]; then
    echo "::warning::CDN payload ${payload_bytes} bytes (>950 MB) — approaching GitHub Pages ~1 GB soft limit; run the CDN assets/ janitor or split (e.g. keep blog heroes on jsDelivr)"
  fi
  cd "$stage"
  git init -q
  git checkout -q -b main
  git config user.email "deploy-bot@frontaliereticino.ch"
  git config user.name "deploy-bot"
  git add -A
  git commit -qm "cdn assets (og + data + additive assets) ${GITHUB_SHA::8} (run ${GITHUB_RUN_ID})"
  # Force-push a single fresh commit → CDN repo history never accumulates.
  # Content is additive (prior assets/ merged above), so the force-push no
  # longer clobbers in-flight entry hashes — it just flattens history.
  if git push -f git@github.com:valerielinc-ops/frontaliere-cdn.git main; then
    export_env CDN_BASE "https://cdn.frontaliereticino.ch"
    echo "✅ pushed assets to frontaliere-cdn"
  else
    echo "⚠️ CDN push failed — offload skipped, og/data stay in dist"
  fi
  rm -f "$keyfile"
  # Return to the prep cwd (the IT shard dist root) for the steps that follow,
  # since the monolith ran each YAML step from the workspace root regardless.
  cd "$PREP_CWD"
}

# ── 3. Offload og refs + data base into dist ──────────────────────────────────
# deploy.yml: "Offload og refs + data base into dist" — NON-FATAL.
# Rewrites dist HTML asset refs → CDN, injects window.__CDN_DATA_BASE__, writes
# $RUNNER_TEMP/assets-same-origin.marker consumed by the guard below.
step_offload() {
  node scripts/offload-generated-images-cdn.mjs
}

# ── 4. Prune superseded CDN asset hashes (inline GC, post-push) ───────────────
# deploy.yml: "Prune superseded CDN asset hashes" — NON-FATAL.
# Original gate: `env.CDN_BASE != ''` → only runs after a successful CDN push.
step_prune_cdn() {
  if [ -z "${CDN_BASE:-}" ]; then
    echo "CDN_BASE unset (no CDN push this run) — skipping CDN prune"; return 0
  fi
  node scripts/ci/prune-cdn-assets.mjs
}

# ── 5. Drop dist/assets after CDN push (build-time guards) ────────────────────
# deploy.yml: "Drop dist/assets after CDN push" — FATAL.
#   (A) FAIL if the push failed (CDN_BASE unset) — Vite refs already CDN-baked
#       with no fallback, so the artifact would be broken.
#   (B) If ANY dist HTML still references a SAME-ORIGIN /assets/ path, KEEP
#       dist/assets (skip delete) — non-fatal within this step.
step_drop_assets() {
  set -uo pipefail
  [ -d dist/assets ] || { echo "no dist/assets — nothing to offload"; return 0; }
  if [ -z "${CDN_BASE:-}" ]; then
    echo "::error::CDN push failed but dist/assets URLs are already rebased to the CDN (no fallback) — failing deploy (last good stays live)"; return 1
  fi
  # Guard B: any surviving SAME-ORIGIN /assets/ reference in dist HTML?
  # The offload step (which already read+rewrote every CONTENT html in a
  # top-level-only walk) emitted its verdict to
  # $RUNNER_TEMP/assets-same-origin.marker using the SAME superset regex
  # (ASSETS_SAME_ORIGIN_RX) — covering every content *.html at ANY depth.
  # Reuse it instead of re-reading the whole ~470k-file HTML corpus a second
  # time (~6min). The marker does NOT cover the three TOP-LEVEL
  # dist/{assets,data,images} dirs that walk skips (vite assets / *.json /
  # binary — no *.html by construction), so belt-grep just those three roots
  # here (cheap, near-empty) to keep coverage IDENTICAL to the original
  # full-tree grep. FAIL-SAFE: a missing marker (offload crashed mid-walk)
  # falls back to the original full-tree grep, so this guard is NEVER weaker
  # than before.
  # SINGLE SOURCE OF TRUTH (no copy-paste, AGENTS.md #6): the bash ERE below
  # is NOT hand-maintained — it is the exact string the offload marker
  # producer uses, exported as ASSETS_SAME_ORIGIN_ERE from
  # build-plugins/shared/cdnAssetOffloadRx.mjs. Deriving it here makes a
  # marker↔grep divergence (→ 404 on offloaded /assets/) impossible.
  ASSET_RX="$(node -e "import('./build-plugins/shared/cdnAssetOffloadRx.mjs').then(m=>process.stdout.write(m.ASSETS_SAME_ORIGIN_ERE))" 2>/dev/null || true)"
  if [ -z "$ASSET_RX" ]; then
    # Defensive fallback (module unreadable for any reason): inline the same
    # ERE literal so the guard is never weaker than before.
    ASSET_RX="[\"'(]/?assets/[^\"'() ]*\.(js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico|json)"
  fi
  marker="${RUNNER_TEMP:-/tmp}/assets-same-origin.marker"
  # `|| true` on EVERY grep/tail pipe substitution below: the GitHub
  # default shell is `bash -eo pipefail`, so grep exiting 1 when it finds
  # nothing (the EXPECTED clean case) — or tail getting SIGPIPE from a
  # `head` that closed early — makes the substitution non-zero, which
  # under -e aborts the whole step (zero output, deploy fails). The
  # original Guard B avoided this by running grep inside an `if`
  # condition (exempt from -e); the marker path must guard each
  # substitution explicitly.
  if [ -f "$marker" ]; then
    if [ "$(head -1 "$marker")" = "CLEAN" ]; then
      # marker covered the content tree (any depth); belt-grep only the
      # top-level roots walk skipped — normally zero *.html, so near-instant.
      leak="$(grep -rlE "$ASSET_RX" --include='*.html' dist/assets dist/data dist/images 2>/dev/null | head -1 || true)"
      [ -n "$leak" ] && echo "marker=CLEAN but a top-level assets|data|images *.html still has a same-origin /assets/ ref: $leak" || true
    else
      leak="$(tail -n +2 "$marker" | head -1 || true)"
      echo "offload marker reports surviving same-origin /assets/ ref(s):"
      tail -n +2 "$marker" | head -8 || true
    fi
  else
    echo "offload marker absent — falling back to full-tree grep (Guard B)"
    leak="$(grep -rlE "$ASSET_RX" --include='*.html' dist 2>/dev/null | head -1 || true)"
  fi
  if [ -n "$leak" ]; then
    echo "⚠️ some dist HTML still references same-origin /assets/ (not CDN-rebased) — KEEPING dist/assets (no breakage, no asset reduction this round)"
    return 0
  fi
  freed="$(du -sh dist/assets | cut -f1)"
  rm -rf dist/assets
  echo "✅ no same-origin /assets/ refs survive; dropped dist/assets (${freed}) from artifact (CDN: ${CDN_BASE}/assets — verified live in validate-live)"
}

# ── 6. Capture pre-deploy sitemap URLs (for IndexNow diff) ────────────────────
# deploy.yml: "Capture pre-deploy sitemap URLs" — NON-FATAL.
# Writes /tmp/pre-deploy-sitemap-urls.json.
step_capture_sitemaps() {
  node scripts/capture-deployed-sitemaps.mjs
}

# ── 7. Pack new sitemap URLs from dist/ ───────────────────────────────────────
# deploy.yml: "Pack new sitemap URLs from dist/" — NON-FATAL.
# Inline node script producing /tmp/new-sitemap-urls.json.
step_pack_new_sitemaps() {
  node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const distDir = 'dist';
    if (!fs.existsSync(distDir)) {
      console.error('dist/ missing — skipping new-sitemap-urls.json');
      process.exit(0);
    }
    const files = fs.readdirSync(distDir)
      .filter(f => /^sitemap-.+\.xml\$/.test(f) && f !== 'sitemap-index.xml')
      .sort();
    const perSitemap = {};
    const all = new Set();
    for (const f of files) {
      const xml = fs.readFileSync(path.join(distDir, f), 'utf8');
      const urls = [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()))].sort();
      perSitemap[f] = urls;
      for (const u of urls) all.add(u);
    }
    const out = {
      version: 2,
      capturedAt: new Date().toISOString(),
      source: 'dist',
      perSitemap,
      _allUrls: [...all].sort(),
    };
    fs.writeFileSync('/tmp/new-sitemap-urls.json', JSON.stringify(out));
    console.log('📦 Packed ' + out._allUrls.length + ' new sitemap URLs across ' + Object.keys(perSitemap).length + ' files → /tmp/new-sitemap-urls.json');
  "
}

# ── 8. Stage sitemaps bundle (pre-deploy + new + build-id) ────────────────────
# deploy.yml: "Stage sitemaps bundle" — NON-FATAL.
step_stage_bundle() {
  mkdir -p /tmp/sitemaps-bundle
  cp -f /tmp/pre-deploy-sitemap-urls.json /tmp/sitemaps-bundle/ 2>/dev/null || true
  # build-id.txt is consumed by `wait-for-pages-propagation.mjs`
  # in validate-live to verify the live site is serving THIS deploy.
  # Bundling it here means validate-live can run without
  # downloading the 1.5 GB github-pages artifact.
  cp -f dist/build-id.txt /tmp/sitemaps-bundle/ 2>/dev/null || true
  cp -f /tmp/new-sitemap-urls.json /tmp/sitemaps-bundle/ 2>/dev/null || true
  ls -la /tmp/sitemaps-bundle/
}

# ── 9. Pack dist/ into Pages tar archive ──────────────────────────────────────
# deploy.yml: "Pack dist/ into Pages tar archive" — FATAL.
# Produces $RUNNER_TEMP/artifact.tar, exports TAR_BYTES.
step_pack_tar() {
  tar \
    --dereference --hard-dereference \
    --directory dist \
    -cf "$RUNNER_TEMP/artifact.tar" \
    --exclude=.git \
    --exclude=.github \
    --exclude=.write-collisions.json \
    --exclude=.write-collisions-data \
    . || return 1
  # Surface size early so a regression past the 1 GB Pages
  # threshold is visible in the workflow log right after pack
  # (instead of only at the deploy-pages "Deployment failed"
  # tail) — the artifact size is the binding constraint.
  ls -lh "$RUNNER_TEMP/artifact.tar"
  # Export for downstream report step (Audit dist bytes).
  TAR_BYTES=$(stat -c %s "$RUNNER_TEMP/artifact.tar") || return 1
  [ -n "$TAR_BYTES" ] || return 1
  export TAR_BYTES
  export_env TAR_BYTES "$TAR_BYTES"
}

# ── 10. Audit dist bytes (per-plugin report) ──────────────────────────────────
# deploy.yml: "Audit dist bytes" — FATAL (plain `run:`).
# Appends a row to data/dist-size-history.jsonl. Commit handled by YAML.
step_audit_bytes() {
  node scripts/report-dist-bytes-by-plugin.mjs \
    --dist=dist \
    --tar-size-bytes="${TAR_BYTES}" \
    --run-id="${GITHUB_RUN_ID}" \
    --sha="${GITHUB_SHA}"
}

# ── 11. File delta vs previous deploy (build summary) ─────────────────────────
# deploy.yml: "File delta vs previous deploy" — NON-FATAL.
step_file_delta() {
  node scripts/deploy-file-delta.mjs \
    --history=data/dist-size-history.jsonl \
    --prev-manifest=prev-content-manifest.tsv \
    --cur-manifest=content-manifest.tsv
}

# ── 12. Refresh url-first-seen (grace-window seed) ────────────────────────────
# deploy.yml: "Refresh url-first-seen" — FATAL (plain `run:`).
# Updates data/url-first-seen.json. Commit handled by YAML.
step_refresh_url_first_seen() {
  node scripts/refresh-url-first-seen.mjs --dist=dist
}

# ── Orchestration (preserve ORDER + fatal/non-fatal exactly) ──────────────────
# FATAL step runner: abort the whole script (non-zero exit) if a fatal step
# fails, mirroring the monolith where each fatal step was its own `run:` that
# failed the build job. WITHOUT this, main()'s trailing `echo` would mask a
# fatal failure and return 0 — e.g. step_drop_assets' `return 1` (CDN push
# failed → dist HTML already rebased to a CDN that has no assets) would be
# swallowed and a broken github-pages artifact (JS/CSS 404) would deploy live.
# (The script intentionally does NOT use a global `set -e`: the step functions
# have their own internal error handling — explicit returns, grep exit codes —
# that a global -e would break. So fatality is enforced here, per-step.)
run_fatal() {
  local label="$1"; shift
  if "$@"; then
    return 0
  fi
  echo "::error::[deploy-it-pages-prep] FATAL step failed — aborting deploy prep (last good stays live): ${label}"
  exit 1
}

main() {
  PREP_CWD="$(pwd)"
  export PREP_CWD

  run_fatal "SPA fallback" step_spa_fallback                        # FATAL
  run_nonfatal "Push generated assets to CDN repo" step_push_cdn     # non-fatal
  run_nonfatal "Offload og refs + data base into dist" step_offload  # non-fatal
  run_nonfatal "Prune superseded CDN asset hashes" step_prune_cdn    # non-fatal
  run_fatal "Drop dist/assets after CDN push" step_drop_assets       # FATAL
  run_nonfatal "Capture pre-deploy sitemap URLs" step_capture_sitemaps   # non-fatal
  run_nonfatal "Pack new sitemap URLs from dist/" step_pack_new_sitemaps # non-fatal
  run_nonfatal "Stage sitemaps bundle" step_stage_bundle            # non-fatal
  run_fatal "Pack dist/ into Pages tar archive" step_pack_tar        # FATAL
  run_fatal "Audit dist bytes" step_audit_bytes                      # FATAL
  run_nonfatal "File delta vs previous deploy" step_file_delta      # non-fatal
  run_fatal "Refresh url-first-seen" step_refresh_url_first_seen     # FATAL

  echo "✅ deploy-it-pages-prep complete"
}

main "$@"

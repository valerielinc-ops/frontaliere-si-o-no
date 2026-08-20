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

# shard_push_with_retry (+ its auth classifier and PAT fallback) — shared with
# push-section-shard.sh / push-locale-shard.sh, used by the CDN assets push
# below instead of a second copy of the retry loop (AGENTS.md #6).
source "$(dirname "${BASH_SOURCE[0]}")/shard-git-helpers.sh"

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
# public/404.html (canton-drift recovery + generic SPA redirect-restore — see
# its own header comment) is already copied to dist/404.html by Vite's default
# publicDir behavior, so only fall back to the plain index.html copy when it is
# somehow absent (defensive: public/404.html is git-tracked and should always
# exist). Previously this unconditionally overwrote dist/404.html, silently
# discarding the canton-drift recovery script for every IT-locale deploy.
step_spa_fallback() {
  [ -f dist/404.html ] || cp dist/index.html dist/404.html
}

# ── R2 publish (Cloudflare R2 via S3 API) — instant PUT, no Pages build ───────
# Used when CDN_TARGET=r2 (else the legacy git force-push below runs). Replaces
# the ~22min GitHub Pages publish latency (root cause of the #2569/#2872 stale-
# locale class) with an instant, read-after-write-strong R2 upload. `rclone copy
# --checksum` is ADDITIVE (copy = no delete → prior asset hashes stay, GC'd by
# the janitor past grace) AND content-diffed (only changed bytes PUT), so the
# clone-prev `cp -n` dance Pages needs is unnecessary here. Per-class
# Cache-Control lets the Cloudflare edge absorb reads (R2 Class B stays in the
# free tier). Content-Type is auto-detected from the file extension by rclone.
# The #2569 atomicity marker is PUT LAST with `no-store` so the cache-busted
# gate (wait-cdn-build-id.sh) sees the new id the instant the full payload is on
# R2 — never an edge-cached stale value.
_publish_cdn_r2() {
  local stage="$1"
  if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] \
     || [ -z "${R2_S3_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
    echo "::warning::CDN_TARGET=r2 but R2_* creds missing — skipping CDN publish (assets stay in dist)"
    return 0
  fi
  # rclone COPY with --checksum: a true CONTENT diff (per-file MD5 vs the S3
  # ETag read from the LIST — no per-object HEAD) → only files whose BYTES
  # changed are PUT. We use `copy`, NOT `sync`: `sync` DELETES dest objects
  # absent from the local stage, which would wipe superseded asset hashes the
  # INSTANT a new build lands — but a visitor whose cached index.html
  # (max-age=600) still references assets/index-OLDHASH.js would then 404 →
  # blank SPA (the 2026-06-04 outage class). `copy` is ADDITIVE (prior hashes
  # stay, GC'd later by the janitor past grace), preserving the same contract
  # as the Pages additive `cp -n` path. `aws s3 sync` was wrong for a different
  # reason: it compares size+mtime, and every deploy rebuilds the files with a
  # newer mtime → it re-uploaded the WHOLE payload (~35k PutObject/deploy,
  # measured), which would exhaust the R2 free-tier Class-A budget (1M/mo) in
  # ~2 days. With copy --checksum the stable assets/og and unchanged data are
  # skipped (0 PUT); only genuinely changed files upload → a few LIST ops + N
  # changed PUTs per deploy. (First rclone run may re-PUT files aws had stored
  # multipart — composite ETag ≠ plain MD5 — once; thereafter single-part.)
  local rtmp="${RUNNER_TEMP:-/tmp}"
  if ! command -v rclone >/dev/null 2>&1; then
    echo "[r2] rclone not found — installing static binary…"
    # --retry: a bare Recv-failure/Connection-reset on this single-shot download
    # (transient network blip, e.g. #run-28599750786) previously failed the
    # WHOLE deploy prep step (no fallback) even though nothing else was wrong.
    if curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
         https://downloads.rclone.org/rclone-current-linux-amd64.zip -o "$rtmp/rclone.zip" \
       && unzip -q -o -j "$rtmp/rclone.zip" '*/rclone' -d "$rtmp/rclone-bin"; then
      chmod +x "$rtmp/rclone-bin/rclone" 2>/dev/null || true
      export PATH="$rtmp/rclone-bin:$PATH"
    fi
    command -v rclone >/dev/null 2>&1 || { echo "::error::CDN_TARGET=r2 but rclone install failed — cannot sync to R2"; return 0; }
  fi
  # On-the-fly S3 remote (no config file). --checksum = content-hash compare;
  # --no-update-modtime avoids rewriting metadata on skipped files;
  # --s3-no-check-bucket skips a HeadBucket (1 fewer op, no CreateBucket perm).
  local RC=(rclone
    --s3-provider=Cloudflare
    --s3-access-key-id="$R2_ACCESS_KEY_ID"
    --s3-secret-access-key="$R2_SECRET_ACCESS_KEY"
    --s3-endpoint="$R2_S3_ENDPOINT"
    --s3-region=auto
    --s3-no-check-bucket
    --checksum --no-update-modtime --transfers=24 --checkers=48 --fast-list)
  local bkt=":s3:$R2_BUCKET" ok=1
  echo "CDN→R2 (rclone --checksum): payload $(du -sh "$stage" | cut -f1) → $bkt"
  _r2_sync() { # <src-dir> <dst-prefix> <cache-control> [json-log] — COPY (additive, no delete)
    [ -d "$1" ] || return 0
    if [ -n "${4:-}" ]; then
      # Capture WHICH objects actually moved so the caller can purge exactly
      # those at the edge (see the assets/ call below). --log-file swallows
      # rclone's stderr, so the log is echoed back to the deploy output after
      # the run — a sync error must stay visible in the job log.
      "${RC[@]}" copy "$1" "$bkt/$2" --header-upload "Cache-Control: $3" --stats=0 \
        -v --use-json-log --log-file="$4" || ok=0
      # `if`, not `[ -s … ] && cat`: an EMPTY log (nothing changed — the common
      # case) would make that the last command and return non-zero from this
      # function. Harmless today (this file deliberately runs without `set -e`,
      # see its note near the step runners) but a trap for whoever adds it.
      if [ -s "$4" ]; then cat "$4"; fi
    else
      "${RC[@]}" copy "$1" "$bkt/$2" --header-upload "Cache-Control: $3" --stats=0 || ok=0
    fi
  }
  # assets/ Cache-Control — read this before changing it.
  #
  # Bundle filenames here are STABLE, never content-hashed
  # (tests/stable-asset-names.test.ts): the BYTES change under the SAME URL on
  # every code deploy. The zone rule `cdn-r2-passthrough-cache`
  # (infra/cloudflare/rules.md) caches this host with
  # `edge_ttl: {mode: 'respect_origin'}`, so whatever we set here IS the edge
  # TTL — and `immutable` on a URL whose bytes change is simply false. It also
  # contradicts public/_headers, which states outright that NOTHING under
  # /assets/ may ever be served `immutable`.
  #
  # The previous `max-age=31536000,immutable` made edge freshness depend
  # ENTIRELY on cf-purge-cache.mjs `purge_everything`, which runs only in
  # post-deploy-validate-live.yml, downstream of deploy-publish.yml. When this
  # was written that purge was simply not happening — deploy-publish.yml had
  # 0 successes in its last 60 runs — so the edge held one build's chunks while
  # R2 served another's: the cross-chunk version skew behind #5062 / #4644.
  #
  # The cause was NOT the three `if:` gates on that chain, which is what this
  # comment used to say. Measured 2026-08-07 over the 300 runs from
  # 2026-08-01T20:25Z to 2026-08-07T05:40Z (0 success / 200 skipped / 65
  # cancelled / 33 failure, last success 30310076907 on 2026-07-27T22:15Z): the
  # `pages-deploy` concurrency QUEUE was jammed, and the gates never got a say.
  # Two overlapping defects:
  #
  #   · deploy-publish.yml triggers on `workflow_run: types: [completed]`, which
  #     fires for the build runs deploy.yml's own newest-wins lock CANCELS —
  #     121 of 141 builds per 48 h (#5251). Those runs skip every job, but a run
  #     joins its concurrency group BEFORE any job `if:` is evaluated, and an
  #     arrival into a full group (1 running + 1 pending) cancels the PENDING
  #     member. Run 31100260885 arrived 12:10:14, killed queued publish
  #     31100206740 at 12:10:15, then skipped at 12:14:48 — two thirds of
  #     everything entering the group was such a no-op.
  #   · no run in that group had a deadline of any kind. A `deploy` job parked
  #     at the `github-pages` environment gate is not "running", so neither
  #     `timeout-minutes` nor the 360-min default applies: run 31118787881 sat
  #     in `waiting` for 14 h with nothing to approve, and with
  #     `cancel-in-progress: false` it pinned the group for all of it.
  #
  # Both are fixed: `.github/workflows/deploy-publish.yml` now routes no-op runs
  # to a per-run group so only real publishes contend, and
  # scripts/ci/unwedge-pages-deploy-queue.mjs (hourly, from
  # pages-publish-lag-watchdog.yml) cancels runs stuck in `waiting`. That
  # restores the purge chain — it does NOT restore `immutable`: everything below
  # about why the TTL is a backstop and the purge is targeted stands on its own,
  # and re-coupling edge freshness to a workflow chain would just re-arm this.
  #
  # The TTL is a BACKSTOP, not the freshness mechanism — freshness comes from
  # the targeted purge below, which runs in this same step right after the
  # upload. The number is therefore chosen to bound how long a MISSED purge can
  # go unnoticed without inflating edge→R2 fetch-through, because every extra
  # origin hop is another chance to hit the transient connect failure
  # (`originResponseStatus: 0`) Cloudflare surfaces as the 502s in
  # #5034/#5035/#5036/#5052/#5081/#5092/#5093/#5094.
  #
  # Measured over 23h: the 661 distinct /assets/ keys took 520k requests but
  # only ~2.9k origin hops (0.57%) — these keys are HOT, so their hop count is
  # driven by TTL expiry per PoP, not by request arrival. Scaling that way,
  # max-age=600 would be ~100x the hops and max-age=86400 ~3x; 7 days keeps the
  # increase modest (~+30%) while still turning "stale forever" into "stale for
  # at most a week". Do NOT raise this back to a year, and do NOT re-add
  # `immutable`.
  local _assets_log="$(mktemp -t r2-assets-XXXXXX.jsonl 2>/dev/null || echo "${RUNNER_TEMP:-/tmp}/r2-assets.jsonl")"
  _r2_sync "$stage/assets"    assets    "public,max-age=604800" "$_assets_log"
  _r2_sync "$stage/og"        og        "public,max-age=86400"
  _r2_sync "$stage/images"    images    "public,max-age=86400"
  _r2_sync "$stage/data"      data      "public,max-age=600"
  _r2_sync "$stage/job-canon" job-canon "public,max-age=600"
  "${RC[@]}" copyto "$stage/index.html" "$bkt/index.html" \
    --header-upload "Content-Type: text/html; charset=utf-8" --header-upload "Cache-Control: public,max-age=600" || ok=0
  if [ "$ok" != 1 ]; then
    echo "⚠️ R2 payload sync had errors — NOT writing marker (shard gate keeps last good live)"
    return 0
  fi
  # Marker LAST (atomicity #2569): only now is this build's full payload on R2.
  printf '%s' "${DEPLOY_BUILD_ID:-}" > "$stage/cdn-build-id.txt"
  if "${RC[@]}" copyto "$stage/cdn-build-id.txt" "$bkt/cdn-build-id.txt" \
       --header-upload "Content-Type: text/plain; charset=utf-8" --header-upload "Cache-Control: no-store, max-age=0"; then
    export_env CDN_BASE "https://cdn.frontaliereticino.ch"
    echo "✅ synced CDN payload to R2 ($R2_BUCKET); marker=${DEPLOY_BUILD_ID:-<empty>}"
  else
    echo "⚠️ R2 marker PUT failed — offload skipped, og/data stay in dist"
  fi
  # Invalidate the edge for EXACTLY the assets/ keys whose bytes just changed.
  # Runs only past the `ok != 1` guard above, so the full payload is already on
  # R2. Targeted (`--files=`, batches of 30) and never `purge_everything`: this
  # host serves ~634k eyeball requests/day at a ~93% edge hit ratio, and
  # dropping all of that at once produces the cold-fill stampede against R2
  # whose edge→origin failures (`originResponseStatus: 0`) Cloudflare returns to
  # users and Googlebot as the 502s in #5034/#5035/#5036/#5052/#5081/#5092/
  # #5093/#5094. Same targeted-purge pattern scripts/publish-article-chunks.mjs
  # already uses for its own out-of-band chunk PUTs.
  #
  # This does NOT replace cf-purge-cache.mjs `purge_everything` in
  # post-deploy-validate-live.yml (still needed for the apex HTML, which the
  # it-apex-html-cache rule holds with `override_origin` 24h). It removes the
  # CDN bundle's DEPENDENCE on that purge, which sits at the end of a workflow
  # chain that went ten days without completing once — see the assets/
  # Cache-Control comment for the queue jam that caused it. The jam is fixed;
  # the decoupling stays, because the failure mode it protects against is
  # "the publish chain stopped running", not "this particular bug existed".
  if [ -s "$_assets_log" ]; then
    node scripts/ci/purge-changed-cdn-assets.mjs "$_assets_log" assets \
      || echo "::warning::targeted CDN asset purge failed — edge falls back to the 7d max-age"
  fi
  rm -f "$_assets_log" 2>/dev/null || true
  # GC visibility scan (Refs #2886, follow-up of #2883's "GC storage R2
  # (janitor): skippato" deferral). DRY-RUN ONLY at this automatic call site —
  # see _janitor_cdn_r2's header comment for why. This just makes bucket growth
  # visible in every deploy log; it never deletes anything on its own.
  _janitor_cdn_r2 "$stage" "dry-run"
}

# ── R2 storage janitor (GC orphaned assets/ hashes past grace) ───────────────
# Follow-up of #2883 (Refs #2886): the git-based CDN janitor (prune-cdn-assets.mjs,
# step_prune_cdn below) explicitly skips R2 — no git repo, no ~1 GB Pages soft
# limit to defend. But R2's additive `rclone copy` (see _publish_cdn_r2 above:
# `copy`, not `sync`, so prior content-hashed generations are NEVER deleted by
# the publish path itself) means every superseded assets/ hash accumulates
# forever. At 1.27 GB of the 10 GB free tier there is ample margin today, but
# unbounded growth eventually saturates the tier → PUT failures → deploy
# failure → SEO impact (issue #2886 rationale).
#
# SAFETY (standing repo rule: no irreversible production action without
# explicit owner sign-off) — DRY-RUN BY DEFAULT, always:
#   - Real deletion requires BOTH mode="apply" (2nd arg) AND the explicit env
#     opt-in R2_JANITOR_APPLY=1. Either missing → dry-run, zero DeleteObject
#     calls. Mirrors the --apply convention this repo already uses for other
#     destructive one-off scripts (scripts/dev/backfill-newsletter-subscriber-auth.mjs).
#   - The ONLY automatic call site (end of _publish_cdn_r2 above) always passes
#     mode="dry-run" literally — it never sets R2_JANITOR_APPLY. Real deletion
#     is a manual, owner-triggered invocation only
#     (`R2_JANITOR_APPLY=1 bash -c '. scripts/lib/deploy-it-pages-prep.sh; _janitor_cdn_r2 <stage> apply'`),
#     never wired into deploy.yml or any other CI trigger.
#
# Grace period: R2_JANITOR_GRACE_DAYS (default 7) — same default GRACE_DAYS
# uses in prune-cdn-assets.mjs, for a consistent GC posture across both CDN
# publish paths (pages vs r2). Objects newer than the cutoff are NEVER
# candidates, in ANY mode — checked before the anti-clobber re-check below.
#
# Anti-clobber (assertFreshRemote-equivalent, see prune-cdn-assets.mjs): R2 has
# no git tip to re-check, so the analogous defense-in-depth is per-object —
# right before deleting a candidate, re-`head-object` it and compare ETag
# against the value captured at list-time. A mismatch (or the object having
# vanished) means something touched that key mid-run (e.g. a concurrent
# deploy's re-upload) — skip deleting THAT key rather than trust the stale
# list snapshot, exactly the same "verify nothing moved since we looked"
# principle assertFreshRemote applies before the git janitor's force-push.
#
# Scope: only the `assets/` prefix — content-hashed bundle files are the only
# ones that actually accumulate orphans; og/data/images/job-canon are
# same-key overwrites every deploy (see _r2_sync above) and never grow
# unbounded, so they are out of scope for this janitor.
_janitor_cdn_r2() {
  local stage="$1"
  local mode="${2:-dry-run}"  # 'dry-run' (only value the automatic call site ever passes) | 'apply'
  if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] \
     || [ -z "${R2_S3_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
    echo "[r2-janitor] R2_* creds missing — skipping GC scan"
    return 0
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "[r2-janitor] aws CLI not found (expected preinstalled on GitHub-hosted ubuntu runners) — skipping GC scan"
    return 0
  fi
  if [ ! -d "$stage/assets" ]; then
    # Authoritative active set is THIS build's stage/assets — absent means we
    # cannot tell what's still referenced. FAIL-CLOSED (same posture as
    # prune-cdn-assets.mjs's DIST_ASSETS_DIR guard): no candidates, no scan.
    echo "[r2-janitor] $stage/assets absent — FAIL-CLOSED, skipping GC scan"
    return 0
  fi

  # Double gate: caller must literally pass mode="apply" AND the explicit env
  # opt-in must be "1". Either missing → dry-run.
  local do_apply=0
  if [ "$mode" = "apply" ] && [ "${R2_JANITOR_APPLY:-}" = "1" ]; then
    do_apply=1
  fi

  local grace_days="${R2_JANITOR_GRACE_DAYS:-7}"
  case "$grace_days" in (''|*[!0-9]*) grace_days=7 ;; esac
  local cutoff_epoch
  cutoff_epoch=$(( $(date -u +%s) - grace_days * 86400 ))

  local aws_env=(env "AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY" "AWS_DEFAULT_REGION=auto")
  local AWS=("${aws_env[@]}" aws --endpoint-url "$R2_S3_ENDPOINT")

  local active_list; active_list="$(mktemp)"
  ( cd "$stage/assets" && ls -1 ) > "$active_list" 2>/dev/null || true

  local listing; listing="$(mktemp)"
  if ! "${AWS[@]}" s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "assets/" \
       --query 'Contents[].{Key:Key,Size:Size,LastModified:LastModified,ETag:ETag}' \
       --output json > "$listing" 2>/tmp/r2-janitor-list.err; then
    echo "::warning::[r2-janitor] list-objects-v2 failed — $(cat /tmp/r2-janitor-list.err 2>/dev/null)"
    rm -f "$active_list" "$listing"
    return 0
  fi

  # node does the set-diff + grace filter + byte totals — parsing the aws CLI's
  # JSON output in pure bash would be fragile/quoting-hazardous.
  local candidates; candidates="$(mktemp)"
  node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(process.argv[1], "utf8").trim();
    const objects = raw ? (JSON.parse(raw) || []) : [];
    const active = new Set(fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean));
    const cutoffEpoch = Number(process.argv[3]);
    const out = [];
    for (const o of objects) {
      if (!o || !o.Key) continue;
      const base = o.Key.slice("assets/".length);
      if (!base || base === ".hash-age.json") continue; // never a real bundle file
      if (active.has(base)) continue; // referenced by the CURRENT build — never a candidate
      const lm = Date.parse(o.LastModified) / 1000;
      if (!Number.isFinite(lm) || lm > cutoffEpoch) continue; // inside grace — never a candidate
      out.push({ key: o.Key, size: o.Size || 0, etag: o.ETag || "" });
    }
    fs.writeFileSync(process.argv[4], JSON.stringify(out));
  ' "$listing" "$active_list" "$cutoff_epoch" "$candidates"
  rm -f "$active_list" "$listing"

  local count total_bytes
  count="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).length))' "$candidates")"
  total_bytes="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).reduce((a,o)=>a+(o.size||0),0)))' "$candidates")"

  echo "[r2-janitor] scan: bucket=$R2_BUCKET prefix=assets/ grace=${grace_days}d candidates=${count} bytes=${total_bytes}"
  if [ "${count:-0}" -eq 0 ]; then
    echo "[r2-janitor] nothing to prune"
    rm -f "$candidates"
    return 0
  fi

  if [ "$do_apply" -ne 1 ]; then
    echo "[r2-janitor] DRY-RUN (mode=$mode, R2_JANITOR_APPLY=${R2_JANITOR_APPLY:-<unset>}) — would delete ${count} object(s), ${total_bytes} bytes total. Zero DeleteObject calls issued. Candidates:"
    node -e 'for(const o of JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))) console.log("  - "+o.key+" ("+o.size+" bytes)")' "$candidates"
    rm -f "$candidates"
    return 0
  fi

  echo "[r2-janitor] APPLY mode — deleting ${count} object(s), ${total_bytes} bytes"
  local deleted=0 skipped_changed=0
  while IFS=$'\t' read -r key etag; do
    [ -n "$key" ] || continue
    # Anti-clobber re-check (see header comment) — trust nothing older than
    # "right now".
    local live_etag
    live_etag="$("${AWS[@]}" s3api head-object --bucket "$R2_BUCKET" --key "$key" \
      --query 'ETag' --output text 2>/dev/null || true)"
    if [ -z "$live_etag" ] || [ "$live_etag" != "$etag" ]; then
      echo "[r2-janitor] skip (changed/vanished since scan): $key"
      skipped_changed=$((skipped_changed + 1))
      continue
    fi
    if "${AWS[@]}" s3 rm "s3://$R2_BUCKET/$key" >/dev/null 2>&1; then
      deleted=$((deleted + 1))
    else
      echo "::warning::[r2-janitor] delete failed: $key"
    fi
  done < <(node -e 'for(const o of JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))) console.log(o.key+"\t"+o.etag)' "$candidates")

  echo "[r2-janitor] ✅ deleted ${deleted} object(s), skipped ${skipped_changed} (changed/vanished since scan)"
  rm -f "$candidates"
}

# ── 2. Push generated assets to CDN repo (frontaliere-cdn / Pages) ────────────
# deploy.yml: "Push generated assets to CDN repo" — NON-FATAL (continue-on-error).
# Stages CDN payload (dist/og, dist/data, dist/assets, dist/job-canon,
# public/images/*), then
# publishes via CDN_TARGET: 'r2' (S3 sync, default-off) or 'pages' (legacy git
# force-push to valerielinc-ops/frontaliere-cdn). Exports CDN_BASE on success.
# Internally non-fatal: every failure path keeps the assets in dist.
step_push_cdn() {
  set -uo pipefail
  # CDN_TARGET selects the publish path; default 'pages' keeps the legacy
  # git-push behaviour byte-identical. The credential guard is per-target,
  # applied inside each branch below (fail-closed): r2 → R2_* creds, pages →
  # CDN_DEPLOY_KEY.
  local cdn_target="${CDN_TARGET:-pages}"
  stage=/tmp/cdn-stage
  # Same leaked-staging-dir class fixed for push-locale-shard.sh /
  # push-section-shard.sh (issue #4734): $stage holds up to ~950 MB
  # (og+data+assets+images) and is never read again after this function
  # returns, on any of its several exit paths (no-offloadable-assets,
  # r2-only, missing CDN_DEPLOY_KEY, or the normal push-then-fallthrough
  # path). trap RETURN frees it on every path instead of duplicating
  # rm -rf at each return.
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" RETURN
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
  # Canton-drift 404-recovery shard map (jobCanonRedirectMapPlugin, ~29 MB /
  # 400 shards): runtime-fetch only (public/404.html + the Worker), no static
  # HTML ref to rewrite, so the offload script just deletes dist/job-canon
  # once this push succeeds (see its job-canon phase).
  [ -d dist/job-canon ]    && cp -r dist/job-canon    "$stage/job-canon"
  [ -d public/images/blog ] && mkdir -p "$stage/images" && cp -r public/images/blog "$stage/images/blog"
  # Self-hosted brand/logo/author images (#1360): push from the git-tracked
  # public/images/<dir> source to ${CDN}/images/<dir>, so the offload script
  # (offload-generated-images-cdn.mjs IMAGE TARGETS) can rewrite the static HTML
  # refs + the SPA's cdnImageUrl() runtime refs to the CDN and then delete the
  # dist copies. MUST stay in sync with that script's TARGETS and
  # services/cdnImageBase.ts CDN_OFFLOADED_IMAGE_PREFIXES.
  # (/images/places is intentionally excluded — it stays same-origin.)
  #
  # `events` is NOT in this list any more (#6163). Those 5'568 mirrored source
  # images were 4'108 MB of the tracked tree and are no longer committed, so in
  # a deploy checkout public/images/events simply does not exist: leaving it
  # here would have staged nothing and looked like it still worked. The CDN copy
  # is now written by whoever produces it — crawl-events.yml uploads each image
  # it mirrors, in the same run, via scripts/lib/upload-cdn-file.sh. Do not add
  # it back: a deploy has no source to push from, and re-adding it would make
  # this loop's silence look like coverage.
  #
  # Nothing is lost at the edge by dropping it: the R2 publish path
  # (_publish_cdn_r2, CDN_TARGET=r2) is `rclone copy` — additive, never
  # `sync` — so an absent stage dir cannot delete the 5'568 objects already in
  # the bucket, and _janitor_cdn_r2 only ever scans the `assets/` prefix.
  # The legacy Pages path below IS a force-push of the whole stage, so if
  # CDN_TARGET is ever flipped back to 'pages' the events images WOULD be
  # dropped from the frontaliere-cdn repo — flip it only after giving that path
  # its own source for them.
  for d in brands insurers providers logos authors publisher; do
    [ -d "public/images/$d" ] && mkdir -p "$stage/images" && cp -r "public/images/$d" "$stage/images/$d"
  done
  # Build-time generated per-category "catalog" fallback SVGs (#3740,
  # writeCatalogImages() in build-plugins/eventsSeoPagesPlugin.ts). These 11
  # deterministic SVGs are emitted straight into dist/images/events/catalog/ at
  # build time and are NOT git-tracked, so the public/images/$d loop above never
  # picks them up. (Until #6163 this comment contrasted them with the mirrored
  # real event photos "git-tracked under public/images/events/" — those are
  # neither tracked nor staged by that loop any more, so the contrast no longer
  # holds; what survives is the reason this copy exists.) Without this stage
  # copy, offload-generated-images-cdn.mjs
  # still rewrote the HTML refs to the CDN and deleted the dist copies, leaving
  # cdn.frontaliereticino.ch/images/events/catalog/*.svg permanently 404.
  [ -d dist/images/events/catalog ] && mkdir -p "$stage/images/events" && cp -r dist/images/events/catalog "$stage/images/events/catalog"
  # Strip junk the recursive copies drag in: macOS .DS_Store files and the
  # internal build-telemetry assets/.hash-age.json (chunk first-seen/last-access
  # timestamps — not a runtime asset, must not be published).
  find "$stage" -name '.DS_Store' -delete 2>/dev/null || true
  rm -f "$stage/assets/.hash-age.json" 2>/dev/null || true
  if [ ! -d "$stage/og" ] && [ ! -d "$stage/data" ] && [ ! -d "$stage/assets" ] && [ ! -d "$stage/images" ] && [ ! -d "$stage/job-canon" ]; then
    echo "no offloadable assets present — skipping CDN push"; return 0
  fi
  printf '<!doctype html><meta charset=utf-8><title>frontaliereticino.ch CDN</title>frontaliereticino.ch asset CDN' > "$stage/index.html"

  # ── Publish: r2 (instant) | both (dual-publish for cutover) | pages (legacy) ─
  # 'both' writes R2 AND Pages so the live domain (still → Pages until the R2
  # custom-domain flip) keeps serving while R2 is populated+validated in
  # parallel — zero-downtime cutover. 'r2' is R2-only (post-flip). 'pages'
  # (default) is the legacy git force-push, byte-identical to before.
  if [ "$cdn_target" = "r2" ] || [ "$cdn_target" = "both" ]; then
    _publish_cdn_r2 "$stage"
    if [ "$cdn_target" = "r2" ]; then
      cd "$PREP_CWD"
      return 0
    fi
    # 'both': fall through to ALSO publish to Pages (live domain unchanged).
  fi
  # Legacy Pages path below (CDN_TARGET=pages or both).
  if [ -z "${CDN_DEPLOY_KEY:-}" ]; then
    echo "no CDN_DEPLOY_KEY secret — skipping CDN push, assets stay in dist"
    cd "$PREP_CWD"
    return 0
  fi
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
  # Cross-shard atomicity marker (#2569): stamp THIS build's DEPLOY_BUILD_ID
  # into the CDN payload so it is published in the SAME force-push as the
  # assets/data. The non-IT shards (en/de/fr) poll cdn.frontaliereticino.ch/
  # cdn-build-id.txt for this exact id BEFORE publishing → they never go live
  # referencing a CDN that does not yet hold this build's /data + /assets.
  # When DEPLOY_BUILD_ID is unset (local run / monolith path) the marker is
  # written empty — harmless, the shard gate only enforces on a non-empty id.
  printf '%s' "${DEPLOY_BUILD_ID:-}" > "$stage/cdn-build-id.txt"
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
  # Was a hand-rolled copy of shard_push_with_retry's 3-attempts-with-backoff
  # loop. Routed through the shared helper instead (AGENTS.md #6) so this push
  # also gets the auth-failure classifier and the PAT fallback: a read-only or
  # revoked CDN_DEPLOY_KEY used to mean "offload skipped, og/data stay in dist"
  # on every deploy, the same silent-degradation shape as the uri-it shard
  # incident of 2026-07-30.
  _push_ok=0
  if shard_push_with_retry "$stage" "git@github.com:valerielinc-ops/frontaliere-cdn.git" main "CDN"; then
    _push_ok=1
  fi
  if [ "$_push_ok" = 1 ]; then
    export_env CDN_BASE "https://cdn.frontaliereticino.ch"
    echo "✅ pushed assets to frontaliere-cdn"
  else
    echo "⚠️ CDN push failed after 3 attempts — offload skipped, og/data stay in dist"
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
  # The janitor is git-based (clone + force-push frontaliere-cdn). On R2 there is
  # no git repo and no ~1 GB Pages limit to defend, so skip it here — R2 storage
  # GC is a separate (S3 ListObjects + DeleteObject) follow-up; at 1.27 GB the
  # 10 GB R2 free-tier has ample headroom in the meantime.
  if [ "${CDN_TARGET:-pages}" = "r2" ]; then
    echo "CDN_TARGET=r2 — skipping git-based assets janitor (R2 has no 1 GB limit; GC is a follow-up)"; return 0
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

  # ── EARLY-CDN-PUSH MODE (deploy.yml "Push generated assets to CDN (early)") ─
  # Runs section 2 ALONE and returns. deploy.yml hoists it ahead of the IT
  # section-shard fan-out so the #2569 marker turns ~40min earlier and the
  # en/de/fr ordering gate stops living on the edge of its 2700s budget (run
  # 31076991699: matched with 0s to spare; run 31062047677: all three timed
  # out). See that step's comment for why the payload bytes are identical at
  # either call site. Everything else in this script still runs, in the
  # original order, from the normal (unflagged) invocation below.
  if [ "${DEPLOY_CDN_PUSH_ONLY:-}" = "1" ]; then
    run_nonfatal "Push generated assets to CDN repo (early phase)" step_push_cdn
    if [ -n "${CDN_BASE:-}" ]; then
      echo "✅ early CDN push complete — CDN_BASE exported, the full prep will skip its own push"
    else
      # NOT an error: the full prep below still performs the push at its
      # original position, exactly as before this phase existed.
      echo "::warning::[deploy-it-pages-prep] early CDN push did not publish (CDN_BASE unset) — the full prep will retry it at its original position"
    fi
    return 0
  fi

  run_fatal "SPA fallback" step_spa_fallback                        # FATAL
  # Skipped iff the early phase above already published THIS build's payload
  # (it exported CDN_BASE into $GITHUB_ENV, which GitHub injects into this
  # step's env). Unset → push here, i.e. the pre-hoist behaviour verbatim.
  if [ -n "${CDN_BASE:-}" ]; then
    echo "CDN_BASE=$CDN_BASE already set by the early CDN push phase — skipping the CDN push (payload for this build is live)"
  else
    run_nonfatal "Push generated assets to CDN repo" step_push_cdn   # non-fatal
  fi
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

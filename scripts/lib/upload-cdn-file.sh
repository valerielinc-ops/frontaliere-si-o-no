#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/upload-cdn-file.sh — single-file additive PUT to the Cloudflare
# R2 CDN. Sibling of _publish_cdn_r2 in scripts/lib/deploy-it-pages-prep.sh
# (NOT a modification of it — that function syncs a whole build's `dist/`
# subtrees; this script exists for the near-instant single-article publish
# path in issue #4837, which needs to push ONE new asset — e.g. a hero image —
# without touching an entire deploy stage dir).
#
# Reuses rclone (same tool deploy-it-pages-prep.sh already provisions in CI —
# no new dependency introduced) with the identical on-the-fly S3-remote
# invocation (`--s3-provider=Cloudflare`, no config file, creds via flags).
# The rclone-not-found auto-install block below is intentionally DUPLICATED
# from _publish_cdn_r2 rather than extracted into a shared module: this repo's
# established convention for this script family (push-section-shard.sh /
# push-locale-shard.sh / push-article-shard-incremental.sh) is siblings kept
# in lockstep via header comments, not shared-module extraction. Do not "fix"
# this duplication without also re-reading deploy-it-pages-prep.sh's rationale
# comment above _publish_cdn_r2.
#
# `copyto` (never `sync`) = additive, single-key PUT — cannot delete anything
# else in the bucket. Always PUTs unconditionally (`--ignore-times`, see the
# rclone invocation below) rather than trying to skip unchanged re-runs: see
# that comment for why a content-hash skip is unsafe for the files this
# script actually carries (issue #5497).
#
# Content-Type: rclone/Go's mime-type auto-detection is NOT reliable for
# `.webp` on GitHub-hosted runners (depends on the runner's /etc/mime.types
# having a webp entry, which is not guaranteed) — the explicit requirement
# that prompted this script. Rather than trust auto-detection for anything,
# every extension this script expects to see gets an explicit
# `--header-upload "Content-Type: ..."`; unknown extensions fall back to
# application/octet-stream (a safe generic default, never wrong, just non-
# ideal for direct-embed).
#
# Failure posture: EVERY failure mode here — missing local file, missing R2
# credentials, rclone install failure, or the upload itself failing — is
# reported (::warning:: / ::error::) and the script still exits 0. This is
# deliberate, not an oversight: the hero image (and anything else this script
# is expected to carry) has a client-side raw.githubusercontent.com fallback,
# so this script backs a best-effort CDN warm rather than a hard publish gate.
# A caller that wants to know whether the PUT actually happened should grep
# this script's stdout for "✅ uploaded" rather than rely on the exit code.
#
# Usage:
#   upload-cdn-file.sh <local_file> <cdn_key> [cache_control]
#     <local_file>     path to the file to upload
#     <cdn_key>        destination key inside R2_BUCKET, e.g.
#                      images/articoli/some-slug/hero.webp (leading "/" is
#                      stripped if present — R2 keys are never rooted)
#     [cache_control]  optional; default "public, max-age=86400" (matches the
#                      images/ class _r2_sync already uses for the same kind
#                      of content in deploy-it-pages-prep.sh)
#
# Required env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT,
#   R2_BUCKET — identical names to deploy-it-pages-prep.sh's _publish_cdn_r2.
#   Any missing → notice + exit 0 (never fatal, see above).
# Optional env: RUNNER_TEMP — used for the rclone install scratch dir; falls
#   back to /tmp if unset (same fallback as _publish_cdn_r2).
#
# Exit codes: always 0 except bad usage (wrong arg count) → 1. Every runtime
# failure mode is intentionally non-fatal — see "Failure posture" above.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: upload-cdn-file.sh <local_file> <cdn_key> [cache_control]" >&2
  exit 1
fi
local_file="$1"
cdn_key="${2#/}"
cache_control="${3:-public, max-age=86400}"

if [ ! -f "$local_file" ]; then
  echo "notice: local file not found: $local_file — skipping CDN upload"
  exit 0
fi

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] \
   || [ -z "${R2_S3_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  echo "notice: R2_* credentials missing — skipping CDN upload of $cdn_key (client-side raw.githubusercontent.com fallback covers this)"
  exit 0
fi

# Extension → Content-Type. Explicit table, not auto-detection — see header
# comment for why (.webp specifically is unreliable via rclone/Go mime sniff
# on some runners).
_content_type_for() {
  local ext="${1##*.}"
  ext="$(printf '%s' "$ext" | tr 'A-Z' 'a-z')"
  case "$ext" in
    webp) printf '%s' "image/webp" ;;
    png) printf '%s' "image/png" ;;
    jpg|jpeg) printf '%s' "image/jpeg" ;;
    gif) printf '%s' "image/gif" ;;
    avif) printf '%s' "image/avif" ;;
    svg) printf '%s' "image/svg+xml" ;;
    ico) printf '%s' "image/x-icon" ;;
    html|htm) printf '%s' "text/html; charset=utf-8" ;;
    json) printf '%s' "application/json; charset=utf-8" ;;
    js|mjs) printf '%s' "application/javascript; charset=utf-8" ;;
    css) printf '%s' "text/css; charset=utf-8" ;;
    txt) printf '%s' "text/plain; charset=utf-8" ;;
    xml) printf '%s' "application/xml; charset=utf-8" ;;
    woff2) printf '%s' "font/woff2" ;;
    woff) printf '%s' "font/woff" ;;
    pdf) printf '%s' "application/pdf" ;;
    *) printf '%s' "application/octet-stream" ;;
  esac
}
content_type="$(_content_type_for "$local_file")"

rtmp="${RUNNER_TEMP:-/tmp}"
# An earlier invocation in the same job may have already installed rclone: the
# `export PATH` below dies with that subshell (each call is its own bash
# process) but the binary survives on disk. Without this, every uploaded file
# re-downloads and re-unzips the ~20 MB archive — measured at ~4.5s per file on
# a path whose entire reason to exist is speed (run 30365047167 paid it twice).
if [ -x "$rtmp/rclone-bin/rclone" ]; then
  export PATH="$rtmp/rclone-bin:$PATH"
fi
if ! command -v rclone >/dev/null 2>&1; then
  echo "[cdn-upload] rclone not found — installing static binary…"
  # #7503: `unzip` exits 1 for NON-fatal warnings with the member extracted
  # anyway (>= 2 are the real errors), so gating the install on rc == 0 threw
  # away a working binary and skipped the CDN upload. The binary on disk is
  # the contract, not unzip's exit code.
  if curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
       https://downloads.rclone.org/rclone-current-linux-amd64.zip -o "$rtmp/rclone.zip"; then
    unzip -q -o -j "$rtmp/rclone.zip" '*/rclone' -d "$rtmp/rclone-bin" || true
    if [ -f "$rtmp/rclone-bin/rclone" ]; then
      chmod +x "$rtmp/rclone-bin/rclone" 2>/dev/null || true
      export PATH="$rtmp/rclone-bin:$PATH"
    fi
  fi
  if ! command -v rclone >/dev/null 2>&1; then
    echo "::warning::[cdn-upload] rclone install failed — skipping CDN upload of $cdn_key"
    exit 0
  fi
fi

RC=(rclone
  --s3-provider=Cloudflare
  --s3-access-key-id="$R2_ACCESS_KEY_ID"
  --s3-secret-access-key="$R2_SECRET_ACCESS_KEY"
  --s3-endpoint="$R2_S3_ENDPOINT"
  --s3-region=auto
  --s3-no-check-bucket
  # `--ignore-times`, NOT `--checksum` (issue #5497): rclone's `--checksum`
  # skips the PUT whenever it decides src and dst already match, and per
  # rclone's own operations.Equal(), when no common hash type is available
  # between the local file and the R2 object it falls back to comparing
  # SIZE ONLY — logging "falling back to --size-only" once — and treats a
  # same-size object as identical even if its bytes differ. Reproduced here:
  # `/edge/rss.xml` and the other nine RSS feeds this script serves have a
  # fixed-width publish-date field (the article engine's RSS generator
  # renders it via the JS Date-to-UTC-string builtin, always the same
  # character count) and a capped item list, so a genuinely new build can
  # land at the exact same byte size as the R2 object it is meant to
  # replace — rclone then silently skips the PUT while still exiting 0, so
  # this script's own "✅ uploaded" success marker (grepped by
  # publish-edge-files.mjs) fires for a PUT that never happened. The sibling
  # sitemap files were never observed to hit this because their item counts
  # (and therefore byte size) change on essentially every run. `--ignore-times`
  # removes the skip decision entirely — every invocation PUTs unconditionally
  # — which is acceptable here because callers already gate on the file
  # having actually changed before invoking this script at all (see e.g. the
  # per-artifact diff check in sync-articles-sitemaps.yml), so there is no
  # redundant-PUT cost to guard against.
  --ignore-times)
bkt=":s3:$R2_BUCKET"

# One retry on transient network blips (same rationale as the curl --retry
# above the rclone-install block, and _publish_cdn_r2's own comment on
# run-28599750786): a single-shot upload with no fallback previously failed
# the whole deploy prep step on a bare connection reset even though nothing
# else was wrong. Still never fatal — see header "Failure posture".
attempt_ok=0
for try in 1 2; do
  if "${RC[@]}" copyto "$local_file" "$bkt/$cdn_key" \
       --header-upload "Content-Type: $content_type" \
       --header-upload "Cache-Control: $cache_control" \
       --stats=0; then
    attempt_ok=1
    break
  fi
  if [ "$try" -lt 2 ]; then
    echo "::warning::[cdn-upload] upload attempt $try/2 failed for $cdn_key — retrying in 3s"
    sleep 3
  fi
done

if [ "$attempt_ok" = 1 ]; then
  echo "✅ uploaded $local_file -> $bkt/$cdn_key (Content-Type: $content_type)"
else
  echo "::warning::[cdn-upload] upload failed for $cdn_key after 2 attempts — non-fatal (client-side fallback covers this)"
fi
exit 0

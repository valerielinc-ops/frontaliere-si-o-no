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
# Failure posture: missing local file, missing R2 credentials, rclone install
# failure, image lease acquisition/verification failure, or the upload itself
# failing is reported and the script still exits 0. Bad usage and failure to
# safely release a lease owned here exit 1. INT/TERM exit 130/143 after stopping
# the uploader child; a caller-owned lease is never released here. The hero
# image (and anything else this script is expected to carry) has a client-side
# raw.githubusercontent.com fallback, so this script backs a best-effort CDN
# warm rather than a hard publish gate.
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
# For images/blog/ and images/places/ PUTs, R2 image namespace leases serialize
# writers with the reader that validates held assets before publishing HTML.
# A caller holding a lease passes its verified capability in
# FRONTALIERE_R2_IMAGE_LEASE_CONTEXT. Unscoped, malformed, expired, or
# unavailable leases never authorize a PUT.
# Every `copyto` timeout runs as a tracked child and is stopped/reaped before a
# handled INT/TERM exits. Other CDN keys get that cancellation safety without
# acquiring or releasing a blog/places lease.
# `--image-lease-protocol-version` prints the protocol version without reading
# credentials or contacting R2; workflows use it to reject an old pinned SHA.
#
# Exit codes: 0 for best-effort runtime failures; 1 for bad usage or failed
# release of an owned image lease; 130/143 for handled INT/TERM cancellation.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -eq 1 ] && [ "$1" = "--image-lease-protocol-version" ]; then
  printf '1\n'
  exit 0
fi

check_mode=0
if [ "$#" -eq 2 ] && [ "$1" = "--check" ]; then
  check_mode=1
  cdn_key="${2#/}"
elif [ "$#" -ge 2 ] && [ "$#" -le 3 ]; then
  local_file="$1"
  cdn_key="${2#/}"
  cache_control="${3:-public, max-age=86400}"
else
  echo "Usage: upload-cdn-file.sh <local_file> <cdn_key> [cache_control]" >&2
  echo "       upload-cdn-file.sh --check <cdn_key>" >&2
  exit 1
fi

if [ "$check_mode" -eq 0 ] && [ ! -f "$local_file" ]; then
  echo "notice: local file not found: $local_file — skipping CDN upload"
  exit 0
fi

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] \
   || [ -z "${R2_S3_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  if [ "$check_mode" -eq 1 ]; then
    echo "⚠️ check indeterminate for $cdn_key: R2_* credentials missing"
    exit 0
  fi
  echo "notice: R2_* credentials missing — skipping CDN upload of $cdn_key (client-side raw.githubusercontent.com fallback covers this)"
  exit 0
fi

# R2 wall-clock limit (seconds) read from the environment. `timeout 0` means NO
# limit in GNU coreutils, and a non-number makes `timeout` fail before the call
# runs, so only a whole number from 1 to 9999 is taken; anything else (0, empty,
# "-5", "2m", "inf") falls back to the default with a warning. Kept
# byte-identical in upload-cdn-file.sh and deploy-it-pages-prep.sh:
# tests/r2-calls-bounded.test.ts compares the two copies.
_r2_timeout_s() {
  local name="$1" fallback="$2" value
  value="${!name-}"
  if [[ "$value" =~ ^[1-9][0-9]{0,3}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if [ -n "$value" ]; then
    echo "::warning::[r2] $name='$value' is not a whole number of seconds from 1 to 9999 — using ${fallback}s" >&2
  fi
  printf '%s\n' "$fallback"
}

# Extension → Content-Type. Explicit table, not auto-detection — see header
# comment for why (.webp specifically is unreliable via rclone/Go mime sniff
# on some runners).
_content_type_for() {
  local ext="${1##*.}"
  ext="$(printf '%s' "$ext" | tr 'A-Z' 'a-z')"
  case "$ext" in
    mp4) printf '%s' "video/mp4" ;;
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
content_type=""
if [ "$check_mode" -eq 0 ]; then
  content_type="$(_content_type_for "$local_file")"
fi

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
  if curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 15 --max-time 120 \
       https://downloads.rclone.org/rclone-current-linux-amd64.zip -o "$rtmp/rclone.zip"; then
    unzip_rc=0
    unzip -q -o -j "$rtmp/rclone.zip" '*/rclone' -d "$rtmp/rclone-bin" || unzip_rc=$?
    if [ "$unzip_rc" -eq 1 ]; then
      echo "::warning::[cdn-upload] rclone archive extracted with unzip warnings (exit 1)"
    elif [ "$unzip_rc" -ge 2 ]; then
      echo "::warning::[cdn-upload] rclone archive extraction failed (unzip exit $unzip_rc)"
    fi
    if [ "$unzip_rc" -lt 2 ] && [ -s "$rtmp/rclone-bin/rclone" ] \
       && chmod +x "$rtmp/rclone-bin/rclone" 2>/dev/null \
       && timeout -k 5 30 "$rtmp/rclone-bin/rclone" version >/dev/null 2>&1; then
      export PATH="$rtmp/rclone-bin:$PATH"
    fi
  fi
  if ! command -v rclone >/dev/null 2>&1; then
    if [ "$check_mode" -eq 1 ]; then
      echo "⚠️ check indeterminate for $cdn_key: rclone installation failed"
      exit 0
    fi
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
  # Connect and IO-idle limits per request; the wall-clock limit is the
  # `timeout` around the call below (NX-SKEW-2b: no unbounded R2 call on a
  # deploy path — publish-edge-files.mjs runs this inside deploy.yml).
  --contimeout=15s --timeout=60s
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
# One limit for every per-object R2 call in this script, resolved once: the
# lookup below and the upload further down. Keeping it in a variable is also
# what lets tests/r2-calls-bounded.test.ts read the bound in front of each
# call — a limit written as a nested command substitution was not recognised,
# and the lookup added with the governed image engine looked unbounded.
r2_timeout_object_s="$(_r2_timeout_s R2_TIMEOUT_OBJECT_S 120)"

## Inspect the single-object result without treating an implicit S3 prefix as a file.
# On bucket remotes, a missing object can resolve to an empty directory/prefix;
# `lsf` output is a listing, so any child row is not proof that this exact key
# exists. `lsjson --stat` returns one JSON item: IsDir=false means an object,
# including a zero-byte object; IsDir=true means only a directory/prefix.
# JSON parsing also avoids delimiter and quoting ambiguity for special keys.
rcloneObjectKeyPresent() {
  node -e '
    let item;
    try { item = JSON.parse(process.argv[1] ?? ""); } catch { process.exit(2); }
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.IsDir !== "boolean") process.exit(2);
    process.exit(item.IsDir ? 1 : 0);
  ' "$1"
}

if [ "$check_mode" -eq 1 ]; then
  # A non-zero result is a transport/authentication failure, so upload callers
  # remain conservative and do not treat the lookup as a confirmed hit.
  check_output=""
  check_status=0
  check_output="$(timeout -k 10 "$r2_timeout_object_s" \
    "${RC[@]}" lsjson --stat --no-mimetype --no-modtime "$bkt/$cdn_key" 2>/dev/null)" || check_status=$?
  if [ "$check_status" -ne 0 ]; then
    echo "⚠️ check indeterminate for $cdn_key: R2 lookup failed (exit $check_status)"
  elif rcloneObjectKeyPresent "$check_output"; then
    echo "✅ exists $cdn_key"
  else
    check_presence_status=$?
    if [ "$check_presence_status" -eq 1 ]; then
      echo "❌ missing $cdn_key"
    else
      echo "⚠️ check indeterminate for $cdn_key: invalid R2 object metadata"
    fi
  fi
  exit 0
fi

image_namespace=""
case "$cdn_key" in
  images/blog/*) image_namespace="blog" ;;
  images/places/*) image_namespace="places" ;;
esac

if [ -n "$image_namespace" ]; then
  image_lease_cli="$script_dir/r2-image-namespace-lock.mjs"
fi
image_lease_process_helper="$script_dir/r2-image-lease-process.sh"
if [ ! -f "$image_lease_process_helper" ]; then
  echo "::warning::[cdn-upload] image writer process helper is missing — skipping upload of $cdn_key"
  exit 0
fi
source "$image_lease_process_helper"
_R2_IMAGE_LEASE_ACTIVE=1
_R2_IMAGE_LEASE_TIMEOUT_PID=
_R2_IMAGE_LEASE_RELEASE_ALLOWED=1
_R2_IMAGE_LEASE_SIGNAL_HANDLER=_image_lease_signal
image_lease_context="${FRONTALIERE_R2_IMAGE_LEASE_CONTEXT:-}"
image_lease_owned_here=0
image_lease_acquire_pending=0

_release_image_namespace_lease() {
  [ "${image_lease_owned_here:-0}" -eq 1 ] || return 0
  image_lease_owned_here=0
  if [ "${image_lease_acquire_pending:-0}" -eq 1 ]; then
    if ! node "$image_lease_cli" release --context "$image_lease_context" --fence-missing-candidate true >/dev/null; then
      echo "::error::[cdn-upload] could not reconcile an interrupted $image_namespace lease acquisition" >&2
      return 1
    fi
    return 0
  fi
  if ! node "$image_lease_cli" release --context "$image_lease_context" >/dev/null; then
    echo "::error::[cdn-upload] could not safely release the $image_namespace lease" >&2
    return 1
  fi
  return 0
}
_image_lease_exit_cleanup() {
  local exit_code=$?
  trap '' EXIT INT TERM
  if [ "${_R2_IMAGE_LEASE_RELEASE_ALLOWED:-1}" = 1 ] \
      && ! _r2_image_lease_stop_timeout; then
    _R2_IMAGE_LEASE_RELEASE_ALLOWED=0
    exit_code=1
  fi
  if [ "${_R2_IMAGE_LEASE_RELEASE_ALLOWED:-1}" = 1 ] \
      && ! _release_image_namespace_lease; then
    exit_code=1
  fi
  exit "$exit_code"
}
_image_lease_signal() {
  local exit_status="$1"
  trap '' INT TERM
  if ! _r2_image_lease_stop_timeout; then
    _R2_IMAGE_LEASE_RELEASE_ALLOWED=0
  fi
  exit "$exit_status"
}

trap _image_lease_exit_cleanup EXIT
trap '_image_lease_signal 130' INT
trap '_image_lease_signal 143' TERM

if [ -n "$image_namespace" ]; then
  _R2_IMAGE_LEASE_ACTIVE=1
  if [ ! -f "$image_lease_cli" ]; then
    echo "::warning::[cdn-upload] image lease helper is missing — skipping upload of $cdn_key"
    exit 0
  fi

  if [ -z "$image_lease_context" ]; then
    lease_identity="$(openssl rand -hex 32)" || {
      echo "::warning::[cdn-upload] could not create a recovery identity for the $image_namespace lease — skipping upload of $cdn_key"
      exit 0
    }
    image_lease_owner="${lease_identity:0:32}"
    image_lease_id="${lease_identity:32:32}"
    image_lease_acquired_at="$(date +%s)000" || {
      echo "::warning::[cdn-upload] could not create a recovery timestamp for the ${image_namespace} lease — skipping upload of ${cdn_key}"
      exit 0
    }
    image_lease_context="$(printf '{\"version\":1,\"leases\":[{\"namespace\":\"%s\",\"owner\":\"%s\",\"leaseId\":\"%s\",\"acquiredAt\":%s,\"expiresAt\":0}]}' \
      "$image_namespace" "$image_lease_owner" "$image_lease_id" "$image_lease_acquired_at")"
    image_lease_owned_here=1
    image_lease_acquire_pending=1
    acquired_context=""
    if acquired_context="$(
      FRONTALIERE_R2_IMAGE_LEASE_OWNER="$image_lease_owner" \
      FRONTALIERE_R2_IMAGE_LEASE_ID="$image_lease_id" \
      FRONTALIERE_R2_IMAGE_LEASE_ACQUIRED_AT="$image_lease_acquired_at" \
        node "$image_lease_cli" acquire --namespace "$image_namespace"
    )"; then
      :
    else
      # The CLI reconciles an ambiguous PUT itself. A normal acquisition
      # failure has no lease to clean up. Keep the candidate armed so EXIT can
      # retry cleanup if the CLI's reconciliation failed or was interrupted.
      echo "::warning::[cdn-upload] could not acquire $image_namespace lease — skipping upload of $cdn_key"
      exit 0
    fi
    if [ -z "$acquired_context" ]; then
      echo "::warning::[cdn-upload] image lease acquisition returned no context — skipping upload of $cdn_key"
      exit 0
    fi
    image_lease_context="$acquired_context"
    image_lease_acquire_pending=0
    export FRONTALIERE_R2_IMAGE_LEASE_CONTEXT="$image_lease_context"
  fi
fi

if [ -n "$image_namespace" ]; then
  if ! node "$image_lease_cli" verify --namespace "$image_namespace" --context "$image_lease_context" >/dev/null; then
    echo "::warning::[cdn-upload] image lease is no longer valid — skipping upload of $cdn_key"
    exit 0
  fi
fi

# One retry on transient network blips (same rationale as the curl --retry
# above the rclone-install block, and _publish_cdn_r2's own comment on
# run-28599750786): a single-shot upload with no fallback previously failed
# the whole deploy prep step on a bare connection reset even though nothing
# else was wrong. Still never fatal — see header "Failure posture".
attempt_ok=0
for try in 1 2; do
  _r2_image_lease_wait_timeout timeout -k 10 "$r2_timeout_object_s" "${RC[@]}" copyto "$local_file" "$bkt/$cdn_key" \
    --header-upload "Content-Type: $content_type" \
    --header-upload "Cache-Control: $cache_control" \
    --stats=0
  if [ "$?" -eq 0 ]; then
    attempt_ok=1
    break
  fi
  if [ "$try" -lt 2 ]; then
    echo "::warning::[cdn-upload] upload attempt $try/2 failed for $cdn_key — retrying in 3s"
    _r2_image_lease_wait_timeout timeout -k 1 3 sleep 3
  fi
done

if [ "$attempt_ok" = 1 ]; then
  echo "✅ uploaded $local_file -> $bkt/$cdn_key (Content-Type: $content_type)"
else
  echo "::warning::[cdn-upload] upload failed for $cdn_key after 2 attempts — non-fatal (client-side fallback covers this)"
fi
exit 0

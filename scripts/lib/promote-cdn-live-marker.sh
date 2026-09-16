#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Promote the CDN live marker only after the corresponding Pages build is live.
#
# The build job publishes a separate readiness marker before the parallel locale
# shards. That marker is intentionally allowed to move before the Pages artifact
# is complete. This script owns the other marker: it runs after validate-live,
# verifies the apex serves the exact build (or a newer build), and then updates
# the CDN marker without clobbering a concurrent CDN publish.
#
# Usage:
#   promote-cdn-live-marker.sh <path-to-build-id.txt>
#
# CDN_TARGET:
#   r2    — upload the live marker to R2
#   pages — commit the live marker to frontaliere-cdn
#   both  — update Pages first, then R2 (the documented live path during the
#           dual-publish cutover is Pages)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
source "$SCRIPT_DIR/cdn-marker-paths.env"
source "$SCRIPT_DIR/shard-git-helpers.sh"

if [ "$#" -ne 1 ]; then
  echo "Usage: promote-cdn-live-marker.sh <path-to-build-id.txt>" >&2
  exit 1
fi

build_id_file="$1"
if [ ! -f "$build_id_file" ]; then
  echo "::error::[cdn-live-marker] build id file not found: $build_id_file" >&2
  exit 1
fi

expected="$(tr -d '[:space:]' < "$build_id_file" 2>/dev/null || true)"
if [[ ! "$expected" =~ ^[0-9]{10,20}$ ]]; then
  echo "::error::[cdn-live-marker] invalid build id in $build_id_file" >&2
  exit 1
fi

# validate-live accepts a newer build because another queued publish may have
# superseded this one. Never move the CDN marker backwards in that case.
site_url="${SITE_BUILD_ID_URL:-https://frontaliereticino.ch/build-id.txt}"
site_request_url="$site_url"
case "$site_url" in
  file://*) ;;
  *\?*) site_request_url="${site_url}&cdn_marker_promotion=${expected}" ;;
  *) site_request_url="${site_url}?cdn_marker_promotion=${expected}" ;;
esac
site_id="$(curl -fsSL --retry 2 --max-time 30 "$site_request_url" 2>/dev/null | tr -d '[:space:]' || true)"

if [ "$site_id" != "$expected" ]; then
  if [[ "$site_id" =~ ^[0-9]{10,20}$ ]] && [ "$site_id" -gt "$expected" ]; then
    echo "[cdn-live-marker] site already serves newer build $site_id; leaving marker promotion to that build"
    exit 0
  fi
  echo "::error::[cdn-live-marker] refusing promotion: site serves '${site_id:-<unreadable>}' but expected $expected" >&2
  exit 1
fi

target="${CDN_TARGET:-pages}"
case "$target" in
  r2|pages|both) ;;
  *)
    echo "::error::[cdn-live-marker] unsupported CDN_TARGET=$target" >&2
    exit 1
    ;;
esac

work_root="${RUNNER_TEMP:-/tmp}"
mkdir -p "$work_root"
work_dir="$(mktemp -d "$work_root/cdn-live-marker.XXXXXX")" || {
  echo "::error::[cdn-live-marker] could not create a temporary workspace" >&2
  exit 1
}
trap 'rm -rf "$work_dir"' EXIT

marker_file="$work_dir/$CDN_LIVE_BUILD_ID_FILE"
printf '%s\n' "$expected" > "$marker_file"

promote_r2() {
  local output rc=0
  output="$(bash "$SCRIPT_DIR/upload-cdn-file.sh" \
    "$marker_file" "$CDN_LIVE_BUILD_ID_FILE" 'no-store, max-age=0' 2>&1)" || rc=$?
  printf '%s\n' "$output"
  if [ "$rc" -ne 0 ] || ! grep -q '^✅ uploaded ' <<< "$output"; then
    echo "::error::[cdn-live-marker] R2 live-marker upload did not complete" >&2
    return 1
  fi
  echo "✅ [cdn-live-marker] promoted $CDN_LIVE_BUILD_ID_FILE=$expected on R2"
}

CDN_REPO_HTTPS="$(shard_https_push_url "$CDN_REPO_SSH")"

clone_cdn_repo() {
  local repo_dir="$1" key_file token
  key_file="$work_dir/cdn-deploy-key"
  if [ -n "${CDN_DEPLOY_KEY:-}" ]; then
    printf '%s\n' "$CDN_DEPLOY_KEY" > "$key_file"
    chmod 600 "$key_file"
    export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes"
    if git clone --depth 1 --filter=blob:none --sparse "$CDN_REPO_SSH" "$repo_dir"; then
      return 0
    fi
    rm -rf "$repo_dir"
    echo "::warning::[cdn-live-marker] CDN deploy-key clone failed — trying the PAT fallback"
  fi

  token="${GITHUB_PAT:-${SHARD_PUSH_PAT:-}}"
  if [ -z "$token" ]; then
    echo "::error::[cdn-live-marker] CDN clone failed and no GITHUB_PAT/SHARD_PUSH_PAT fallback is available" >&2
    return 1
  fi
  echo "::add-mask::$token"
  export SHARD_PUSH_TOKEN="$token"
  if ! git -c credential.helper= -c "credential.helper=$_SHARD_CRED_HELPER" \
      clone --depth 1 --filter=blob:none --sparse "$CDN_REPO_HTTPS" "$repo_dir"; then
    unset SHARD_PUSH_TOKEN
    return 1
  fi
  unset SHARD_PUSH_TOKEN
}

promote_pages() {
  local repo_dir="$work_dir/cdn-repo" cloned_tip
  if ! clone_cdn_repo "$repo_dir"; then
    echo "::error::[cdn-live-marker] could not clone frontaliere-cdn" >&2
    return 1
  fi

  cloned_tip="$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$cloned_tip" ]; then
    echo "::error::[cdn-live-marker] CDN repository has no readable main tip" >&2
    return 1
  fi
  git -C "$repo_dir" sparse-checkout set --no-cone "$CDN_LIVE_BUILD_ID_FILE" 2>/dev/null || true
  printf '%s\n' "$expected" > "$repo_dir/$CDN_LIVE_BUILD_ID_FILE"
  git -C "$repo_dir" config user.email 'valerielinc@gmail.com'
  git -C "$repo_dir" config user.name 'Valerie Linc'
  git -C "$repo_dir" add -- "$CDN_LIVE_BUILD_ID_FILE"
  if git -C "$repo_dir" diff --cached --quiet; then
    echo "[cdn-live-marker] $CDN_LIVE_BUILD_ID_FILE already equals $expected on Pages"
    return 0
  fi
  git -C "$repo_dir" commit -qm "promote CDN live marker $expected" || {
    echo "::error::[cdn-live-marker] could not commit the Pages live marker" >&2
    return 1
  }

  # The shared helper keeps the lease across both credentials and never turns
  # a stale-clone rejection into a blind force-push. This is the same guard the
  # full build-side CDN replacement uses, so the two writers cannot erase one
  # another's live marker.
  if ! shard_push_with_lease "$repo_dir" "$CDN_REPO_SSH" main "$cloned_tip" "CDN live marker"; then
    echo "::error::[cdn-live-marker] Pages live-marker push failed or lost its lease; no stale clone was forced over the CDN" >&2
    return 1
  fi
  echo "✅ [cdn-live-marker] promoted $CDN_LIVE_BUILD_ID_FILE=$expected on Pages"
}

# In the dual-publish mode Pages remains the live custom-domain origin until
# the explicit cutover, so update it first. A failed second leg leaves the live
# origin coherent and the next successful publish retries the R2 copy.
case "$target" in
  pages) promote_pages || exit 1 ;;
  r2) promote_r2 || exit 1 ;;
  both)
    promote_pages || exit 1
    promote_r2 || exit 1
    ;;
esac

echo "✅ [cdn-live-marker] live marker promotion complete for build $expected"

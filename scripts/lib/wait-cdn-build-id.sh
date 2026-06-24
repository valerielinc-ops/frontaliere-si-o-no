#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/wait-cdn-build-id.sh — cross-shard CDN-push ordering guard (#2569)
#
# In the matrix deploy (.github/workflows/deploy.yml, build-locale) the IT shard
# pushes the CDN repo (og + data + assets) via deploy-it-pages-prep.sh while the
# en/de/fr shards push their locale subtrees via push-locale-shard.sh — all on
# SEPARATE parallel matrix runners with NO ordering between them. The non-IT
# shard HTML has its /data + /assets refs rewritten to cdn.frontaliereticino.ch
# (the "Offload shard refs to CDN" step). So if a non-IT shard publishes BEFORE
# the IT CDN push lands THIS build's payload, the live locale references a CDN
# that does not yet hold this build's data/assets → inconsistent (shard ahead of
# CDN) state until the IT leg catches up (or, if IT CDN push fails entirely, the
# IT leg + Pages deploy fail but en/de/fr may have ALREADY gone live).
#
# This guard makes the non-IT shard publish WAIT until the IT CDN push has
# published THIS build's marker. deploy-it-pages-prep.sh stamps DEPLOY_BUILD_ID
# into cdn-build-id.txt inside the SAME force-push as the assets/data, so the
# marker turning equal to the expected id PROVES this build's CDN payload is live
# (atomic: one force-push publishes the whole tree + the marker together).
#
# Usage:
#   wait-cdn-build-id.sh <expected_build_id>
#
# Env (optional, with safe defaults):
#   CDN_BUILD_ID_URL    marker URL (default https://cdn.frontaliereticino.ch/cdn-build-id.txt)
#   CDN_WAIT_TIMEOUT_S  total budget in seconds before giving up (default 600)
#   CDN_WAIT_INTERVAL_S poll interval in seconds (default 15)
#
# Exit codes:
#   0  — the CDN marker matched <expected_build_id> within the timeout, OR the
#        guard is intentionally a NO-OP (empty expected id → e.g. a local run /
#        non-matrix path that never sets DEPLOY_BUILD_ID). Safe to publish.
#   1  — timed out without the CDN reaching this build's id → DO NOT publish the
#        shard (the caller fails the leg so a stale/ahead shard is never shipped).
#
# Deliberately NOT `set -e`: every curl is allowed to fail (CDN not yet updated
# is the EXPECTED transient case during the poll) and is guarded explicitly.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

expected="${1:-}"

# NO-OP guard: no expected id (local run / non-matrix monolith path that does not
# set DEPLOY_BUILD_ID) → nothing to gate on, allow the publish exactly as before.
if [ -z "$expected" ]; then
  echo "[wait-cdn-build-id] no expected build id (DEPLOY_BUILD_ID unset) — skipping gate (no-op)"
  exit 0
fi

url="${CDN_BUILD_ID_URL:-https://cdn.frontaliereticino.ch/cdn-build-id.txt}"
timeout_s="${CDN_WAIT_TIMEOUT_S:-600}"
interval_s="${CDN_WAIT_INTERVAL_S:-15}"
[[ "$timeout_s"  =~ ^[0-9]+$ ]] || timeout_s=600
[[ "$interval_s" =~ ^[0-9]+$ ]] || interval_s=15
[ "$interval_s" -ge 1 ] || interval_s=15

echo "[wait-cdn-build-id] gating shard publish on CDN build id=${expected} (url=${url}, timeout=${timeout_s}s, interval=${interval_s}s)"

elapsed=0
attempt=0
while :; do
  attempt=$((attempt + 1))
  # On R2 the marker is published with `no-store`, but append a unique cache-bust
  # query per poll so the Cloudflare edge can NEVER serve a stale id: R2 is
  # read-after-write strong at origin, and a fresh query key forces an origin
  # fetch. Harmless on Pages (static server ignores the query, Fastly keys on it).
  poll_url="$url"
  if [ "${CDN_TARGET:-pages}" = "r2" ]; then poll_url="${url}?nocache=${attempt}-${elapsed}"; fi
  # `|| true` (and a literal fallback): under a caller's `set -e`/pipefail a
  # curl miss (404 / not-yet-published) must NOT abort — it is the expected
  # transient state we are polling through.
  got="$(curl -fsS "$poll_url" 2>/dev/null || true)"
  got="$(printf '%s' "$got" | tr -d '[:space:]')"
  if [ "$got" = "$expected" ]; then
    echo "[wait-cdn-build-id] ✅ CDN published build id=${expected} after ${elapsed}s (${attempt} polls) — shard publish unblocked"
    exit 0
  fi
  if [ "$elapsed" -ge "$timeout_s" ]; then
    echo "::error::[wait-cdn-build-id] timed out after ${elapsed}s waiting for CDN build id=${expected} (last seen='${got}') — NOT publishing this shard ahead of the IT CDN push (#2569 atomicity guard)"
    exit 1
  fi
  echo "[wait-cdn-build-id] CDN id='${got}' != '${expected}' (elapsed ${elapsed}s/${timeout_s}s) — retrying in ${interval_s}s"
  sleep "$interval_s"
  elapsed=$((elapsed + interval_s))
done

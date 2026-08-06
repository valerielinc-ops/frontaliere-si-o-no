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
#   CDN_WAIT_MARGIN_WARN_S  near-miss threshold in seconds (default 300). A
#                       MATCH with less than this much budget left still exits 0
#                       — but says so loudly. See "NEAR MISS" below.
#
# Exit codes:
#   0  — the CDN marker matched <expected_build_id> within the timeout, OR the
#        guard is intentionally a NO-OP (empty expected id → e.g. a local run /
#        non-matrix path that never sets DEPLOY_BUILD_ID). Safe to publish.
#   1  — timed out without the CDN reaching this build's id → DO NOT publish the
#        shard (the caller fails the leg so a stale/ahead shard is never shipped).
#
# NEAR MISS (why exit 0 is not enough on its own). This gate has exactly two
# reported states — matched or timed out — and they sit one poll apart. On run
# 31076991699 the de leg matched after 2714s of a 2700s budget: the LAST of its
# 181 polls. That run is recorded as a success and is indistinguishable, from
# the outside, from a run that matched in 20s. One deploy later (31062047677)
# the same structure timed all three non-IT legs out. So a match that lands
# inside CDN_WAIT_MARGIN_WARN_S of the budget emits a ::warning:: and a job
# summary row: the erosion becomes visible BEFORE it turns into a stale locale.
#
# MACHINE-READABLE FACTS. Both terminal states append to $GITHUB_OUTPUT
# (cdn_wait_result / cdn_waited_s / cdn_margin_s / cdn_last_seen /
# cdn_expected / cdn_timeout_s) so the caller can name the cause precisely
# instead of guessing between "shard push failed" and "ordering gate timed
# out" — the two were reported identically before, and issues #5224/#5225/#5227
# were filed on 2026-08-06 blaming an expired shard deploy key for what was
# actually a gate timeout caused by the IT build failing.
#
# Deliberately NOT `set -e`: every curl is allowed to fail (CDN not yet updated
# is the EXPECTED transient case during the poll) and is guarded explicitly.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

expected="${1:-}"

# Append `key=value` to $GITHUB_OUTPUT / $GITHUB_STEP_SUMMARY when running under
# Actions; a plain no-op elsewhere (local runs, vitest) so the script stays
# runnable standalone.
emit_output() {
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}
emit_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
}

# NO-OP guard: no expected id (local run / non-matrix monolith path that does not
# set DEPLOY_BUILD_ID) → nothing to gate on, allow the publish exactly as before.
if [ -z "$expected" ]; then
  echo "[wait-cdn-build-id] no expected build id (DEPLOY_BUILD_ID unset) — skipping gate (no-op)"
  emit_output cdn_wait_result noop
  exit 0
fi

url="${CDN_BUILD_ID_URL:-https://cdn.frontaliereticino.ch/cdn-build-id.txt}"
timeout_s="${CDN_WAIT_TIMEOUT_S:-600}"
interval_s="${CDN_WAIT_INTERVAL_S:-15}"
margin_warn_s="${CDN_WAIT_MARGIN_WARN_S:-300}"
[[ "$timeout_s"  =~ ^[0-9]+$ ]] || timeout_s=600
[[ "$interval_s" =~ ^[0-9]+$ ]] || interval_s=15
[[ "$margin_warn_s" =~ ^[0-9]+$ ]] || margin_warn_s=300
[ "$interval_s" -ge 1 ] || interval_s=15

echo "[wait-cdn-build-id] gating shard publish on CDN build id=${expected} (url=${url}, timeout=${timeout_s}s, interval=${interval_s}s, near-miss<${margin_warn_s}s)"

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
  # `got` is REMOTE bytes and is later emitted to $GITHUB_OUTPUT (and from
  # there into an issue body). Whitespace is already gone, which is what keeps
  # the key=value output format intact; clamp the charset + length too so a
  # malformed/hostile marker can never smuggle anything into a consumer.
  # Comparison below is unaffected: DEPLOY_BUILD_ID is digits-only (see the
  # "Mint shared digits-only build id" step in deploy.yml).
  got="$(printf '%s' "$got" | LC_ALL=C tr -cd 'A-Za-z0-9._-' | cut -c1-64)"
  if [ "$got" = "$expected" ]; then
    margin=$((timeout_s - elapsed))
    echo "[wait-cdn-build-id] ✅ CDN published build id=${expected} after ${elapsed}s (${attempt} polls) — shard publish unblocked"
    emit_output cdn_wait_result matched
    emit_output cdn_waited_s "$elapsed"
    emit_output cdn_margin_s "$margin"
    emit_output cdn_expected "$expected"
    emit_output cdn_timeout_s "$timeout_s"
    if [ "$margin" -lt "$margin_warn_s" ]; then
      # Still exit 0 — the shard IS safe to publish. But a match this close to
      # the budget is the state that precedes a timeout, and a bare green step
      # hides it completely (run 31076991699: 0s of margin, reported success).
      emit_output cdn_near_miss "true"
      echo "::warning title=CDN ordering gate near miss::[wait-cdn-build-id] matched with only ${margin}s of the ${timeout_s}s budget left (waited ${elapsed}s). The #2569 gate is one slow IT leg away from timing out and leaving this locale stale — raise CDN_WAIT_TIMEOUT_S or move the IT CDN push earlier."
      emit_summary "⚠️ **#2569 CDN ordering gate — NEAR MISS**: matched after \`${elapsed}s\` with only \`${margin}s\` of the \`${timeout_s}s\` budget left."
    else
      emit_output cdn_near_miss "false"
      emit_summary "✅ #2569 CDN ordering gate: matched after \`${elapsed}s\` (\`${margin}s\` of \`${timeout_s}s\` budget left)."
    fi
    exit 0
  fi
  if [ "$elapsed" -ge "$timeout_s" ]; then
    echo "::error title=CDN ordering gate TIMED OUT::[wait-cdn-build-id] timed out after ${elapsed}s waiting for CDN build id=${expected} (last seen='${got}') — NOT publishing this shard ahead of the IT CDN push (#2569 atomicity guard)"
    emit_output cdn_wait_result timeout
    emit_output cdn_waited_s "$elapsed"
    emit_output cdn_margin_s 0
    emit_output cdn_last_seen "$got"
    emit_output cdn_expected "$expected"
    emit_output cdn_timeout_s "$timeout_s"
    emit_output cdn_near_miss "false"
    emit_summary "🛑 **#2569 CDN ordering gate TIMED OUT** after \`${elapsed}s\` (budget \`${timeout_s}s\`). Expected marker \`${expected}\`, last seen \`${got:-<none>}\`. **This shard was NOT published — the live locale is STALE.**"
    exit 1
  fi
  echo "[wait-cdn-build-id] CDN id='${got}' != '${expected}' (elapsed ${elapsed}s/${timeout_s}s) — retrying in ${interval_s}s"
  sleep "$interval_s"
  elapsed=$((elapsed + interval_s))
done

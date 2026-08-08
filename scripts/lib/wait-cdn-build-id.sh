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
# Env (optional, #5331 early abort — see "WHY AN EARLY ABORT IS SAFE" below):
#   CDN_IT_JOB_NAME     name of the IT matrix job in THIS run (e.g. "build-locale
#                       (it)"). Empty/unset → the abort is disabled entirely and
#                       the gate behaves exactly as it did before.
#   CDN_IT_CHECK_EVERY_N  consult the jobs API once every N polls (default 4, so
#                       ~60s at the default 15s interval). Keeps the API cost at
#                       ~45 calls per leg instead of ~180.
#
# Exit codes:
#   0  — the CDN marker matched <expected_build_id> within the timeout, OR the
#        guard is intentionally a NO-OP (empty expected id → e.g. a local run /
#        non-matrix path that never sets DEPLOY_BUILD_ID). Safe to publish.
#   1  — timed out without the CDN reaching this build's id, OR the IT leg is
#        already over and failed so the marker can never turn (#5331) → DO NOT
#        publish the shard (the caller fails the leg so a stale/ahead shard is
#        never shipped).
#
# WHY AN EARLY ABORT IS SAFE — and where the danger actually is (#5331).
# On run 31202386246 `build-locale (it)` ended in FAILURE at 18:07:04. The fr
# leg's gate had started at 18:04:25 and kept polling until 18:50:17: 43 of its
# 45 minutes were spent waiting for a marker that no longer had anything left to
# write it. The wait was not merely wasted — it also held a 6-hour-timeout
# runner and pushed the whole deploy out by three quarters of an hour.
#
# The tempting-but-WRONG shortcut would be to abort when the IT leg "has not
# been seen yet". That would publish this shard AHEAD of the CDN, which is the
# precise thing the #2569 guard exists to prevent. So the predicate is
# deliberately asymmetric and fail-CLOSED toward waiting:
#
#   abort   ⟸  the API returned a job whose name matches CDN_IT_JOB_NAME AND
#              whose `status` is exactly "completed" AND whose `conclusion` is
#              one of failure / cancelled / timed_out.
#   keep waiting ⟸  EVERYTHING else, with no exceptions: job absent from the
#              response, status queued/in_progress, conclusion null, HTTP error,
#              missing token, `gh` not installed, unparseable body. Every one of
#              those is "not yet seen", and none of them may shorten the wait.
#
# The `it_leg_dead_conclusion` helper below prints the conclusion ONLY in the
# first case and prints nothing in all the others, so the distinction lives in
# one place and an unexpected value can only ever mean "keep waiting".
#
# The marker poll is also, by construction, the LAST word: the API is consulted
# BEFORE the poll in each iteration, so a marker that lands in between still
# matches and the shard still publishes. That closes the one real false-abort
# window — the IT leg pushes the CDN payload early and dies in a LATER step, in
# which case the payload IS live and the shard is safe to publish.
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

# ── #5331 early abort: is the IT leg already over and failed? ────────────────
# Exported (not just set) because the jq filter below reads it via `env` rather
# than interpolating it into the filter text — a job name is workflow-controlled
# input and must never be able to rewrite the query it is matched against.
export WAIT_CDN_IT_JOB="${CDN_IT_JOB_NAME:-}"
it_check_every="${CDN_IT_CHECK_EVERY_N:-4}"
[[ "$it_check_every" =~ ^[0-9]+$ ]] || it_check_every=4
[ "$it_check_every" -ge 1 ] || it_check_every=4

# Every precondition is checked ONCE, up front, and failure means the abort is
# switched off for the whole run — never "retry and maybe abort later". A gate
# that silently keeps its old 2700s behaviour is the safe degradation; a gate
# that aborts on a half-configured environment is not.
it_abort_reason_disabled=""
if [ -z "$WAIT_CDN_IT_JOB" ]; then
  it_abort_reason_disabled="CDN_IT_JOB_NAME unset"
elif ! command -v gh >/dev/null 2>&1; then
  it_abort_reason_disabled="gh CLI not on PATH"
elif [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  it_abort_reason_disabled="no GH_TOKEN/GITHUB_TOKEN (jobs API needs actions:read)"
elif [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GITHUB_RUN_ID:-}" ]; then
  it_abort_reason_disabled="GITHUB_REPOSITORY/GITHUB_RUN_ID unset (not an Actions run)"
fi
if [ -n "$it_abort_reason_disabled" ]; then
  WAIT_CDN_IT_JOB=""
  echo "[wait-cdn-build-id] #5331 early abort DISABLED (${it_abort_reason_disabled}) — falling back to the plain ${timeout_s}s budget"
else
  echo "[wait-cdn-build-id] #5331 early abort armed on job '${WAIT_CDN_IT_JOB}' (checked every ${it_check_every} polls)"
fi

# Echoes the IT leg's conclusion ONLY when the jobs API positively reports that
# job as finished-and-not-successful. Prints NOTHING — and never fails the
# caller — in every other case, including transport errors. See the header.
it_leg_dead_conclusion() {
  local out
  # `|| true`: a 403/404/rate-limit/network blip must read as "not yet seen",
  # never as a licence to abort. 2>/dev/null keeps a token-scope warning out of
  # the value itself.
  out="$(gh api \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100&filter=latest" \
      --jq '[ .jobs[]?
              | select(.name == env.WAIT_CDN_IT_JOB)
              | select(.status == "completed")
              | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")
              | .conclusion ] | first // empty' 2>/dev/null || true)"
  # Clamp to the three literals we accept. Anything else — including a partial
  # read or an error string that slipped through — collapses to empty, i.e. to
  # "keep waiting". `skipped` is deliberately NOT in the set: it means the leg
  # never ran, which is the "not yet seen" shape, not the "ran and died" one.
  case "$(printf '%s' "$out" | tr -d '[:space:]')" in
    failure)   printf 'failure' ;;
    cancelled) printf 'cancelled' ;;
    timed_out) printf 'timed_out' ;;
    *)         : ;;
  esac
}

echo "[wait-cdn-build-id] gating shard publish on CDN build id=${expected} (url=${url}, timeout=${timeout_s}s, interval=${interval_s}s, near-miss<${margin_warn_s}s)"

elapsed=0
attempt=0
while :; do
  attempt=$((attempt + 1))
  # #5331: ask the jobs API BEFORE polling the marker, so the marker read below
  # is the last word — if the IT leg pushed the CDN payload and then died in a
  # later step, the payload is live and this shard is still safe to publish.
  # Sampled every Nth poll: the answer only ever flips once, and a ≤60s delay on
  # noticing is nothing against the 2700s it saves.
  it_dead=""
  if [ -n "$WAIT_CDN_IT_JOB" ] && [ $(( (attempt - 1) % it_check_every )) -eq 0 ]; then
    it_dead="$(it_leg_dead_conclusion)"
  fi
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
  # The marker did not match AND the IT leg is positively over-and-failed, so
  # nothing is left in this run that could ever write the marker. Stop now with
  # a cause the triage can act on, instead of burning the rest of the budget and
  # then reporting a bare "timeout" (which is what sent #5224/#5225/#5227 —
  # and the fr leg of run 31202386246 — chasing shard deploy keys).
  # NOTE the posture is unchanged where it matters: we still do NOT publish.
  if [ -n "$it_dead" ]; then
    echo "::error title=CDN ordering gate ABORTED (IT leg ${it_dead})::[wait-cdn-build-id] the IT leg ('${WAIT_CDN_IT_JOB}') of this run finished with conclusion='${it_dead}' and the CDN marker is still '${got}' != '${expected}' — the marker can no longer be written, so this shard is NOT published (#2569 atomicity guard) and the remaining $((timeout_s - elapsed))s of budget are not spent. Fix the IT leg; the ${expected} payload never reached the CDN."
    emit_output cdn_wait_result it_leg_failed
    emit_output cdn_waited_s "$elapsed"
    emit_output cdn_margin_s $((timeout_s - elapsed))
    emit_output cdn_last_seen "$got"
    emit_output cdn_expected "$expected"
    emit_output cdn_timeout_s "$timeout_s"
    emit_output cdn_it_conclusion "$it_dead"
    emit_output cdn_near_miss "false"
    emit_summary "🛑 **#2569 CDN ordering gate ABORTED EARLY (#5331)** after \`${elapsed}s\` of a \`${timeout_s}s\` budget: the IT leg \`${WAIT_CDN_IT_JOB}\` ended \`${it_dead}\`, so CDN build id \`${expected}\` will never be published. Expected \`${expected}\`, last seen \`${got:-<none>}\`. **This shard was NOT published — the live locale is STALE. Look at the IT leg, not at this shard's repo.**"
    exit 1
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

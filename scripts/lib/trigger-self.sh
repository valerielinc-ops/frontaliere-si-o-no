#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/trigger-self.sh — Self-trigger a workflow_dispatch event
#
# Used at the end of a workflow run to chain into the next run, bypassing
# GitHub Actions' unreliable cron scheduler (measured ~34% utilization on
# generate-article.yml's 30-min cron). Concurrency groups already prevent
# overlap, so it's safe to fire-and-forget.
#
# Delegates the actual ref-wait + single-dispatch + output contract to
# scripts/lib/trigger-workflow.sh (issue #4837). This file used to hand-roll a
# byte-for-byte copy of trigger-deploy.sh's curl loop; once
# trigger-deploy.sh became a thin wrapper over the shared engine, keeping a
# third copy here was exactly the drift AGENTS.md Non-Negotiable #6 forbids.
# What legitimately stays here is self-trigger-specific: the pre-dispatch
# DELAY_SECONDS sleep, the SELF_TRIGGER_REASON observability output, and the
# input SHAPE (retry_count / no_changes_streak / section / url).
#
# Required env vars:
#   GITHUB_PAT or GH_TOKEN  — Personal Access Token with workflow scope
#   GITHUB_REPOSITORY       — owner/repo (set automatically in Actions)
#   WORKFLOW_FILE           — workflow filename to dispatch (e.g. generate-article.yml)
# Optional env vars:
#   DELAY_SECONDS           — sleep N seconds before dispatch (default 0)
#   DISPATCH_REF            — branch/tag (default: main)
#   SELF_TRIGGER_REASON     — reason string for observability (e.g. "success",
#                             "no_changes", "rebase_failed", "retry_1_of_3")
#   RETRY_COUNT             — retry counter passed to the dispatched run
#                             (omitted from payload when empty or "0")
#   NO_CHANGES_STREAK       — consecutive no_changes streak passed to the
#                             dispatched run (omitted when empty or "0")
#   SECTION                 — article section for the dispatched run
#                             (frontaliere | svizzera; omitted when empty)
#   URL                     — specific source URL for the dispatched run
#                             (retries a lost article by URL; omitted when empty)
#
# Exit codes:
#   0  — dispatch sent OR skipped (no token) OR API error (best-effort)
#   1  — only when WORKFLOW_FILE is missing (caller misconfiguration)
#
# This script is best-effort: an HTTP failure must NEVER fail the parent
# job. The cron schedule remains the safety-net fallback.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail


write_output() {
  local key="$1"
  local value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

REASON="${SELF_TRIGGER_REASON:-unspecified}"
write_output "self_trigger_reason" "$REASON"

# Validate WORKFLOW_FILE — this is a hard caller-side error
if [ -z "${WORKFLOW_FILE:-}" ]; then
  echo "❌ trigger-self.sh: WORKFLOW_FILE env var is required" >&2
  write_output "dispatch_sent" "false"
  exit 1
fi

# Resolve a token — prefer GITHUB_PAT, fall back to GH_TOKEN
TOKEN="${GITHUB_PAT:-${GH_TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "ℹ️ trigger-self.sh: no GITHUB_PAT or GH_TOKEN — skip self-trigger (cron fallback applies)"
  write_output "dispatch_sent" "false"
  exit 0
fi

REF="${DISPATCH_REF:-main}"
DELAY="${DELAY_SECONDS:-0}"
RETRY_COUNT="${RETRY_COUNT:-}"
NO_CHANGES_STREAK="${NO_CHANGES_STREAK:-}"
SECTION="${SECTION:-}"
URL="${URL:-}"

# Optional pre-dispatch sleep (lets the runner unwind, gives the queue room)
if [ -n "$DELAY" ] && [ "$DELAY" != "0" ]; then
  echo "⏳ trigger-self.sh: sleeping ${DELAY}s before dispatch (reason=${REASON})..."
  sleep "$DELAY"
fi

echo "🔁 trigger-self.sh: dispatching ${WORKFLOW_FILE} on ${REF} (reason=${REASON}, retry_count=${RETRY_COUNT:-0}, no_changes_streak=${NO_CHANGES_STREAK:-0}, section=${SECTION:-default}, url=${URL:-none})"

INPUTS_JSON="$(
  RETRY_COUNT_JSON="$RETRY_COUNT" \
  NO_CHANGES_STREAK_JSON="$NO_CHANGES_STREAK" \
  SECTION_JSON="$SECTION" \
  URL_JSON="$URL" \
  node <<'NODE'
const trim = (v) => String(v || '').trim();
const retry = trim(process.env.RETRY_COUNT_JSON);
const streak = trim(process.env.NO_CHANGES_STREAK_JSON);
const section = trim(process.env.SECTION_JSON);
const url = trim(process.env.URL_JSON);
const inputs = {};
if (retry && retry !== '0') inputs.retry_count = retry;
if (streak && streak !== '0') inputs.no_changes_streak = streak;
if (section) inputs.section = section;
if (url) inputs.url = url;
process.stdout.write(JSON.stringify(inputs));
NODE
)"

# Best-effort by contract: a dispatch failure must NEVER fail the parent job
# (the cron schedule is the safety net), so the engine's exit 1 is swallowed
# here. The engine already wrote dispatch_sent=true|false to GITHUB_OUTPUT.
if TRIGGER_REF="$REF" \
   bash "$(dirname "${BASH_SOURCE[0]}")/trigger-workflow.sh" "$WORKFLOW_FILE" "$INPUTS_JSON"; then
  echo "✅ trigger-self.sh: ${WORKFLOW_FILE} dispatched (reason=${REASON})"
else
  echo "⚠️ trigger-self.sh: dispatch of ${WORKFLOW_FILE} failed — best-effort, not failing parent job (reason=${REASON})"
fi
exit 0

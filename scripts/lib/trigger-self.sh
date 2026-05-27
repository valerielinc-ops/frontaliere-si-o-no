#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/trigger-self.sh — Self-trigger a workflow_dispatch event
#
# Used at the end of a workflow run to chain into the next run, bypassing
# GitHub Actions' unreliable cron scheduler (measured ~34% utilization on
# generate-article.yml's 30-min cron). Concurrency groups already prevent
# overlap, so it's safe to fire-and-forget.
#
# Modeled on scripts/lib/trigger-deploy.sh — same auth + payload + dispatch
# + best-effort error handling pattern.
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

REPO="${GITHUB_REPOSITORY:-valerielinc-ops/frontaliere-si-o-no}"
REF="${DISPATCH_REF:-main}"
DELAY="${DELAY_SECONDS:-0}"
RETRY_COUNT="${RETRY_COUNT:-}"
NO_CHANGES_STREAK="${NO_CHANGES_STREAK:-}"

# Optional pre-dispatch sleep (lets the runner unwind, gives the queue room)
if [ -n "$DELAY" ] && [ "$DELAY" != "0" ]; then
  echo "⏳ trigger-self.sh: sleeping ${DELAY}s before dispatch (reason=${REASON})..."
  sleep "$DELAY"
fi

echo "🔁 trigger-self.sh: dispatching ${WORKFLOW_FILE} on ${REF} (reason=${REASON}, retry_count=${RETRY_COUNT:-0}, no_changes_streak=${NO_CHANGES_STREAK:-0})"

PAYLOAD="$(
  DISPATCH_REF_JSON="$REF" \
  RETRY_COUNT_JSON="$RETRY_COUNT" \
  NO_CHANGES_STREAK_JSON="$NO_CHANGES_STREAK" \
  node <<'NODE'
const trim = (v) => String(v || '').trim();
const payload = { ref: trim(process.env.DISPATCH_REF_JSON) || 'main' };
const retry = trim(process.env.RETRY_COUNT_JSON);
const streak = trim(process.env.NO_CHANGES_STREAK_JSON);
const inputs = {};
if (retry && retry !== '0') inputs.retry_count = retry;
if (streak && streak !== '0') inputs.no_changes_streak = streak;
if (Object.keys(inputs).length > 0) payload.inputs = inputs;
process.stdout.write(JSON.stringify(payload));
NODE
)"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  "https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "$PAYLOAD" || echo "000")

if [ "$HTTP_CODE" = "204" ]; then
  echo "✅ trigger-self.sh: ${WORKFLOW_FILE} dispatched successfully (reason=${REASON})"
  write_output "dispatch_sent" "true"
  exit 0
else
  echo "⚠️ trigger-self.sh: dispatch returned HTTP ${HTTP_CODE} (expected 204) — best-effort, not failing parent job"
  write_output "dispatch_sent" "false"
  exit 0
fi

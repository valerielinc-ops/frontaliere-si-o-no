#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/trigger-workflow.sh — Generic workflow_dispatch trigger engine.
#
# Extracted from scripts/lib/trigger-deploy.sh (issue #4837 stream C) so a
# second workflow that needs "wait for a ref to reach a SHA, then
# workflow_dispatch with retry-on-5xx" doesn't hand-roll a second copy of the
# same curl/retry/ref-poll construct (AGENTS.md Non-Negotiable #6 — a
# literal-duplicated retry-loop is exactly what the pre-push
# check-sibling-patterns.mjs hook flags). trigger-deploy.sh is now a thin
# wrapper around this engine — see that file's comment header. Per-workflow
# input SHAPE (which keys go in `inputs`) legitimately differs per caller, so
# that part stays in each caller; only the identical ref-wait +
# dispatch-retry + output-contract machinery lives here.
#
# GITHUB_TOKEN pushes/label-applies do NOT trigger other workflows (GitHub
# anti-recursion rule) — this script uses a PAT to fire workflow_dispatch.
#
# Usage:
#   scripts/lib/trigger-workflow.sh <workflow-file> <inputs-json>
#
#   <workflow-file>  — e.g. "deploy.yml", "fast-publish-article.yml"
#   <inputs-json>    — JSON object of already-filtered (non-empty-only)
#                       workflow_dispatch inputs, e.g. '{"article_id":"abc"}'.
#                       Pass '{}' or omit for no inputs.
#
# Required env vars:
#   GITHUB_PAT or GH_TOKEN  — Personal Access Token with workflow scope
#   GITHUB_REPOSITORY       — owner/repo (set automatically in Actions)
# Optional env vars:
#   TRIGGER_REF                — branch/tag to dispatch (default: main)
#   TRIGGER_EXPECTED_SHA        — wait for TRIGGER_REF to reach this SHA first
#   TRIGGER_REF_WAIT_ATTEMPTS   — max polling attempts (default: 20)
#   TRIGGER_REF_WAIT_SECONDS    — sleep seconds between polls (default: 2)
#   TRIGGER_DISPATCH_ATTEMPTS   — max dispatch retry attempts (default: 3)
#
# Output (GITHUB_OUTPUT):
#   dispatch_sent=true|false
#
# Exit codes:
#   0  — dispatch sent (or skipped when no token available)
#   1  — dispatch failed (non-fatal — caller should use `|| true`)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/github-api-version.sh"

WORKFLOW_FILE="${1:-}"
INPUTS_JSON="${2:-{}}"

if [ -z "$WORKFLOW_FILE" ]; then
  echo "::error::trigger-workflow.sh requires <workflow-file> as \$1" >&2
  exit 1
fi

write_output() {
  local key="$1"
  local value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

# Resolve a token — prefer GITHUB_PAT, fall back to GH_TOKEN
TOKEN="${GITHUB_PAT:-${GH_TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "ℹ️ No GITHUB_PAT or GH_TOKEN — skipping ${WORKFLOW_FILE} trigger (will not fire)"
  write_output "dispatch_sent" "false"
  exit 0
fi

REPO="${GITHUB_REPOSITORY:-valerielinc-ops/frontaliere-si-o-no}"
REF="${TRIGGER_REF:-main}"
EXPECTED_SHA="${TRIGGER_EXPECTED_SHA:-}"
WAIT_ATTEMPTS="${TRIGGER_REF_WAIT_ATTEMPTS:-20}"
WAIT_SECONDS="${TRIGGER_REF_WAIT_SECONDS:-2}"
MAX_DISPATCH_ATTEMPTS="${TRIGGER_DISPATCH_ATTEMPTS:-3}"

read_ref_sha() {
  local ref="$1"
  curl -sS \
    "https://api.github.com/repos/${REPO}/commits/${ref}" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);if(j&&typeof j.sha==="string")process.stdout.write(j.sha);}catch{}});'
}

if [ -n "$EXPECTED_SHA" ]; then
  echo "⏳ Waiting for ${REF} to reach pushed SHA ${EXPECTED_SHA}..."
  REACHED=0
  for attempt in $(seq 1 "$WAIT_ATTEMPTS"); do
    CURRENT_SHA="$(read_ref_sha "$REF" || true)"
    if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" = "$EXPECTED_SHA" ]; then
      echo "✅ ${REF} now points to ${EXPECTED_SHA}"
      REACHED=1
      break
    fi
    if [ -n "$CURRENT_SHA" ]; then
      echo "… ${REF} still at ${CURRENT_SHA} (attempt ${attempt}/${WAIT_ATTEMPTS})"
    else
      echo "… unable to read ${REF} head SHA (attempt ${attempt}/${WAIT_ATTEMPTS})"
    fi
    sleep "$WAIT_SECONDS"
  done
  if [ "$REACHED" != "1" ]; then
    echo "⚠️ ${REF} did not reach ${EXPECTED_SHA} in time — dispatching anyway"
  fi
fi

echo "🚀 Triggering ${WORKFLOW_FILE} via workflow_dispatch (ref=${REF})..."

PAYLOAD="$(
  TRIGGER_REF_JSON="$REF" \
  TRIGGER_INPUTS_JSON="$INPUTS_JSON" \
  node <<'NODE'
const trim = (value) => String(value || '').trim();
const payload = { ref: trim(process.env.TRIGGER_REF_JSON) || 'main' };
let inputs = {};
try {
  const parsed = JSON.parse(process.env.TRIGGER_INPUTS_JSON || '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inputs = parsed;
} catch { /* malformed inputs JSON from caller — dispatch with ref only */ }
if (Object.keys(inputs).length > 0) {
  payload.inputs = inputs;
}
process.stdout.write(JSON.stringify(payload));
NODE
)"

# Retry on transient errors (5xx / connection failure) — GitHub's API dispatch
# endpoint occasionally 502s under load. Auth/permission errors (4xx) are not
# transient and fail immediately without wasting the retry budget.
attempt=1
while true; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    "https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}" \
    -d "$PAYLOAD" || echo "000")

  if [ "$HTTP_CODE" = "204" ]; then
    break
  fi
  if [[ ! "$HTTP_CODE" =~ ^5[0-9][0-9]$ ]] && [ "$HTTP_CODE" != "000" ]; then
    break
  fi
  if [ "$attempt" -ge "$MAX_DISPATCH_ATTEMPTS" ]; then
    break
  fi
  echo "⚠️ ${WORKFLOW_FILE} trigger returned HTTP $HTTP_CODE (attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS}) — retrying..."
  sleep $((attempt * 2))
  attempt=$((attempt + 1))
done

if [ "$HTTP_CODE" = "204" ]; then
  echo "✅ ${WORKFLOW_FILE} triggered successfully"
  write_output "dispatch_sent" "true"
  exit 0
else
  echo "⚠️ ${WORKFLOW_FILE} trigger returned HTTP $HTTP_CODE (expected 204)"
  write_output "dispatch_sent" "false"
  exit 1
fi

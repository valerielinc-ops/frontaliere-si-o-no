#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/trigger-deploy.sh — Trigger the deploy workflow after data push
#
# GITHUB_TOKEN pushes do NOT trigger other workflows (GitHub anti-loop rule).
# This script uses the GitHub API + a PAT to fire a workflow_dispatch event
# on deploy.yml, ensuring the site is rebuilt & redeployed with new data.
#
# Required env vars:
#   GITHUB_PAT or GH_TOKEN  — Personal Access Token with workflow scope
#   GITHUB_REPOSITORY       — owner/repo (set automatically in Actions)
# Optional env vars:
#   DEPLOY_REF              — branch/tag to dispatch (default: main)
#   EXPECTED_SHA            — wait for DEPLOY_REF to reach this SHA before dispatch
#   DEPLOY_REF_WAIT_ATTEMPTS — max polling attempts (default: 20)
#   DEPLOY_REF_WAIT_SECONDS — sleep seconds between polls (default: 2)
#
# Exit codes:
#   0  — dispatch sent (or skipped when no token available)
#   1  — dispatch failed (non-fatal — caller should use `|| true`)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve a token — prefer GITHUB_PAT, fall back to GH_TOKEN
TOKEN="${GITHUB_PAT:-${GH_TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "ℹ️ No GITHUB_PAT or GH_TOKEN — skipping deploy trigger (deploy.yml will not fire)"
  exit 0
fi

REPO="${GITHUB_REPOSITORY:-valerielinc-ops/frontaliere-si-o-no}"
REF="${DEPLOY_REF:-main}"
EXPECTED_SHA="${EXPECTED_SHA:-}"
WAIT_ATTEMPTS="${DEPLOY_REF_WAIT_ATTEMPTS:-20}"
WAIT_SECONDS="${DEPLOY_REF_WAIT_SECONDS:-2}"

read_ref_sha() {
  local ref="$1"
  curl -sS \
    "https://api.github.com/repos/${REPO}/commits/${ref}" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
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

echo "🚀 Triggering deploy workflow via workflow_dispatch..."

PAYLOAD="$(printf '{"ref":"%s"}' "$REF")"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  "https://api.github.com/repos/${REPO}/actions/workflows/deploy.yml/dispatches" \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "$PAYLOAD")

if [ "$HTTP_CODE" = "204" ]; then
  echo "✅ Deploy workflow triggered successfully"
  exit 0
else
  echo "⚠️ Deploy trigger returned HTTP $HTTP_CODE (expected 204)"
  exit 1
fi

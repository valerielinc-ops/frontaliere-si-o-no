#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/trigger-deploy.sh — Trigger the deploy workflow after data push
#
# GITHUB_TOKEN pushes do NOT trigger other workflows (GitHub anti-loop rule).
# This script uses the GitHub API + a PAT to fire a workflow_dispatch event
# on deploy.yml, ensuring the site is rebuilt & redeployed with new data.
#
# Thin wrapper: builds the deploy.yml-specific inputs JSON (article metadata)
# and delegates the ref-wait + single-dispatch engine to
# scripts/lib/trigger-workflow.sh (issue #4837 stream C — extracted so a
# second caller needing the same "wait for SHA, dispatch exactly once"
# machinery, e.g. fast-publish-article.yml, doesn't hand-roll a literal
# duplicate of this file's curl loop; AGENTS.md Non-Negotiable #6).
# All env var names, the `dispatch_sent` output key, and exit codes 0/1 are
# unchanged from before this refactor — existing callers need no changes.
#
# Required env vars:
#   GITHUB_PAT or GH_TOKEN  — Personal Access Token with workflow scope
#   GITHUB_REPOSITORY       — owner/repo (set automatically in Actions)
# Optional env vars:
#   DEPLOY_REF              — branch/tag to dispatch (default: main)
#   EXPECTED_SHA            — wait for DEPLOY_REF to reach this SHA before dispatch
#   DEPLOY_REF_WAIT_ATTEMPTS — max polling attempts (default: 20)
#   DEPLOY_REF_WAIT_SECONDS — sleep seconds between polls (default: 2)
#   DEPLOY_ARTICLE_ID        — optional article id for post-deploy actions
#   DEPLOY_ARTICLE_URL       — optional live article URL for metadata verification
#   DEPLOY_ARTICLE_OG_TITLE  — optional expected OG title for the live page
#   DEPLOY_ARTICLE_OG_DESCRIPTION — optional OG description for Facebook copy
#   DEPLOY_ARTICLE_OG_IMAGE  — optional expected OG image for the live page
#   DEPLOY_ARTICLE_CATEGORY  — optional article category for Facebook hashtags
#
# Exit codes:
#   0  — dispatch sent (or skipped when no token available)
#   1  — dispatch failed (non-fatal — caller should use `|| true`)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"

ARTICLE_ID="${DEPLOY_ARTICLE_ID:-}"
ARTICLE_URL="${DEPLOY_ARTICLE_URL:-}"
ARTICLE_OG_TITLE="${DEPLOY_ARTICLE_OG_TITLE:-}"
ARTICLE_OG_DESCRIPTION="${DEPLOY_ARTICLE_OG_DESCRIPTION:-}"
ARTICLE_OG_IMAGE="${DEPLOY_ARTICLE_OG_IMAGE:-}"
ARTICLE_CATEGORY="${DEPLOY_ARTICLE_CATEGORY:-}"

if [ -n "$ARTICLE_ID" ] || [ -n "$ARTICLE_URL" ] || [ -n "$ARTICLE_OG_TITLE" ] || [ -n "$ARTICLE_OG_DESCRIPTION" ] || [ -n "$ARTICLE_OG_IMAGE" ]; then
  echo "📰 Passing article metadata to deploy workflow for post-deploy live checks"
fi

INPUTS_JSON="$(
  DEPLOY_ARTICLE_ID_JSON="$ARTICLE_ID" \
  DEPLOY_ARTICLE_URL_JSON="$ARTICLE_URL" \
  DEPLOY_ARTICLE_OG_TITLE_JSON="$ARTICLE_OG_TITLE" \
  DEPLOY_ARTICLE_OG_DESCRIPTION_JSON="$ARTICLE_OG_DESCRIPTION" \
  DEPLOY_ARTICLE_OG_IMAGE_JSON="$ARTICLE_OG_IMAGE" \
  DEPLOY_ARTICLE_CATEGORY_JSON="$ARTICLE_CATEGORY" \
  node <<'NODE'
const trim = (value) => String(value || '').trim();
const inputs = {
  article_id: trim(process.env.DEPLOY_ARTICLE_ID_JSON),
  article_url: trim(process.env.DEPLOY_ARTICLE_URL_JSON),
  og_title: trim(process.env.DEPLOY_ARTICLE_OG_TITLE_JSON),
  og_description: trim(process.env.DEPLOY_ARTICLE_OG_DESCRIPTION_JSON),
  og_image: trim(process.env.DEPLOY_ARTICLE_OG_IMAGE_JSON),
  article_category: trim(process.env.DEPLOY_ARTICLE_CATEGORY_JSON),
};
const nonEmptyInputs = Object.fromEntries(
  Object.entries(inputs).filter(([, value]) => value.length > 0),
);
process.stdout.write(JSON.stringify(nonEmptyInputs));
NODE
)"

TRIGGER_REF="${DEPLOY_REF:-main}" \
TRIGGER_EXPECTED_SHA="${EXPECTED_SHA:-}" \
TRIGGER_REF_WAIT_ATTEMPTS="${DEPLOY_REF_WAIT_ATTEMPTS:-20}" \
TRIGGER_REF_WAIT_SECONDS="${DEPLOY_REF_WAIT_SECONDS:-2}" \
  bash "${SCRIPT_DIR}/trigger-workflow.sh" "deploy.yml" "$INPUTS_JSON"

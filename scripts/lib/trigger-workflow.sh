#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/trigger-workflow.sh — Generic workflow_dispatch trigger engine.
#
# Extracted from scripts/lib/trigger-deploy.sh (issue #4837 stream C) so a
# second workflow that needs "wait for a ref to contain a SHA, then dispatch
# exactly once" doesn't hand-roll a second copy of the same HTTP/ref-poll
# construct (AGENTS.md Non-Negotiable #6 — a literal duplicate is what the pre-push
# check-sibling-patterns.mjs hook flags). trigger-deploy.sh is now a thin
# wrapper around this engine — see that file's comment header. Per-workflow
# input SHAPE (which keys go in `inputs`) legitimately differs per caller, so
# that part stays in each caller; only the identical ref-wait +
# dispatch + exact-run validation + output-contract machinery lives here.
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
#   TRIGGER_EXPECTED_SHA        — wait until this SHA is at/behind TRIGGER_REF
#   TRIGGER_REF_WAIT_ATTEMPTS   — max polling attempts (default: 20)
#   TRIGGER_REF_WAIT_SECONDS    — sleep seconds between polls (default: 2)
#   TRIGGER_RUN_LOOKUP_SECONDS  — sleep between exact-run lookups (default: 1)
#
# Output (GITHUB_OUTPUT):
#   dispatch_sent=true|false
#
# Exit codes:
#   0  — dispatch sent (or skipped when no token available)
#   1  — dispatch failed (non-fatal — caller should use `|| true`)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GITHUB_API_VERSION="$(
  node --input-type=module - "$SCRIPT_DIR/../../functions/src/githubApiHeaders.js" <<'NODE'
import { pathToFileURL } from 'node:url';
const modulePath = process.argv[2];
const { GITHUB_WORKFLOW_DISPATCH_API_VERSION } = await import(pathToFileURL(modulePath));
process.stdout.write(GITHUB_WORKFLOW_DISPATCH_API_VERSION);
NODE
)"

WORKFLOW_FILE="${1:-}"
# NOT `${2:-{}}`: in that form bash ends the parameter expansion at the FIRST
# `}`, so the default is `{` and the trailing `}` is appended literally to the
# result — a caller-supplied `{"article_id":"x"}` came out as
# `{"article_id":"x"}}`, which JSON.parse rejects, and the catch below then
# silently dispatched with no inputs at all. Surfaced by
# tests/lib/trigger-self.test.ts (it asserts the payload shape and went red the
# moment trigger-self.sh started routing through this engine); the regression is
# pinned directly by tests/lib/trigger-workflow.test.ts.
INPUTS_JSON="${2:-}"
if [ -z "$INPUTS_JSON" ]; then
  INPUTS_JSON='{}'
fi

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
RUN_LOOKUP_ATTEMPTS=3
RUN_LOOKUP_SECONDS="${TRIGGER_RUN_LOOKUP_SECONDS:-1}"
if [[ ! "$RUN_LOOKUP_SECONDS" =~ ^[0-5]$ ]]; then
  RUN_LOOKUP_SECONDS=1
fi

if [[ ! "$WORKFLOW_FILE" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]]; then
  echo "::error::trigger-workflow.sh received an invalid workflow filename" >&2
  write_output "dispatch_sent" "false"
  exit 1
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || [ -z "$REF" ]; then
  echo "::error::trigger-workflow.sh received an invalid repository or ref" >&2
  write_output "dispatch_sent" "false"
  exit 1
fi
if [ -n "$EXPECTED_SHA" ] && [[ ! "$EXPECTED_SHA" =~ ^[a-f0-9]{40,64}$ ]]; then
  echo "::error::trigger-workflow.sh received an invalid expected SHA" >&2
  write_output "dispatch_sent" "false"
  exit 1
fi

MAX_RESPONSE_BYTES=1048576
# The Compare API's `files[]` array (per-file unified diffs) is not bounded
# by the `?per_page=1` used below to cap `commits[]` — a legitimate
# large diff (e.g. a squash-merge touching thousands of files) can push the
# response past MAX_RESPONSE_BYTES even though commit_is_expected_or_descendant
# only reads status/ahead_by/behind_by/*_commit.sha/url, none of which live in
# `files[]`. Give this endpoint its own, larger bound instead of either
# false-blocking valid ancestry or loosening the tighter bound every other
# endpoint here relies on.
COMPARE_MAX_RESPONSE_BYTES=8388608
TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
TEMP_DIR="$(mktemp -d "${TEMP_ROOT%/}/trigger-workflow.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Headers of the most recent pre-dispatch polling request (read_ref_sha /
# commit_is_expected_or_descendant), overwritten on every call so the wait
# loop below can detect a GitHub secondary rate-limit (403) and honor its
# `Retry-After` instead of treating it like any other transient error.
RESPONSE_HEADERS_FILE="${TEMP_DIR}/response-headers.txt"

body_is_bounded() {
  local file="$1"
  local max="${2:-$MAX_RESPONSE_BYTES}"
  [ -f "$file" ] && [ "$(wc -c < "$file" | tr -d ' ')" -le "$max" ]
}

last_http_status_code() {
  local file="$1"
  [ -f "$file" ] || return 1
  # Header lines are CRLF-terminated; strip the trailing \r so the extracted
  # code compares cleanly against a plain "403" string.
  awk 'toupper($0) ~ /^HTTP\/[0-9.]+ [0-9]+/ {code=$2} END {gsub(/\r/, "", code); if (code != "") print code; else exit 1}' "$file"
}

retry_after_seconds() {
  local file="$1"
  local cap="$2"
  [ -f "$file" ] || return 1
  local value
  value="$(grep -i '^retry-after:' "$file" 2>/dev/null | tail -1 | tr -dc '0-9')"
  [ -n "$value" ] || return 1
  if [ "$value" -gt "$cap" ]; then value="$cap"; fi
  printf '%s' "$value"
}

ENCODED_REF="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$REF")"

read_ref_sha() {
  local ref="$1"
  local response_file="${TEMP_DIR}/ref-response.json"
  local http_code
  rm -f "$RESPONSE_HEADERS_FILE"
  if ! http_code="$(curl --silent --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --max-filesize "$MAX_RESPONSE_BYTES" \
    --output "$response_file" \
    --dump-header "$RESPONSE_HEADERS_FILE" \
    --write-out "%{http_code}" \
    "https://api.github.com/repos/${REPO}/commits/${ref}" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}")"; then
    return 1
  fi
  [ "$http_code" = "200" ] && body_is_bounded "$response_file" || return 1
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value && typeof value.sha === "string" && /^[a-f0-9]{40,64}$/.test(value.sha)) {
        process.stdout.write(value.sha);
      }
    } catch {}
  ' "$response_file"
}

commit_is_expected_or_descendant() {
  local expected_sha="$1"
  local candidate_sha="$2"
  local response_file="${TEMP_DIR}/compare-response.json"
  local http_code

  if [ "$candidate_sha" = "$expected_sha" ]; then
    return 0
  fi
  [[ "$candidate_sha" =~ ^[a-f0-9]{40,64}$ ]] || return 1

  rm -f "$RESPONSE_HEADERS_FILE"
  if ! http_code="$(curl --silent --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --max-filesize "$COMPARE_MAX_RESPONSE_BYTES" \
    --output "$response_file" \
    --dump-header "$RESPONSE_HEADERS_FILE" \
    --write-out "%{http_code}" \
    "https://api.github.com/repos/${REPO}/compare/${expected_sha}...${candidate_sha}?per_page=1" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}")"; then
    return 1
  fi
  [ "$http_code" = "200" ] && body_is_bounded "$response_file" "$COMPARE_MAX_RESPONSE_BYTES" || return 1

  TRIGGER_COMPARE_FILE="$response_file" \
  TRIGGER_COMPARE_BASE="$expected_sha" \
  TRIGGER_COMPARE_HEAD="$candidate_sha" \
  TRIGGER_COMPARE_REPOSITORY="$REPO" \
  node <<'NODE'
const fs = require('node:fs');
try {
  const comparison = JSON.parse(fs.readFileSync(process.env.TRIGGER_COMPARE_FILE, 'utf8'));
  const base = process.env.TRIGGER_COMPARE_BASE;
  const head = process.env.TRIGGER_COMPARE_HEAD;
  const repository = process.env.TRIGGER_COMPARE_REPOSITORY;
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
  const expectedUrl = `https://api.github.com/repos/${encodedRepository}/compare/${base}...${head}`;
  if (comparison?.status !== 'ahead'
      || comparison?.base_commit?.sha !== base
      || comparison?.merge_base_commit?.sha !== base
      || comparison?.url !== expectedUrl
      || !Number.isInteger(comparison?.ahead_by) || comparison.ahead_by < 1
      || comparison?.behind_by !== 0) process.exit(1);
} catch {
  process.exit(1);
}
NODE
}

if [ -n "$EXPECTED_SHA" ]; then
  echo "⏳ Waiting for ${REF} to contain pushed SHA ${EXPECTED_SHA}..."
  REACHED=0
  for attempt in $(seq 1 "$WAIT_ATTEMPTS"); do
    CURRENT_SHA="$(read_ref_sha "$ENCODED_REF" || true)"
    if [ -n "$CURRENT_SHA" ] && commit_is_expected_or_descendant "$EXPECTED_SHA" "$CURRENT_SHA"; then
      if [ "$CURRENT_SHA" = "$EXPECTED_SHA" ]; then
        echo "✅ ${REF} now points to ${EXPECTED_SHA}"
      else
        echo "✅ ${REF} now points to descendant ${CURRENT_SHA} containing ${EXPECTED_SHA}"
      fi
      REACHED=1
      break
    fi
    if [ -n "$CURRENT_SHA" ]; then
      echo "… ${REF} still at ${CURRENT_SHA} (attempt ${attempt}/${WAIT_ATTEMPTS})"
    else
      echo "… unable to read ${REF} head SHA (attempt ${attempt}/${WAIT_ATTEMPTS})"
    fi
    NEXT_SLEEP_SECONDS="$WAIT_SECONDS"
    # A GitHub secondary rate-limit (403) during polling is not a generic
    # error: hammering it at the fixed WAIT_SECONDS cadence just re-triggers
    # it. Honor the server-declared `Retry-After` when present, otherwise
    # back off to at least 5s instead of the (possibly sub-second) default.
    if [ "$(last_http_status_code "$RESPONSE_HEADERS_FILE" 2>/dev/null || true)" = "403" ]; then
      if RETRY_AFTER_VALUE="$(retry_after_seconds "$RESPONSE_HEADERS_FILE" 60 2>/dev/null)"; then
        NEXT_SLEEP_SECONDS="$RETRY_AFTER_VALUE"
        echo "⏸️ secondary rate-limit (403) — honoring Retry-After: ${NEXT_SLEEP_SECONDS}s before next poll"
      else
        NEXT_SLEEP_SECONDS=$(( WAIT_SECONDS > 5 ? WAIT_SECONDS : 5 ))
        echo "⏸️ secondary rate-limit (403) without Retry-After — backing off ${NEXT_SLEEP_SECONDS}s before next poll"
      fi
    fi
    sleep "$NEXT_SLEEP_SECONDS"
  done
  if [ "$REACHED" != "1" ]; then
    echo "❌ ${REF} did not contain ${EXPECTED_SHA} in time — dispatch blocked"
    write_output "dispatch_sent" "false"
    exit 1
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
} catch (err) {
  // Loud, not silent. Swallowing this is what hid the `${2:-{}}` expansion bug:
  // every dispatch quietly lost its inputs while still returning HTTP 204, so
  // the caller saw a "successful" trigger of a run that never got its article
  // id. A caller passing malformed JSON is a bug worth failing on.
  console.error(`[trigger-workflow] malformed inputs JSON: ${err.message}`);
  process.exit(1);
}
if (Object.keys(inputs).length > 0) {
  payload.inputs = inputs;
}
process.stdout.write(JSON.stringify(payload));
NODE
)"

# The pinned GitHub REST workflow_dispatch contract returns the created run
# identity. The POST is sent
# exactly once: a timeout, connection failure, 5xx or legacy 204 is ambiguous
# and must never be followed by another POST. Generic callers do not share a
# globally unique run-name, so there is no safe list-and-guess reconciliation.
DISPATCH_BODY_FILE="${TEMP_DIR}/dispatch-response.json"
if ! HTTP_CODE="$(curl --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --max-filesize "$MAX_RESPONSE_BYTES" \
  --output "$DISPATCH_BODY_FILE" \
  --write-out "%{http_code}" \
  --request POST \
  "https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}" \
  -d "$PAYLOAD")"; then
  HTTP_CODE="000"
fi

if [ "$HTTP_CODE" != "200" ] || ! body_is_bounded "$DISPATCH_BODY_FILE"; then
  echo "⚠️ ${WORKFLOW_FILE} trigger returned an ambiguous or rejected response (HTTP ${HTTP_CODE})"
  write_output "dispatch_sent" "false"
  exit 1
fi

if ! RUN_ID="$(
  TRIGGER_RESPONSE_FILE="$DISPATCH_BODY_FILE" \
  TRIGGER_EXPECTED_REPOSITORY="$REPO" \
  node <<'NODE'
const fs = require('node:fs');
try {
  const body = JSON.parse(fs.readFileSync(process.env.TRIGGER_RESPONSE_FILE, 'utf8'));
  const repository = process.env.TRIGGER_EXPECTED_REPOSITORY;
  const runId = String(body?.workflow_run_id ?? '');
  if (!/^[1-9][0-9]*$/.test(runId) || typeof body?.run_url !== 'string'
      || typeof body?.html_url !== 'string') process.exit(1);
  const apiUrl = new URL(body.run_url);
  const htmlUrl = new URL(body.html_url);
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
  if (apiUrl.origin !== 'https://api.github.com'
      || htmlUrl.origin !== 'https://github.com'
      || apiUrl.pathname !== `/repos/${encodedRepository}/actions/runs/${runId}`
      || htmlUrl.pathname !== `/${encodedRepository}/actions/runs/${runId}`
      || apiUrl.search || apiUrl.hash || htmlUrl.search || htmlUrl.hash) process.exit(1);
  process.stdout.write(runId);
} catch {
  process.exit(1);
}
NODE
)"; then
  echo "⚠️ ${WORKFLOW_FILE} trigger returned an invalid 200 response"
  write_output "dispatch_sent" "false"
  exit 1
fi

RUN_BODY_FILE="${TEMP_DIR}/run-response.json"
RUN_HTTP_CODE="000"
for lookup_attempt in $(seq 1 "$RUN_LOOKUP_ATTEMPTS"); do
  if ! RUN_HTTP_CODE="$(curl --silent --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --max-filesize "$MAX_RESPONSE_BYTES" \
    --output "$RUN_BODY_FILE" \
    --write-out "%{http_code}" \
    "https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}")"; then
    RUN_HTTP_CODE="000"
  fi
  if [ "$RUN_HTTP_CODE" = "200" ]; then
    break
  fi
  if { [ "$RUN_HTTP_CODE" = "000" ] || [ "$RUN_HTTP_CODE" = "404" ] \
      || [ "$RUN_HTTP_CODE" = "429" ] || [[ "$RUN_HTTP_CODE" =~ ^5[0-9][0-9]$ ]]; } \
      && [ "$lookup_attempt" -lt "$RUN_LOOKUP_ATTEMPTS" ]; then
    sleep "$RUN_LOOKUP_SECONDS"
    continue
  fi
  break
done

if [ "$RUN_HTTP_CODE" != "200" ] || ! body_is_bounded "$RUN_BODY_FILE"; then
  echo "⚠️ ${WORKFLOW_FILE} run identity could not be verified (HTTP ${RUN_HTTP_CODE})"
  write_output "dispatch_sent" "false"
  exit 1
fi

if ! RUN_HEAD_SHA="$(
  TRIGGER_RUN_FILE="$RUN_BODY_FILE" \
  TRIGGER_EXPECTED_RUN_ID="$RUN_ID" \
  TRIGGER_EXPECTED_REPOSITORY="$REPO" \
  TRIGGER_EXPECTED_WORKFLOW="$WORKFLOW_FILE" \
  TRIGGER_EXPECTED_REF="$REF" \
  TRIGGER_EXPECTED_HEAD_SHA="$EXPECTED_SHA" \
  node <<'NODE'
const fs = require('node:fs');
try {
  const run = JSON.parse(fs.readFileSync(process.env.TRIGGER_RUN_FILE, 'utf8'));
  const runId = process.env.TRIGGER_EXPECTED_RUN_ID;
  const repository = process.env.TRIGGER_EXPECTED_REPOSITORY;
  const workflow = process.env.TRIGGER_EXPECTED_WORKFLOW;
  const ref = process.env.TRIGGER_EXPECTED_REF;
  const expectedHeadSha = process.env.TRIGGER_EXPECTED_HEAD_SHA;
  const validPath = run?.path === `.github/workflows/${workflow}`;
  const nonterminalStatuses = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
  const validLifecycle = run?.status === 'completed' || nonterminalStatuses.has(run?.status);
  if (String(run?.id ?? '') !== runId
      || run?.repository?.full_name !== repository
      || !validPath
      || run?.event !== 'workflow_dispatch'
      || run?.head_branch !== ref
      || (expectedHeadSha && (typeof run?.head_sha !== 'string'
          || !/^[a-f0-9]{40,64}$/.test(run.head_sha)))
      || !Number.isInteger(run?.run_attempt) || run.run_attempt < 1
      || !validLifecycle) process.exit(1);
  if (expectedHeadSha) process.stdout.write(run.head_sha);
} catch {
  process.exit(1);
}
NODE
)"; then
  echo "⚠️ ${WORKFLOW_FILE} direct run failed exact binding validation"
  write_output "dispatch_sent" "false"
  exit 1
fi

if [ -n "$EXPECTED_SHA" ] \
    && ! commit_is_expected_or_descendant "$EXPECTED_SHA" "$RUN_HEAD_SHA"; then
  echo "⚠️ ${WORKFLOW_FILE} direct run head ${RUN_HEAD_SHA} does not contain ${EXPECTED_SHA}"
  write_output "dispatch_sent" "false"
  exit 1
fi

echo "✅ ${WORKFLOW_FILE} triggered and exact run ${RUN_ID} verified${RUN_HEAD_SHA:+ at ${RUN_HEAD_SHA}}"
write_output "dispatch_sent" "true"
exit 0

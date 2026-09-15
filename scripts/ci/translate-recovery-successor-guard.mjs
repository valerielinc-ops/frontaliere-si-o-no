#!/usr/bin/env node

/**
 * Successor guard for the standalone corpus translate workflow.
 *
 * A GitHub Actions rerun keeps the same run id and advances run_attempt. The
 * recovery planner writes one immutable claim on the corpus main branch before
 * requesting that rerun. Attempt 2 may execute only when the claim is the
 * exact byte-level document for (run id, target commit, target workflow blob).
 * Attempt 3+ is always rejected. Attempt 1 is the normal scheduled/manual
 * execution and does not need a recovery claim.
 *
 * This file is checked out from the site repository because the generated
 * corpus workflow already checks out the site's runtime before doing work.
 * It is dependency-free and performs only GET requests.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAIM_SCHEMA = 'translate-queue-recovery-claim/v1';
export const CLAIM_ROOT = 'data/translation-queue-recovery/claims/v1';
export const TARGET_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
export const TARGET_BRANCH = 'main';
export const TARGET_WORKFLOW_ID = 342441975;
export const TARGET_WORKFLOW_PATH = '.github/workflows/translate-pending.yml';
export const QUEUE_MAX_BOUNDARY_SHA = '5e5114b73f37a0c47625f00baff13942fe8b186b';
export const MAX_CLAIM_BYTES = 4096;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const SHA_RE = /^[a-f0-9]{40}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const REQUEST_TIMEOUT_MS = 10_000;

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_json_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('non_json_value');
  return `{${Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new TypeError('undefined_json_value');
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  }).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function validRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

function validSha(value) {
  return typeof value === 'string' && SHA_RE.test(value);
}

function encodedPath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

export function buildRecoveryClaimTuple({ targetRunId, sourceHeadSha, workflowBlobSha }) {
  if (!validRunId(targetRunId) || !validSha(sourceHeadSha) || !validSha(workflowBlobSha)) {
    throw new TypeError('invalid_recovery_binding');
  }
  return {
    branch: TARGET_BRANCH,
    executionDedupeProtocolVersion: 1,
    maxMutationRequests: 1,
    mutation: 'rerun_same_run',
    queueState: 'empty_at_observation',
    queueMaxBoundarySha: QUEUE_MAX_BOUNDARY_SHA,
    repository: TARGET_REPOSITORY,
    schema: CLAIM_SCHEMA,
    sourceEvent: 'workflow_dispatch',
    sourceHeadSha,
    sourceRunAttempt: 1,
    successorGuardVersion: 1,
    targetExecutionDedupe: 'effectively_once',
    targetRunId,
    workflowBlobSha,
    workflowId: TARGET_WORKFLOW_ID,
    workflowPath: TARGET_WORKFLOW_PATH,
  };
}

export function expectedRecoveryClaim({ targetRunId, sourceHeadSha, workflowBlobSha }) {
  const tuple = buildRecoveryClaimTuple({ targetRunId, sourceHeadSha, workflowBlobSha });
  const claimKey = sha256(Buffer.from(canonicalJson(tuple), 'utf8'));
  const document = { ...tuple, claimKey };
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, 'utf8');
  if (bytes.length > MAX_CLAIM_BYTES) throw new TypeError('claim_too_large');
  return {
    claimKey,
    claimPath: `${CLAIM_ROOT}/${claimKey}.json`,
    document,
    bytes,
    gitBlobSha: gitBlobSha(bytes),
  };
}

function apiBaseUrl(value) {
  const parsed = new URL(String(value || 'https://api.github.com').replace(/\/$/, ''));
  if (parsed.protocol !== 'https:') throw new Error('successor_guard_api_must_use_https');
  return parsed.toString().replace(/\/$/, '');
}

async function readJson(response) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('successor_guard_response_too_large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('successor_guard_response_too_large');
  }
  try { return JSON.parse(text); } catch { throw new Error('successor_guard_invalid_json'); }
}

async function getJson({ apiUrl, token, apiPath, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${apiUrl}${apiPath}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'translate-recovery-successor-guard-v1',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    throw new Error('successor_guard_api_network_error');
  }
  if (response.status === 404) throw new Error('successor_guard_claim_missing');
  if (!response.ok) throw new Error(`successor_guard_http_${response.status}`);
  return readJson(response);
}

function decodeClaimPayload(payload) {
  if (payload?.type !== 'file'
      || payload.encoding !== 'base64'
      || typeof payload.content !== 'string'
      || !Number.isSafeInteger(payload.size)
      || payload.size < 0
      || payload.size > MAX_CLAIM_BYTES
      || typeof payload.sha !== 'string'
      || !SHA_RE.test(payload.sha)) {
    throw new Error('successor_guard_claim_malformed');
  }
  const compact = payload.content.replace(/\s/g, '');
  if (!BASE64_RE.test(compact)) throw new Error('successor_guard_claim_malformed');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length !== payload.size || bytes.length > MAX_CLAIM_BYTES) {
    throw new Error('successor_guard_claim_malformed');
  }
  return bytes;
}

/**
 * Verify the current workflow attempt's immutable successor claim.
 *
 * @returns {Promise<{allowed: boolean, required: boolean, claimKey?: string, claimPath?: string, workflowBlobSha?: string}>}
 */
export async function verifyRecoverySuccessor({
  apiUrl = process.env.GITHUB_API_URL,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  runId = process.env.GITHUB_RUN_ID,
  runAttempt = process.env.GITHUB_RUN_ATTEMPT,
  headSha = process.env.GITHUB_SHA,
  eventName = process.env.GITHUB_EVENT_NAME,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (runAttempt === '1') return { allowed: true, required: false, state: 'normal_execution' };
  if (runAttempt !== '2') throw new Error('successor_guard_attempt_not_authorized');
  if (!validRunId(runId) || !validSha(headSha) || eventName !== 'workflow_dispatch') {
    throw new Error('successor_guard_invalid_runtime_binding');
  }
  if (typeof token !== 'string' || token.length === 0) throw new Error('successor_guard_missing_token');
  if (typeof fetchImpl !== 'function') throw new Error('successor_guard_invalid_fetch');

  const base = apiBaseUrl(apiUrl);
  const workflowPayload = await getJson({
    apiUrl: base,
    token,
    fetchImpl,
    apiPath: `/repos/${TARGET_REPOSITORY}/contents/${encodedPath(TARGET_WORKFLOW_PATH)}?ref=${encodeURIComponent(headSha)}`,
  });
  if (workflowPayload?.type !== 'file' || !validSha(workflowPayload.sha)) {
    throw new Error('successor_guard_workflow_blob_unavailable');
  }

  const expected = expectedRecoveryClaim({
    targetRunId: runId,
    sourceHeadSha: headSha,
    workflowBlobSha: workflowPayload.sha,
  });
  const claimPayload = await getJson({
    apiUrl: base,
    token,
    fetchImpl,
    apiPath: `/repos/${TARGET_REPOSITORY}/contents/${encodedPath(expected.claimPath)}?ref=${TARGET_BRANCH}`,
  });
  if (claimPayload.path !== expected.claimPath) throw new Error('successor_guard_claim_path_mismatch');
  const bytes = decodeClaimPayload(claimPayload);
  if (!bytes.equals(expected.bytes)
      || claimPayload.sha !== expected.gitBlobSha
      || sha256(bytes) !== sha256(expected.bytes)) {
    throw new Error('successor_guard_claim_mismatch');
  }
  return {
    allowed: true,
    required: true,
    state: 'claim_verified',
    claimKey: expected.claimKey,
    claimPath: expected.claimPath,
    workflowBlobSha: workflowPayload.sha,
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  verifyRecoverySuccessor()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(`::error::${error.message}`);
      process.exitCode = 1;
    });
}

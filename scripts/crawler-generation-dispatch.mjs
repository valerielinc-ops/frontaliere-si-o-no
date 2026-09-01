#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { assertSafeRunnerReportOutput } from './lib/crawler-generation-receipt.mjs';
import {
  CALLER_REPOSITORY,
  CRAWLER_GENERATION_DISPATCH_REF_PREFIX,
  CRAWLER_GENERATION_DISPATCH_STATUSES,
  CRAWLER_GENERATION_GITHUB_API_VERSION,
  GROUP_IDS,
  MAX_SENTINEL_BYTES,
  canonicalJson,
  createCrawlerGenerationSentinel,
  crawlerGenerationLegacyWorkflowIdentity,
  crawlerGenerationDispatchRef,
  crawlerGenerationRunName,
  crawlerGenerationSentinelWorkflowIdentity,
  crawlerGenerationWorkflowIdentity,
  digestDocument,
  isCrawlerGenerationToken,
  SITE_REPOSITORY,
  validateCrawlerGenerationSentinel,
  validateCrawlerGenerationWorkflowRun,
} from './lib/crawler-generation-contract.mjs';

export const GITHUB_API_VERSION = CRAWLER_GENERATION_GITHUB_API_VERSION;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OBSERVER_WORKFLOW_FILE = 'crawler-generation-observer-shadow.yml';
const OBSERVER_TARGET = `.github/workflows/${OBSERVER_WORKFLOW_FILE}`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RECONCILIATION_PAGES = 10;
const MAX_RECONCILIATION_ATTEMPTS = 6;
const RECONCILIATION_DELAY_MS = 3_000;
export const DIRECT_RUN_HYDRATION_BACKOFF_MS = Object.freeze([250, 500, 1_000, 2_000, 3_000]);
export const DIRECT_RUN_HYDRATION_TIMEOUT_MS = 10_000;
const PREFLIGHT_READ_ATTEMPTS = 3;
const PREFLIGHT_READ_CONCURRENCY = 4;
const PREFLIGHT_READ_DELAY_MS = 250;
const MAX_PREFLIGHT_READ_DELAY_MS = 5_000;
const LEGACY_DISPATCH_POST_ATTEMPTS = 3;
const LEGACY_DISPATCH_RETRY_DELAY_MS = 2_000;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ACCEPTED_STATUSES = new Set(['direct', 'reconciled_transport_error']);
const DISPATCH_STATUS_SET = new Set(CRAWLER_GENERATION_DISPATCH_STATUSES);
const ORCHESTRATOR_WORKFLOW_PATH = '.github/workflows/orchestrate-crawlers.yml';
const TERMINAL_CONCLUSIONS = new Set([
  'success', 'failure', 'cancelled', 'timed_out', 'action_required',
  'neutral', 'skipped', 'stale', 'startup_failure',
]);
export const CRAWLER_GENERATION_REF_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_CRAWLER_GENERATION_REAPER_CANDIDATES = 4;

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function positiveRunId(value) {
  const normalized = String(value ?? '');
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function dispatchResponseRunId(body, repository) {
  const runId = positiveRunId(body?.workflow_run_id);
  if (runId === null || typeof body?.run_url !== 'string' || typeof body?.html_url !== 'string') return null;
  try {
    const apiUrl = new URL(body.run_url);
    const htmlUrl = new URL(body.html_url);
    const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
    if (apiUrl.protocol !== 'https:' || htmlUrl.protocol !== 'https:'
        || apiUrl.hostname !== 'api.github.com' || htmlUrl.hostname !== 'github.com'
        || apiUrl.pathname !== `/repos/${encodedRepository}/actions/runs/${runId}`
        || htmlUrl.pathname !== `/${encodedRepository}/actions/runs/${runId}`) return null;
    return runId;
  } catch {
    return null;
  }
}

async function boundedResponseBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* preserve the bounded-size error */ }
        throw new Error('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return bytes.toString('utf8');
  }
}

export function createGitHubActionsRequester({ apiUrl, token, fetchImpl = fetch }) {
  if (!/^https?:\/\//.test(apiUrl ?? '') || typeof token !== 'string' || token.length === 0) {
    throw new TypeError('Missing GitHub dispatch API configuration');
  }
  const base = apiUrl.replace(/\/$/, '');
  return async ({
    method,
    path: pathname,
    body,
    apiVersion = GITHUB_API_VERSION,
    timeoutMs = 30_000,
  }) => {
    const controller = new AbortController();
    const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(30_000, Math.ceil(timeoutMs))
      : 30_000;
    const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
    try {
      const response = await fetchImpl(`${base}${pathname}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-github-api-version': apiVersion,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await boundedResponseBody(response),
        retryAfter: response.headers.get('retry-after'),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function getAndValidateRun({
  request,
  repository,
  runId,
  identityForRunId,
  sleep,
  attempts = 3,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await request({
        method: 'GET',
        path: `/repos/${repository}/actions/runs/${runId}`,
        apiVersion: GITHUB_API_VERSION,
      });
    } catch {
      response = null;
    }
    if (response?.status === 200) {
      const validation = validateCrawlerGenerationWorkflowRun(
        response.body,
        identityForRunId(runId),
        repository,
      );
      if (validation.valid) return { status: 'matched', observation: validation.observation };
      if (attempt === attempts) return { status: 'binding_mismatch', observation: null };
    }
    if (attempt < attempts) await sleep(attempt * 250);
  }
  return { status: 'unavailable', observation: null };
}

function missingHydrationValue(value) {
  return value === undefined || value === null || value === '';
}

function retryAfterMilliseconds(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
    ? seconds * 1_000
    : null;
}

/**
 * GitHub can return the authoritative workflow_run_id before the exact run
 * snapshot has hydrated its run-name/path/ref fields. Retry only absent or
 * documented transitional values; a contradictory populated value is an
 * immutable binding mismatch and fails immediately.
 */
function isPartialRunHydration(run, binding, errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((error) => {
    switch (error) {
      case 'run_id_mismatch': return missingHydrationValue(run?.id);
      case 'repository_mismatch': return missingHydrationValue(run?.repository?.full_name);
      case 'workflow_name_mismatch': return missingHydrationValue(run?.name);
      case 'run_name_mismatch':
        return missingHydrationValue(run?.display_title) || run?.display_title === binding?.workflowName;
      case 'workflow_path_mismatch': return missingHydrationValue(run?.path);
      case 'event_mismatch': return missingHydrationValue(run?.event);
      case 'head_branch_mismatch': return missingHydrationValue(run?.head_branch);
      case 'head_sha_mismatch': return missingHydrationValue(run?.head_sha);
      case 'run_attempt_invalid': return missingHydrationValue(run?.run_attempt) || run?.run_attempt === 0;
      case 'run_status_invalid': return missingHydrationValue(run?.status);
      case 'run_conclusion_invalid': return missingHydrationValue(run?.conclusion);
      default: return false;
    }
  });
}

async function getAndValidateAuthoritativeRun({
  request,
  repository,
  runId,
  identityForRunId,
  sleep,
  now,
}) {
  const binding = identityForRunId(runId);
  const deadline = now() + DIRECT_RUN_HYDRATION_TIMEOUT_MS;
  for (let attempt = 0; attempt <= DIRECT_RUN_HYDRATION_BACKOFF_MS.length; attempt += 1) {
    const requestBudgetMs = deadline - now();
    if (requestBudgetMs <= 0) break;
    let response;
    try {
      response = await request({
        method: 'GET',
        path: `/repos/${repository}/actions/runs/${runId}`,
        apiVersion: GITHUB_API_VERSION,
        timeoutMs: requestBudgetMs,
      });
    } catch {
      response = null;
    }
    if (response?.status === 403) return { status: 'unavailable', observation: null };
    if (response?.status === 429) {
      const remainingMs = deadline - now();
      const retryAfterMs = retryAfterMilliseconds(response.retryAfter);
      if (attempt === DIRECT_RUN_HYDRATION_BACKOFF_MS.length
          || retryAfterMs === null || retryAfterMs >= remainingMs) {
        return { status: 'unavailable', observation: null };
      }
      await sleep(retryAfterMs);
      continue;
    }
    if (response?.status === 200) {
      const validation = validateCrawlerGenerationWorkflowRun(response.body, binding, repository);
      if (validation.valid) return { status: 'matched', observation: validation.observation };
      if (!isPartialRunHydration(response.body, binding, validation.errors)) {
        return { status: 'binding_mismatch', observation: null };
      }
    }

    const remainingMs = deadline - now();
    if (attempt === DIRECT_RUN_HYDRATION_BACKOFF_MS.length || remainingMs <= 0) break;
    await sleep(Math.min(DIRECT_RUN_HYDRATION_BACKOFF_MS[attempt], remainingMs));
  }
  return { status: 'unavailable', observation: null };
}

async function reconcileExactRun({ request, repository, runName, identityForRunId, sleep }) {
  for (let attempt = 1; attempt <= MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const matches = new Map();
    let listingFailed = false;
    for (let page = 1; page <= MAX_RECONCILIATION_PAGES; page += 1) {
      let response;
      try {
        response = await request({
          method: 'GET',
          path: `/repos/${repository}/actions/runs?event=workflow_dispatch&per_page=100&page=${page}`,
          apiVersion: GITHUB_API_VERSION,
        });
      } catch {
        listingFailed = true;
        break;
      }
      if (response?.status !== 200 || !Array.isArray(response.body?.workflow_runs)
          || response.body.workflow_runs.length > 100) {
        listingFailed = true;
        break;
      }
      for (const run of response.body.workflow_runs) {
        const runId = positiveRunId(run?.id);
        if (runId !== null && run?.display_title === runName) matches.set(runId, run);
      }
      if (response.body.workflow_runs.length < 100) break;
      if (page === MAX_RECONCILIATION_PAGES) return { status: 'duplicate', runId: null };
    }
    if (!listingFailed && matches.size > 1) return { status: 'duplicate', runId: null };
    if (!listingFailed && matches.size === 1) {
      const runId = [...matches.keys()][0];
      const validation = await getAndValidateRun({
        request, repository, runId, identityForRunId, sleep,
      });
      if (validation.status === 'matched') return { status: 'matched', runId };
      if (validation.status === 'binding_mismatch') return { status: 'binding_mismatch', runId: null };
      // The list endpoint can expose a newly-created run before the exact-ID
      // endpoint propagates it. Keep consuming the bounded outer windows; the
      // ambiguous dispatch is never POSTed again.
    }
    if (attempt < MAX_RECONCILIATION_ATTEMPTS) await sleep(RECONCILIATION_DELAY_MS);
  }
  return { status: 'missing', runId: null };
}

/**
 * Dispatch exactly once when reconciliation is available: ambiguous transport
 * failures are observed by exact generation run-name and are never followed
 * by another POST. When reconciliation is unavailable (legacy mode, weaker
 * run-name uniqueness without a generation token), the POST itself is retried
 * a bounded number of times instead — mirroring the old inline bash's
 * dispatch-and-verify-with-poll so a single transient 5xx/timeout does not
 * permanently drop the group (#6935).
 */
export async function dispatchWorkflowOnce({
  repository,
  workflowFile,
  group = null,
  generationToken,
  corpusCodeCommit = null,
  inputs,
  request,
  allowReconciliation = true,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  identityForRunId = (runId) => (
    group === null
      ? crawlerGenerationSentinelWorkflowIdentity(generationToken, runId, corpusCodeCommit)
      : crawlerGenerationWorkflowIdentity(group, generationToken, runId, corpusCodeCommit)
  ),
}) {
  if (!isCrawlerGenerationToken(generationToken)) throw new TypeError('Invalid generation token');
  const expectedWorkflowFile = group === null
    ? OBSERVER_WORKFLOW_FILE
    : GROUP_IDS.includes(group) ? `crawler-group-${group}.yml` : null;
  if (workflowFile === 'translate-pending.yml' || expectedWorkflowFile === null
      || workflowFile !== expectedWorkflowFile) {
    throw new TypeError('Workflow file is outside the crawler generation dispatch domain');
  }
  const runName = identityForRunId('1').runName;
  const postAttempts = allowReconciliation ? 1 : LEGACY_DISPATCH_POST_ATTEMPTS;
  let response;
  let transportFailed = false;
  for (let attempt = 1; attempt <= postAttempts; attempt += 1) {
    transportFailed = false;
    try {
      response = await request({
        method: 'POST',
        path: `/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
        apiVersion: GITHUB_API_VERSION,
        body: {
          ref: corpusCodeCommit === null ? 'main' : crawlerGenerationDispatchRef(generationToken),
          inputs,
        },
      });
    } catch {
      transportFailed = true;
    }
    if (!Number.isInteger(response?.status)) transportFailed = true;
    const retryablePostFailure = transportFailed || response?.status >= 500 || response?.status === 204;
    if (!retryablePostFailure || attempt === postAttempts) break;
    await sleep(attempt * LEGACY_DISPATCH_RETRY_DELAY_MS);
  }

  if (!transportFailed && response.status === 200) {
    const runId = dispatchResponseRunId(response.body, repository);
    if (runId === null) return { status: 'invalid_200_response', runId: null };
    const validation = await getAndValidateAuthoritativeRun({
      request, repository, runId, identityForRunId, sleep, now,
    });
    if (validation.status === 'matched') return { status: 'direct', runId };
    return {
      status: validation.status === 'binding_mismatch' ? 'binding_mismatch' : 'missing',
      runId: null,
    };
  }

  if (transportFailed || response.status >= 500 || response.status === 204) {
    if (!allowReconciliation) {
      return response?.status === 204
        ? { status: 'api_protocol_mismatch', runId: null }
        : { status: 'missing', runId: null };
    }
    let reconciled;
    try {
      reconciled = await reconcileExactRun({
        request, repository, runName, identityForRunId, sleep,
      });
    } catch {
      reconciled = { status: 'missing', runId: null };
    }
    if (response?.status === 204) {
      return reconciled.status === 'matched'
        ? { status: 'reconciled_protocol_mismatch', runId: reconciled.runId }
        : { status: 'api_protocol_mismatch', runId: null };
    }
    if (reconciled.status === 'matched') {
      return { status: 'reconciled_transport_error', runId: reconciled.runId };
    }
    return reconciled;
  }
  return { status: 'rejected', runId: null };
}

function exactPinnedRef(response, dispatchRef, corpusCodeCommit) {
  return response?.status === 200
    && response.body?.ref === `refs/heads/${dispatchRef}`
    && response.body?.object?.type === 'commit'
    && response.body?.object?.sha === corpusCodeCommit;
}

/** Pin one dedicated branch before the wave so a moving corpus main cannot split the generation. */
export async function ensureCrawlerGenerationDispatchRef({ request, generationToken, corpusCodeCommit }) {
  if (!COMMIT_RE.test(corpusCodeCommit ?? '')) throw new TypeError('Invalid corpus code commit');
  const dispatchRef = crawlerGenerationDispatchRef(generationToken);
  const endpoint = `/repos/${CALLER_REPOSITORY}/git/ref/heads/${dispatchRef}`;
  const current = await request({ method: 'GET', path: endpoint, apiVersion: GITHUB_API_VERSION });
  if (exactPinnedRef(current, dispatchRef, corpusCodeCommit)) return dispatchRef;

  let created = null;
  if (current?.status === 404) {
    created = await request({
      method: 'POST',
      path: `/repos/${CALLER_REPOSITORY}/git/refs`,
      apiVersion: GITHUB_API_VERSION,
      body: { ref: `refs/heads/${dispatchRef}`, sha: corpusCodeCommit },
    });
    if (created?.status === 201) created = { ...created, status: 200 };
    if (!exactPinnedRef(created, dispatchRef, corpusCodeCommit)) {
      created = await request({ method: 'GET', path: endpoint, apiVersion: GITHUB_API_VERSION });
    }
  }
  if (!exactPinnedRef(created, dispatchRef, corpusCodeCommit)) throw new Error('crawler_generation_ref_pin_failed');
  return dispatchRef;
}

function exactObservedRef(response, dispatchRef, corpusCodeCommit) {
  return exactPinnedRef(response, dispatchRef, corpusCodeCommit);
}

/**
 * Workflow dispatch resolves and records the run head SHA before returning an accepted run ID.
 * The generation ref is therefore removable only after every group and sentinel dispatch is accepted.
 */
export async function cleanupCrawlerGenerationDispatchRef({ request, generationToken, corpusCodeCommit }) {
  if (!COMMIT_RE.test(corpusCodeCommit ?? '')) throw new TypeError('Invalid corpus code commit');
  const dispatchRef = crawlerGenerationDispatchRef(generationToken);
  const getPath = `/repos/${CALLER_REPOSITORY}/git/ref/heads/${dispatchRef}`;
  const current = await request({ method: 'GET', path: getPath, apiVersion: GITHUB_API_VERSION });
  if (current?.status === 404) return { status: 'already_missing', dispatchRef };
  if (!exactObservedRef(current, dispatchRef, corpusCodeCommit)) {
    throw new Error('crawler_generation_ref_cleanup_binding_mismatch');
  }
  const deleted = await request({
    method: 'DELETE',
    path: `/repos/${CALLER_REPOSITORY}/git/refs/heads/${dispatchRef}`,
    apiVersion: GITHUB_API_VERSION,
  });
  if (deleted?.status !== 204 && deleted?.status !== 404) {
    throw new Error('crawler_generation_ref_cleanup_failed');
  }
  return { status: deleted.status === 404 ? 'already_missing' : 'deleted', dispatchRef };
}

function parseGenerationRef(value) {
  const match = new RegExp(
    `^refs/heads/${CRAWLER_GENERATION_DISPATCH_REF_PREFIX}([1-9][0-9]*)-([1-9][0-9]*)$`,
  ).exec(value ?? '');
  return match ? { generationToken: `${match[1]}-${match[2]}`, runId: match[1], runAttempt: Number(match[2]) } : null;
}

function exactOrchestratorOwner(run, candidate, now) {
  const pathMatches = run?.path === ORCHESTRATOR_WORKFLOW_PATH
    || (typeof run?.path === 'string' && run.path.startsWith(`${ORCHESTRATOR_WORKFLOW_PATH}@`));
  const updatedAt = Date.parse(run?.updated_at ?? '');
  return String(run?.id ?? '') === candidate.runId
    && run?.repository?.full_name === SITE_REPOSITORY
    && pathMatches
    && run?.run_attempt === candidate.runAttempt
    && run?.status === 'completed'
    && TERMINAL_CONCLUSIONS.has(run?.conclusion)
    && Number.isFinite(updatedAt)
    && now - updatedAt >= CRAWLER_GENERATION_REF_RETENTION_MS;
}

/** Conservatively reap only old, terminal, exactly-owned pins left by cancellation or runner loss. */
export async function reapStaleCrawlerGenerationDispatchRefs({
  request,
  currentGenerationToken,
  now = Date.now(),
}) {
  if (!isCrawlerGenerationToken(currentGenerationToken) || !Number.isFinite(now)) {
    throw new TypeError('Invalid crawler generation reaper input');
  }
  let response;
  try {
    response = await request({
      method: 'GET',
      path: `/repos/${CALLER_REPOSITORY}/git/matching-refs/heads/${CRAWLER_GENERATION_DISPATCH_REF_PREFIX}`,
      apiVersion: GITHUB_API_VERSION,
    });
  } catch {
    return { status: 'list_failed', listed: 0, reaped: 0, preserved: 0, truncated: false };
  }
  if (response?.status !== 200 || !Array.isArray(response.body)) {
    return { status: 'list_failed', listed: 0, reaped: 0, preserved: 0, truncated: false };
  }
  const listed = response.body;
  const seenRefs = new Set();
  let preserved = 0;
  const candidates = [];
  for (const observed of listed) {
    const candidate = parseGenerationRef(observed?.ref);
    if (!candidate || candidate.generationToken === currentGenerationToken
        || observed?.object?.type !== 'commit' || !COMMIT_RE.test(observed?.object?.sha ?? '')
        || seenRefs.has(observed.ref)) {
      preserved += 1;
      continue;
    }
    seenRefs.add(observed.ref);
    candidates.push({ observed, ...candidate });
  }
  candidates.sort((left, right) => {
    const leftRunId = BigInt(left.runId);
    const rightRunId = BigInt(right.runId);
    if (leftRunId !== rightRunId) return leftRunId < rightRunId ? -1 : 1;
    return left.runAttempt - right.runAttempt;
  });
  const truncated = candidates.length > MAX_CRAWLER_GENERATION_REAPER_CANDIDATES;
  preserved += Math.max(0, candidates.length - MAX_CRAWLER_GENERATION_REAPER_CANDIDATES);
  let reaped = 0;
  for (const candidate of candidates.slice(0, MAX_CRAWLER_GENERATION_REAPER_CANDIDATES)) {
    const { observed } = candidate;
    let owner;
    try {
      owner = await request({
        method: 'GET',
        path: `/repos/${SITE_REPOSITORY}/actions/runs/${candidate.runId}`,
        apiVersion: GITHUB_API_VERSION,
      });
    } catch {
      preserved += 1;
      continue;
    }
    if (owner?.status !== 200 || !exactOrchestratorOwner(owner.body, candidate, now)) {
      preserved += 1;
      continue;
    }
    const dispatchRef = crawlerGenerationDispatchRef(candidate.generationToken);
    const getPath = `/repos/${CALLER_REPOSITORY}/git/ref/heads/${dispatchRef}`;
    let current;
    try {
      current = await request({ method: 'GET', path: getPath, apiVersion: GITHUB_API_VERSION });
    } catch {
      preserved += 1;
      continue;
    }
    if (current?.status === 404) {
      reaped += 1;
      continue;
    }
    if (!exactObservedRef(current, dispatchRef, observed.object.sha)) {
      preserved += 1;
      continue;
    }
    let deleted;
    try {
      deleted = await request({
        method: 'DELETE',
        path: `/repos/${CALLER_REPOSITORY}/git/refs/heads/${dispatchRef}`,
        apiVersion: GITHUB_API_VERSION,
      });
    } catch {
      preserved += 1;
      continue;
    }
    if (deleted?.status === 204 || deleted?.status === 404) reaped += 1;
    else preserved += 1;
  }
  return { status: 'ok', listed: listed.length, reaped, preserved, truncated };
}

function legacyCheckpoint({ generationToken, siteCodeCommit, groupRunIds, dispatchDiagnostics }) {
  const payload = {
    schemaVersion: 1,
    generationToken,
    siteCodeCommit,
    corpusCodeCommit: null,
    dispatchMode: 'legacy',
    groupRunIds: Object.fromEntries(GROUP_IDS.map((group) => [group, groupRunIds[group]])),
    dispatchDiagnostics: Object.fromEntries(GROUP_IDS.map((group) => [group, dispatchDiagnostics[group]])),
  };
  return { ...payload, digest: digestDocument(payload) };
}

function buildCheckpoint({
  generationToken,
  siteCodeCommit,
  corpusCodeCommit,
  shadowReady,
  groupRunIds,
  dispatchDiagnostics,
}) {
  return shadowReady
    ? createCrawlerGenerationSentinel({
      generationToken, siteCodeCommit, corpusCodeCommit, groupRunIds, dispatchDiagnostics,
    })
    : legacyCheckpoint({
      generationToken, siteCodeCommit, groupRunIds, dispatchDiagnostics,
    });
}

export async function runCrawlerGenerationDispatchWave({
  generationToken,
  siteCodeCommit,
  corpusCodeCommit = null,
  shadowReady,
  checkpointPath,
  delayMs,
  dispatch,
  onCheckpoint = (/** @type {ReturnType<typeof buildCheckpoint>} */ _checkpoint) => {},
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!isCrawlerGenerationToken(generationToken)
      || !COMMIT_RE.test(siteCodeCommit ?? '')
      || (shadowReady && !COMMIT_RE.test(corpusCodeCommit ?? ''))) {
    throw new TypeError('Invalid crawler generation wave identity');
  }
  const groupRunIds = Object.fromEntries(GROUP_IDS.map((group) => [group, null]));
  const dispatchDiagnostics = Object.fromEntries(GROUP_IDS.map((group) => [
    group, { status: 'missing', runId: null },
  ]));
  const persist = () => {
    const checkpoint = buildCheckpoint({
      generationToken,
      siteCodeCommit,
      corpusCodeCommit,
      shadowReady,
      groupRunIds,
      dispatchDiagnostics,
    });
    writeJsonAtomic(checkpointPath, checkpoint, { compact: true });
    onCheckpoint(checkpoint);
    return checkpoint;
  };
  let checkpoint = persist();
  for (const [index, group] of GROUP_IDS.entries()) {
    let outcome;
    try {
      outcome = await dispatch({
        group,
        workflowFile: `crawler-group-${group}.yml`,
        runName: shadowReady
          ? crawlerGenerationRunName(group, generationToken)
          : `crawler-generation--group-${group}`,
        inputs: shadowReady
          ? {
              skip_ai_translation: '1',
              generation_token: generationToken,
              site_code_commit: siteCodeCommit,
            }
          : { skip_ai_translation: '1' },
      });
    } catch {
      outcome = { status: 'rejected', runId: null };
    }
    if (!DISPATCH_STATUS_SET.has(outcome?.status)
        || (ACCEPTED_STATUSES.has(outcome.status) && positiveRunId(outcome.runId) === null)) {
      outcome = { status: 'rejected', runId: null };
    }
    const accepted = ACCEPTED_STATUSES.has(outcome.status);
    groupRunIds[group] = accepted ? outcome.runId : null;
    dispatchDiagnostics[group] = {
      status: outcome.status,
      runId: outcome.runId,
    };
    checkpoint = persist();
    if (index < GROUP_IDS.length - 1 && delayMs > 0) await sleep(delayMs);
  }
  return checkpoint;
}

export function evaluateCrawlerGenerationPreflight({
  corpusCodeCommit,
  localContract,
  remoteContract,
  localObserver,
  remoteObserver,
  remoteWorkflow,
  remoteArtifacts,
}) {
  const reasons = [];
  if (!COMMIT_RE.test(corpusCodeCommit ?? '')) reasons.push('corpus_commit_invalid');
  try {
    if (canonicalJson(localContract) !== canonicalJson(remoteContract)) reasons.push('contract_mismatch');
  } catch {
    reasons.push('contract_invalid');
  }
  const observers = Array.isArray(localContract?.observers) ? localContract.observers : [];
  const observer = observers.find((entry) => entry?.target === OBSERVER_TARGET);
  const expectedArtifacts = [
    ...GROUP_IDS.map((group) => `crawler-group-${group}.yml`),
    'translate-pending.yml',
  ];
  const actualArtifacts = Array.isArray(localContract?.artifacts)
    ? localContract.artifacts.map((entry) => entry?.file).sort(compareCodePoint)
    : [];
  if (localContract?.schemaVersion !== 1
      || localContract?.groupCount !== GROUP_IDS.length
      || localContract?.artifactCount !== expectedArtifacts.length
      || canonicalJson(actualArtifacts) !== canonicalJson(expectedArtifacts.sort(compareCodePoint))
      || localContract?.observerCount !== observers.length
      || localContract?.crawlerGeneration?.mode !== 'shadow'
      || localContract?.crawlerGeneration?.dispatchesTranslation !== false
      || !observer || observer.source !== 'observers/workflows/crawler-generation-observer-shadow.yml') {
    reasons.push('contract_invalid');
  }
  if (!Buffer.isBuffer(localObserver) || !Buffer.isBuffer(remoteObserver)
      || observer?.sha256 !== sha256(localObserver) || observer?.sha256 !== sha256(remoteObserver)) {
    reasons.push('observer_hash_mismatch');
  }
  if (remoteWorkflow?.state !== 'active' || remoteWorkflow?.path !== OBSERVER_TARGET) {
    reasons.push('observer_workflow_inactive');
  }
  const groupArtifacts = new Map(
    Array.isArray(localContract?.artifacts)
      ? localContract.artifacts.map((entry) => [entry?.file, entry])
      : [],
  );
  for (const group of GROUP_IDS) {
    const file = `crawler-group-${group}.yml`;
    const contractArtifact = groupArtifacts.get(file);
    const bytes = remoteArtifacts?.[file];
    if (!Buffer.isBuffer(bytes)
        || !/^[a-f0-9]{64}$/.test(contractArtifact?.artifactSha256 ?? '')
        || sha256(bytes) !== contractArtifact.artifactSha256) {
      reasons.push('group_artifact_hash_mismatch');
      break;
    }
  }
  return {
    ready: reasons.length === 0,
    dispatchMode: reasons.length === 0 ? 'shadow' : 'legacy',
    corpusCodeCommit: reasons.length === 0 ? corpusCodeCommit : null,
    reasons: [...new Set(reasons)].sort(compareCodePoint),
  };
}

function decodeContentsResponse(response) {
  if (response.status !== 200 || response.body?.encoding !== 'base64'
      || typeof response.body?.content !== 'string') throw new Error('contents_response_invalid');
  return Buffer.from(response.body.content.replace(/\s/g, ''), 'base64');
}

function preflightRetryDelay(response, attempt) {
  const retryAfterSeconds = Number(response?.retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(MAX_PREFLIGHT_READ_DELAY_MS, Math.ceil(retryAfterSeconds * 1_000));
  }
  return Math.min(MAX_PREFLIGHT_READ_DELAY_MS, attempt * PREFLIGHT_READ_DELAY_MS);
}

function isRetryablePreflightResponse(response) {
  return response?.status === 429
    || response?.status >= 500
    || (response?.status === 403 && typeof response.retryAfter === 'string' && response.retryAfter.length > 0);
}

async function requestPreflightRead({ request, input, sleep }) {
  let transportError;
  for (let attempt = 1; attempt <= PREFLIGHT_READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await request(input);
      if (!isRetryablePreflightResponse(response) || attempt === PREFLIGHT_READ_ATTEMPTS) return response;
      await sleep(preflightRetryDelay(response, attempt));
    } catch (error) {
      transportError = error;
      if (attempt === PREFLIGHT_READ_ATTEMPTS) throw transportError;
      await sleep(preflightRetryDelay(null, attempt));
    }
  }
  throw transportError;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export async function runPreflight({ request, contractPath, observerPath, sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) }) {
  const localContract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const localObserver = fs.readFileSync(observerPath);
  const commitResponse = await requestPreflightRead({
    request,
    sleep,
    input: { method: 'GET', path: `/repos/${CALLER_REPOSITORY}/commits/main`, apiVersion: GITHUB_API_VERSION },
  });
  const corpusCodeCommit = commitResponse?.status === 200 && COMMIT_RE.test(commitResponse.body?.sha ?? '')
    ? commitResponse.body.sha
    : null;
  if (corpusCodeCommit === null) throw new Error('corpus_commit_response_invalid');
  const contentRef = encodeURIComponent(corpusCodeCommit);
  const remoteContract = JSON.parse(decodeContentsResponse(await requestPreflightRead({
    request, sleep,
    input: { method: 'GET', path: `/repos/${CALLER_REPOSITORY}/contents/generator/data/crawler-cross-repo-contract.json?ref=${contentRef}`, apiVersion: GITHUB_API_VERSION },
  })).toString('utf8'));
  const remoteObserver = decodeContentsResponse(await requestPreflightRead({
    request, sleep,
    input: { method: 'GET', path: `/repos/${CALLER_REPOSITORY}/contents/${OBSERVER_TARGET}?ref=${contentRef}`, apiVersion: GITHUB_API_VERSION },
  }));
  const remoteArtifacts = Object.fromEntries(await mapWithConcurrency(GROUP_IDS, PREFLIGHT_READ_CONCURRENCY, async (group) => {
    const file = `crawler-group-${group}.yml`;
    return [file, decodeContentsResponse(await requestPreflightRead({
      request, sleep,
      input: { method: 'GET', path: `/repos/${CALLER_REPOSITORY}/contents/.github/workflows/${file}?ref=${contentRef}`, apiVersion: GITHUB_API_VERSION },
    }))];
  }));
  const workflow = await requestPreflightRead({
    request, sleep,
    input: { method: 'GET', path: `/repos/${CALLER_REPOSITORY}/actions/workflows/${OBSERVER_WORKFLOW_FILE}`, apiVersion: GITHUB_API_VERSION },
  });
  if (workflow.status !== 200) throw new Error('workflow_response_invalid');
  return evaluateCrawlerGenerationPreflight({
    corpusCodeCommit,
    localContract,
    remoteContract,
    localObserver,
    remoteObserver,
    remoteArtifacts,
    remoteWorkflow: workflow.body,
  });
}

function parseArguments(argv) {
  const mode = argv[0];
  if (!['preflight', 'dispatch-groups', 'dispatch-sentinel', 'cleanup-ref'].includes(mode)) {
    throw new TypeError('Invalid crawler generation dispatch mode');
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/.test(flag ?? '') || typeof value !== 'string' || value.length === 0 || flag in values) {
      throw new TypeError('Invalid crawler generation dispatch arguments');
    }
    values[flag] = value;
  }
  const requiredByMode = {
    preflight: ['--contract', '--observer'],
    'dispatch-groups': [
      '--generation-token', '--site-code-commit', '--corpus-code-commit', '--shadow-ready', '--delay-seconds',
      '--failure-tolerance', '--dry-run', '--repository', '--runner-temp', '--checkpoint',
    ],
    'dispatch-sentinel': ['--generation-token', '--repository', '--runner-temp', '--checkpoint'],
    'cleanup-ref': ['--generation-token', '--corpus-code-commit'],
  };
  const required = requiredByMode[mode];
  if (Object.keys(values).some((flag) => !required.includes(flag))
      || required.some((flag) => !(flag in values))) {
    throw new TypeError('Crawler generation dispatch arguments do not match the selected mode');
  }
  return { mode, values };
}

function safeCheckpoint(values) {
  const repository = path.resolve(values['--repository']);
  const runnerTemp = fs.realpathSync(values['--runner-temp']);
  return assertSafeRunnerReportOutput(
    repository,
    runnerTemp,
    path.resolve(values['--checkpoint']),
    'crawler-generation-dispatch',
  );
}

export async function runCrawlerGenerationDispatchCli(argv = process.argv.slice(2), env = process.env) {
  const { mode, values } = parseArguments(argv);
  if (mode === 'preflight') {
    let result;
    try {
      const request = createGitHubActionsRequester({
        apiUrl: env.GITHUB_API_URL,
        token: env.GITHUB_PAT_NANAKO,
      });
      result = await runPreflight({
        request,
        contractPath: path.resolve(values['--contract']),
        observerPath: path.resolve(values['--observer']),
      });
    } catch {
      result = {
        ready: false,
        dispatchMode: 'legacy',
        corpusCodeCommit: null,
        reasons: ['preflight_infrastructure_error'],
      };
    }
    if (env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        env.GITHUB_OUTPUT,
        `ready=${result.ready}\ndispatch_mode=${result.dispatchMode}\ncorpus_commit=${result.corpusCodeCommit ?? ''}\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  const generationToken = values['--generation-token'];
  let request;
  try {
    request = createGitHubActionsRequester({
      apiUrl: env.GITHUB_API_URL,
      token: env.GITHUB_PAT_NANAKO,
    });
  } catch {
    request = async () => { throw new Error('dispatch_api_unavailable'); };
  }
  if (mode === 'cleanup-ref') {
    const result = await cleanupCrawlerGenerationDispatchRef({
      request,
      generationToken,
      corpusCodeCommit: values['--corpus-code-commit'],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  const checkpointPath = safeCheckpoint(values);
  if (mode === 'dispatch-groups') {
    const dryRun = values['--dry-run'] === 'true';
    const shadowReady = values['--shadow-ready'] === 'true';
    if (!['true', 'false'].includes(values['--shadow-ready'])
        || !['true', 'false'].includes(values['--dry-run'])) {
      throw new TypeError('Dispatch booleans must be true or false');
    }
    const delaySeconds = Number(values['--delay-seconds']);
    const failureTolerance = Number(values['--failure-tolerance']);
    if (!Number.isInteger(delaySeconds) || delaySeconds < 10 || delaySeconds > 90) {
      throw new TypeError('Dispatch delay must be an integer from 10 to 90 seconds');
    }
    if (!Number.isInteger(failureTolerance) || failureTolerance < 0 || failureTolerance > GROUP_IDS.length) {
      throw new TypeError('Dispatch failure tolerance is invalid');
    }
    let effectiveShadowReady = shadowReady;
    if (!dryRun && shadowReady) {
      const reaper = await reapStaleCrawlerGenerationDispatchRefs({
        request,
        currentGenerationToken: generationToken,
      }).catch(() => ({ status: 'reaper_failed', listed: 0, reaped: 0, preserved: 0, truncated: false }));
      process.stderr.write(`::notice::crawler generation ref reaper ${JSON.stringify(reaper)}\n`);
      try {
        await ensureCrawlerGenerationDispatchRef({
          request,
          generationToken,
          corpusCodeCommit: values['--corpus-code-commit'],
        });
      } catch {
        effectiveShadowReady = false;
      }
    }
    const result = await runCrawlerGenerationDispatchWave({
      generationToken,
      siteCodeCommit: values['--site-code-commit'],
      corpusCodeCommit: COMMIT_RE.test(values['--corpus-code-commit'])
        ? values['--corpus-code-commit']
        : null,
      shadowReady: effectiveShadowReady,
      checkpointPath,
      delayMs: dryRun ? 0 : delaySeconds * 1000,
      dispatch: dryRun
        ? async () => ({ status: 'missing', runId: null })
        : ({ group, workflowFile, inputs }) => dispatchWorkflowOnce({
          repository: CALLER_REPOSITORY,
          workflowFile,
          group,
          generationToken,
          corpusCodeCommit: effectiveShadowReady ? values['--corpus-code-commit'] : null,
          inputs,
          request,
          allowReconciliation: effectiveShadowReady,
          identityForRunId: effectiveShadowReady
            ? (runId) => crawlerGenerationWorkflowIdentity(
              group, generationToken, runId, values['--corpus-code-commit'],
            )
            : (runId) => crawlerGenerationLegacyWorkflowIdentity(group, runId),
        }),
    });
    const failures = GROUP_IDS.filter((group) => !ACCEPTED_STATUSES.has(result.dispatchDiagnostics[group].status)).length;
    if (env.GITHUB_OUTPUT) {
      fs.appendFileSync(env.GITHUB_OUTPUT, `shadow_ready=${effectiveShadowReady}\n`);
    }
    process.stdout.write(`${JSON.stringify({ mode: result.dispatchMode ?? 'shadow', failures })}\n`);
    if (!dryRun && failures > failureTolerance) process.exitCode = 1;
    return result;
  }

  const sentinel = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  if (!validateCrawlerGenerationSentinel(sentinel).valid
      || sentinel.generationToken !== generationToken
      || Buffer.byteLength(canonicalJson(sentinel)) > MAX_SENTINEL_BYTES) {
    throw new TypeError('Invalid crawler generation sentinel checkpoint');
  }
  const outcome = await dispatchWorkflowOnce({
    repository: CALLER_REPOSITORY,
    workflowFile: OBSERVER_WORKFLOW_FILE,
    generationToken,
    corpusCodeCommit: sentinel.corpusCodeCommit,
    inputs: {
      generation_token: sentinel.generationToken,
      site_code_commit: sentinel.siteCodeCommit,
      registry_json: canonicalJson(sentinel),
    },
    request,
  });
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `accepted=${ACCEPTED_STATUSES.has(outcome.status)}\n`);
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  if (!ACCEPTED_STATUSES.has(outcome.status)) process.exitCode = 1;
  return outcome;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  runCrawlerGenerationDispatchCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}

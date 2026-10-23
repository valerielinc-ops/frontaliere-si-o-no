#!/usr/bin/env node
import { isInvokedDirectly } from './is-invoked-directly.mjs';

// A small, dependency-free lease for the two client article registries.
//
// GitHub Actions concurrency cannot protect only the registry-to-shard window:
// a section-wide group keeps one pending run and cancels the previous pending
// run. That would silently drop articles when a producer dispatches a burst.
// The R2 object itself is the mutex instead. `If-None-Match: *` makes the first
// PutObject win atomically; an expired lease is replaced with `If-Match` so two
// stale-lock takeovers cannot overwrite each other. The caller holds the lease
// from before companion/registry publication through the corresponding shard
// push, then releases it in an always-run workflow step.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
export const ARTICLE_SECTIONS = Object.freeze(['frontaliere', 'svizzera']);
export const LOCK_KEY_PREFIX = 'internal/ci/article-chunk-locks';
export const LOCK_LEASE_MS = 30 * 60 * 1000;
export const LOCK_RENEW_INTERVAL_MS = Math.floor(LOCK_LEASE_MS / 3);
// `acquire` has already established ownership. Waiting for the first
// heartbeat avoids immediately reading and conditionally rewriting the object
// that was just created, while still renewing three times before the lease can
// expire during a long publication.
export const LOCK_RENEW_INITIAL_DELAY_MS = LOCK_RENEW_INTERVAL_MS;
export const LOCK_ACQUIRE_TIMEOUT_MS = 15 * 60 * 1000;
export const LOCK_POLL_MS = 5_000;

function asString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[r2-section-lock] ${name} is required`);
  }
  return value;
}

function positiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[r2-section-lock] ${name} must be a positive duration`);
  }
  return value;
}

function nonNegativeDuration(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[r2-section-lock] ${name} must be a non-negative duration`);
  }
  return value;
}

export function parseSections(value) {
  const raw = asString(value, '--section');
  const requested = [...new Set(raw.split(',').map((section) => section.trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new Error('[r2-section-lock] --section must name at least one section');
  }
  for (const section of requested) {
    if (!ARTICLE_SECTIONS.includes(section)) {
      throw new Error(`[r2-section-lock] unknown section "${section}"`);
    }
  }
  // Multi-section callers acquire in one stable order. That keeps two future
  // multi-section publishers from deadlocking while a single-section fast
  // publisher waits on either lock.
  return ARTICLE_SECTIONS.filter((section) => requested.includes(section));
}

export function lockKey(section) {
  if (!ARTICLE_SECTIONS.includes(section)) {
    throw new Error(`[r2-section-lock] unknown section "${section}"`);
  }
  return `${LOCK_KEY_PREFIX}/${section}.json`;
}

export function isLockPayload(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof value.owner === 'string'
      && value.owner.length > 0
      && ARTICLE_SECTIONS.includes(value.section)
      && Number.isFinite(value.acquiredAt)
      && Number.isFinite(value.expiresAt)
      && value.expiresAt > value.acquiredAt
      && (value.leaseId === undefined
        || (typeof value.leaseId === 'string' && value.leaseId.length > 0)),
  );
}

export function isLockExpired(lock, now = Date.now()) {
  return !isLockPayload(lock) || lock.expiresAt <= now;
}

function encodePathPart(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function objectUrl(endpoint, bucket, key) {
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const encodedKey = key.split('/').map(encodePathPart).join('/');
  const path = `${basePath}/${encodePathPart(bucket)}/${encodedKey}`;
  return new URL(`${endpoint.origin}${path.startsWith('/') ? path : `/${path}`}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function signingKey(secret, dateStamp) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), 'auto'), 's3'), 'aws4_request');
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

function signedHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    entries,
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    names: entries.map(([name]) => name).join(';'),
  };
}

function signRequest({ endpoint, bucket, accessKeyId, secretAccessKey, now, method, key, body, headers = {} }) {
  const url = objectUrl(endpoint, bucket, key);
  const payload = body ?? '';
  const payloadHash = sha256(payload);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const requestHeaders = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...headers,
  };
  const normalized = signedHeaders(requestHeaders);
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${encodePathPart(name)}=${encodePathPart(value)}`)
    .join('&');
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    normalized.canonical,
    normalized.names,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp))
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`)
    .digest('hex');

  return {
    url,
    headers: {
      ...Object.fromEntries(normalized.entries),
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${normalized.names}, Signature=${signature}`,
    },
    body: payload,
  };
}

export function normalizeS3MatchEtag(value) {
  if (typeof value !== 'string') return value;
  const etag = value.trim();
  // If-Match requires strong comparison. Never turn a weak validator into a
  // strong one; callers treat undefined as an unsafe CAS and fail closed.
  return etag.startsWith('W/') ? undefined : etag;
}

function requireStrongEtag(section, etag) {
  if (!etag) {
    throw new Error(`[r2-section-lock] ${section} acquisition could not be confirmed with an ETag`);
  }
  return etag;
}

function readHeader(response, name) {
  return normalizeS3MatchEtag(
    response?.headers?.get?.(name) ?? response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()],
  );
}

async function responseText(response) {
  if (typeof response?.text === 'function') return response.text();
  return '';
}

function r2ResponseError(message, status) {
  const error = new Error(message);
  error.r2Status = status;
  return error;
}

function configFromEnv(env) {
  const endpointValue = asString(env.R2_S3_ENDPOINT, 'R2_S3_ENDPOINT');
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== 'https:') {
    throw new Error('[r2-section-lock] R2_S3_ENDPOINT must use https');
  }
  return {
    endpoint,
    bucket: asString(env.R2_BUCKET, 'R2_BUCKET'),
    accessKeyId: asString(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: asString(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY'),
  };
}

function cancelR2ResponseBody(response) {
  try {
    return Promise.resolve(response?.body?.cancel?.()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function normalizeRequestHeaders(headers) {
  if (headers && typeof headers.entries === 'function') {
    return Object.fromEntries(headers.entries());
  }
  return headers && typeof headers === 'object' ? headers : {};
}

/**
 * Build the signed R2 transport. Keeping the transport injectable makes the
 * lease race testable without ever contacting the production bucket. A
 * caller-supplied deadline is an absolute Unix timestamp in milliseconds and
 * bounds both the request and any response body the caller reads.
 */
export function createR2Request(env = process.env, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const config = configFromEnv(env);
  if (typeof fetchImpl !== 'function') throw new Error('[r2-section-lock] fetch is unavailable');

  return async ({ method, key, body = '', headers = {}, deadline }) => {
    const normalizedMethod = asString(method, 'method').toUpperCase();
    const normalizedHeaders = normalizeRequestHeaders(headers);
    // Cloudflare can rewrite a strong R2 ETag to a weak validator when the
    // response is compressed. Weak validators are not safe for the If-Match
    // CAS used by the lease protocol, so metadata reads must stay unencoded.
    const requestHeaders = normalizedMethod === 'GET' || normalizedMethod === 'HEAD'
      ? {
        // The identity encoding is part of the CAS safety contract, not a
        // caller preference. Remove every spelling before adding one
        // canonical header so a mixed-case override cannot produce a weak
        // ETag or duplicate signed headers.
        ...Object.fromEntries(
          Object.entries(normalizedHeaders).filter(([name]) => name.toLowerCase() !== 'accept-encoding'),
        ),
        'accept-encoding': 'identity',
      }
      : normalizedHeaders;
    const signed = signRequest({ ...config, now: now(), method: normalizedMethod, key, body, headers: requestHeaders });
    const deadlineAt = deadline === undefined ? Date.now() + 30_000 : deadline;
    if (!Number.isFinite(deadlineAt)) throw new Error('[r2-section-lock] request deadline must be finite');
    const timeoutMs = deadlineAt - Date.now();
    const timeoutError = new Error('[r2-section-lock] R2 request deadline exceeded');
    timeoutError.name = 'TimeoutError';
    timeoutError.code = 'R2_REQUEST_TIMEOUT';
    if (timeoutMs <= 0) throw timeoutError;

    const controller = new AbortController();
    let timedOut = false;
    let timeoutId;
    let receivedResponse;
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        cancelR2ResponseBody(receivedResponse);
        reject(timeoutError);
      }, timeoutMs);
    });
    const responsePromise = Promise.resolve().then(() => fetchImpl(signed.url, {
      method: normalizedMethod,
      headers: signed.headers,
      ...(normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'DELETE' ? {} : { body: signed.body }),
      signal: controller.signal,
    })).then((response) => {
      if (timedOut || Date.now() >= deadlineAt) {
        timedOut = true;
        controller.abort(timeoutError);
        cancelR2ResponseBody(response);
        throw timeoutError;
      }
      receivedResponse = response;
      return response;
    });
    try {
      const response = await Promise.race([responsePromise, timeout]);
      const responseNeedsBody = response?.body
        && ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD')
          ? response.status !== 404
          : !(response.status >= 200 && response.status < 300)
            && response.status !== 409 && response.status !== 412);
      if (responseNeedsBody && typeof response.text === 'function') {
        const readText = response.text.bind(response);
        try {
          Object.defineProperty(response, 'text', {
            configurable: true,
            value: (...args) => {
              if (Date.now() >= deadlineAt) {
                timedOut = true;
                controller.abort(timeoutError);
                cancelR2ResponseBody(response);
                clearTimeout(timeoutId);
                return Promise.reject(timeoutError);
              }
              return Promise.race([
                Promise.resolve().then(() => readText(...args)),
                timeout,
              ]).then((text) => {
                if (Date.now() >= deadlineAt) {
                  timedOut = true;
                  controller.abort(timeoutError);
                  cancelR2ResponseBody(response);
                  throw timeoutError;
                }
                return text;
              }).finally(() => clearTimeout(timeoutId));
            },
          });
        } catch {
          // The deadline timer still aborts/cancels a non-extensible response body.
        }
      } else {
        await Promise.race([cancelR2ResponseBody(response), timeout]);
        if (Date.now() >= deadlineAt) {
          timedOut = true;
          controller.abort(timeoutError);
          cancelR2ResponseBody(response);
          throw timeoutError;
        }
        clearTimeout(timeoutId);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (timedOut) throw timeoutError;
      throw error;
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCurrentLock(request, section) {
  const response = await request({ method: 'GET', key: lockKey(section) });
  if (response.status === 404) return null;
  const body = await responseText(response);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`[r2-section-lock] read ${section} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`[r2-section-lock] lock ${section} is not valid JSON; refusing an unsafe takeover`);
  }
  if (!isLockPayload(payload)) {
    throw new Error(`[r2-section-lock] lock ${section} has an invalid lease; refusing an unsafe takeover`);
  }
  const etag = readHeader(response, 'etag');
  return { payload, etag };
}

async function putLock(request, section, payload, condition) {
  const headers = {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    ...(condition ? { [condition.name]: condition.value } : {}),
  };
  const response = await request({
    method: 'PUT',
    key: lockKey(section),
    body: JSON.stringify(payload),
    headers,
  });
  if (response.status >= 200 && response.status < 300) {
    return { etag: requireStrongEtag(section, readHeader(response, 'etag')) };
  }
  if (response.status === 409 || response.status === 412) return null;
  const body = await responseText(response);
  throw r2ResponseError(`[r2-section-lock] acquire ${section} failed (${response.status}): ${body.slice(0, 300)}`, response.status);
}

function lockMatches(current, payload) {
  return Boolean(
    current
      && current.payload.owner === payload.owner
      && current.payload.section === payload.section
      && current.payload.leaseId === payload.leaseId
      && current.payload.acquiredAt === payload.acquiredAt
      && current.payload.expiresAt === payload.expiresAt,
  );
}

async function acquisitionFailureAfterCleanup(section, payload, request, error) {
  let cleanupError;
  try {
    await releaseSectionLock(section, {
      owner: payload.owner,
      leaseId: payload.leaseId,
      request,
    });
  } catch (caughtCleanupError) {
    cleanupError = caughtCleanupError;
  }
  if (!cleanupError) return error;

  const acquisitionMessage = error instanceof Error ? error.message : String(error);
  const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  return new AggregateError(
    [error, cleanupError],
    `${acquisitionMessage}; candidate cleanup failed: ${cleanupMessage}`,
    { cause: error },
  );
}

async function reconcileAmbiguousLockWrite(request, section, payload, error) {
  let current;
  try {
    current = await readCurrentLock(request, section);
  } catch (reconciliationError) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const reconciliationMessage = reconciliationError instanceof Error
      ? reconciliationError.message
      : String(reconciliationError);
    throw new AggregateError(
      [error, reconciliationError],
      `[r2-section-lock] acquire ${section} failed ambiguously; reconciliation also failed: ${originalMessage}; ${reconciliationMessage}`,
      { cause: error },
    );
  }
  if (lockMatches(current, payload)) {
    if (!current.etag) {
      throw new Error(`[r2-section-lock] ${section} acquisition could not be confirmed with an ETag`);
    }
    return {
      current,
      lock: {
        section,
        owner: payload.owner,
        leaseId: payload.leaseId,
        key: lockKey(section),
        etag: current.etag,
      },
    };
  }
  return { current, lock: null };
}

export async function acquireSectionLock(
  section,
  {
    owner = randomUUID(),
    request = createR2Request(),
    now = Date.now,
    sleep = delay,
    timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS,
    pollMs = LOCK_POLL_MS,
    leaseMs = LOCK_LEASE_MS,
    onWait = () => {},
  } = {},
) {
  lockKey(section);
  positiveDuration(leaseMs, 'lease duration');
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const payload = {
    owner,
    leaseId: randomUUID(),
    section,
    acquiredAt: startedAt,
    expiresAt: startedAt + leaseMs,
  };

  let candidateMayExist = false;
  try {
    while (now() <= deadline) {
      let currentAfterWrite;
      let created;
      try {
        created = await putLock(request, section, payload, { name: 'if-none-match', value: '*' });
      } catch (error) {
        if (error?.r2Status !== undefined && error.r2Status < 500 && error.r2Status !== 408) throw error;
        candidateMayExist = true;
        const reconciled = await reconcileAmbiguousLockWrite(request, section, payload, error);
        if (reconciled.lock) return reconciled.lock;
        currentAfterWrite = reconciled.current;
      }
      if (created) {
        candidateMayExist = true;
        return { section, owner, leaseId: payload.leaseId, key: lockKey(section), etag: created.etag };
      }

      const current = currentAfterWrite === undefined
        ? await readCurrentLock(request, section)
        : currentAfterWrite;
      if (lockMatches(current, payload)) {
        candidateMayExist = true;
        if (!current.etag) {
          throw new Error(`[r2-section-lock] ${section} acquisition could not be confirmed with an ETag`);
        }
        return { section, owner, leaseId: payload.leaseId, key: lockKey(section), etag: current.etag };
      }
      if (!current) {
        await sleep(100);
        continue;
      }
      if (isLockExpired(current.payload, now())) {
        if (!current.etag) {
          throw new Error(`[r2-section-lock] lock ${section} has no ETag; refusing an unsafe takeover`);
        }
        let replacement;
        try {
          replacement = await putLock(request, section, payload, { name: 'if-match', value: current.etag });
        } catch (error) {
          if (error?.r2Status !== undefined && error.r2Status < 500 && error.r2Status !== 408) throw error;
          candidateMayExist = true;
          const reconciled = await reconcileAmbiguousLockWrite(request, section, payload, error);
          if (reconciled.lock) return reconciled.lock;
        }
        if (replacement) {
          candidateMayExist = true;
          return { section, owner, leaseId: payload.leaseId, key: lockKey(section), etag: replacement.etag };
        }
        continue;
      }

      onWait({ section, owner: current.payload.owner, expiresAt: current.payload.expiresAt });
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
    }
    throw new Error(`[r2-section-lock] timed out waiting for section ${section}`);
  } catch (error) {
    if (candidateMayExist) {
      throw await acquisitionFailureAfterCleanup(section, payload, request, error);
    }
    throw error;
  }
}

export async function acquireSectionLocks(sections, options = {}) {
  if (!Array.isArray(sections)) throw new Error('[r2-section-lock] sections must be an array');
  const normalized = parseSections(sections.join(','));
  const acquired = [];
  try {
    for (const section of normalized) {
      acquired.push(await acquireSectionLock(section, options));
    }
    return acquired;
  } catch (error) {
    await releaseSectionLocks(acquired, options).catch(() => {});
    throw error;
  }
}

function leaseIdForSection(section, options = {}) {
  if (options.leaseId !== undefined) return options.leaseId;
  if (options.leaseIds instanceof Map) return options.leaseIds.get(section);
  if (options.leaseIds && typeof options.leaseIds === 'object') return options.leaseIds[section];
  if (Array.isArray(options.locks)) {
    return options.locks.find((lock) => lock?.section === section)?.leaseId;
  }
  return undefined;
}

function leaseForSection(section, options = {}) {
  if (!Array.isArray(options.locks)) return undefined;
  return options.locks.find((lock) => lock?.section === section);
}

/**
 * Extend a lease only if the exact lock read above is still present. A late
 * heartbeat must never revive a lease that another owner already replaced.
 */
export async function renewSectionLock(
  section,
  {
    owner,
    leaseId,
    lock,
    onRenewed = () => {},
    request = createR2Request(),
    now = Date.now,
    leaseMs = LOCK_LEASE_MS,
  } = {},
) {
  asString(owner, 'owner');
  asString(leaseId, 'leaseId');
  positiveDuration(leaseMs, 'lease duration');
  const current = await readCurrentLock(request, section);
  if (!current) {
    console.log(`[r2-section-lock] ${section} disappeared before renewal`);
    return false;
  }
  if (current.payload.owner !== owner || current.payload.leaseId !== leaseId) {
    console.log(`[r2-section-lock] ${section} was replaced before renewal; leaving it intact`);
    return false;
  }
  if (!current.etag) {
    throw new Error(`[r2-section-lock] lock ${section} has no ETag; refusing an unsafe renewal`);
  }

  const renewedAt = now();
  const replacement = await putLock(
    request,
    section,
    { ...current.payload, expiresAt: renewedAt + leaseMs },
    { name: 'if-match', value: current.etag },
  );
  if (!replacement) {
    console.log(`[r2-section-lock] ${section} changed before renewal; leaving it intact`);
    return false;
  }
  if (lock) lock.etag = replacement.etag;
  await onRenewed({ section, owner, leaseId, etag: replacement.etag });
  return true;
}

export async function renewSectionLocks(sections, options = {}) {
  if (!Array.isArray(sections)) throw new Error('[r2-section-lock] sections must be an array');
  const normalized = parseSections(sections.join(','));
  for (const section of normalized) {
    const leaseId = leaseIdForSection(section, options);
    const lock = leaseForSection(section, options);
    if (!(await renewSectionLock(section, { ...options, leaseId, lock }))) return false;
  }
  return true;
}

function waitForStop(ms, stopPromise) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, ms);
    stopPromise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Keep all requested section leases alive until SIGTERM/SIGINT. The workflow
 * runs this as a detached companion and stops it only during final cleanup.
 */
export async function renewSectionLocksUntilStopped(
  sections,
  {
    owner,
    leaseId,
    leaseIds,
    locks,
    onRenewed = () => {},
    request = createR2Request(),
    now = Date.now,
    leaseMs = LOCK_LEASE_MS,
    intervalMs = LOCK_RENEW_INTERVAL_MS,
    initialDelayMs = LOCK_RENEW_INITIAL_DELAY_MS,
    waitForStopImpl = waitForStop,
  } = {},
) {
  asString(owner, 'owner');
  positiveDuration(intervalMs, 'renewal interval');
  nonNegativeDuration(initialDelayMs, 'initial renewal delay');
  const normalized = parseSections(sections.join(','));
  let stopResolve;
  const stopped = new Promise((resolve) => {
    stopResolve = resolve;
  });
  const stop = () => stopResolve();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    if (initialDelayMs > 0 && (await waitForStopImpl(initialDelayMs, stopped))) return;
    if (!(await renewSectionLocks(normalized, {
      owner,
      leaseId,
      leaseIds,
      locks,
      onRenewed,
      request,
      now,
      leaseMs,
    }))) {
      throw new Error('[r2-section-lock] lease ownership was lost before renewal started');
    }
    while (!(await waitForStopImpl(intervalMs, stopped))) {
      if (!(await renewSectionLocks(normalized, {
        owner,
        leaseId,
        leaseIds,
        locks,
        onRenewed,
        request,
        now,
        leaseMs,
      }))) {
        throw new Error('[r2-section-lock] lease ownership was lost during renewal');
      }
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

export async function releaseSectionLock(
  section,
  { owner, leaseId, etag, request = createR2Request() } = {},
) {
  asString(owner, 'owner');
  asString(leaseId, 'leaseId');
  const current = await readCurrentLock(request, section);
  if (!current) return false;
  if (current.payload.owner !== owner || current.payload.leaseId !== leaseId) {
    // An expired lease may already have been taken over. Never delete the new
    // owner's lock from an always-run cleanup step.
    console.log(`[r2-section-lock] ${section} is owned by another run; leaving it intact`);
    return false;
  }
  const matchEtag = current.etag ?? normalizeS3MatchEtag(etag);
  if (!matchEtag) {
    throw new Error(`[r2-section-lock] lock ${section} has no ETag; refusing an unsafe release`);
  }
  const response = await request({
    method: 'DELETE',
    key: lockKey(section),
    headers: { 'if-match': matchEtag },
  });
  if (response.status === 404 || response.status === 409 || response.status === 412) return false;
  if (response.status < 200 || response.status >= 300) {
    const body = await responseText(response);
    throw new Error(`[r2-section-lock] release ${section} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return true;
}

export async function releaseSectionLocks(locks, options = {}) {
  const released = [];
  let firstError;
  for (const lock of [...locks].reverse()) {
    try {
      if (await releaseSectionLock(lock.section, {
        ...options,
        owner: lock.owner,
        leaseId: lock.leaseId,
        etag: lock.etag,
      })) released.push(lock.section);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return released;
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`[r2-section-lock] ${flag} requires a value`);
  }
  return args[index + 1];
}

function optionalFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`[r2-section-lock] ${flag} requires a value`);
  }
  return args[index + 1];
}

const SECTION_LEASE_FILE_VERSION = 1;

function sectionLeaseFilePath(owner, env) {
  if (env.FRONTALIERE_R2_SECTION_LEASE_FILE) return env.FRONTALIERE_R2_SECTION_LEASE_FILE;
  const directory = env.RUNNER_TEMP || os.tmpdir();
  return path.join(directory, `.frontaliere-r2-section-lock-${sha256(owner).slice(0, 32)}.json`);
}

function writeSectionLeaseFile(file, owner, locks) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({
        version: SECTION_LEASE_FILE_VERSION,
        owner,
        locks: locks.map(({ section, leaseId, etag }) => ({
          section,
          leaseId,
          ...(etag ? { etag } : {}),
        })),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The durable lease file was already installed; a leftover temporary
      // file is harmless and remains inside the runner's private temp area.
    }
  }
}

function readSectionLeaseFile(file, owner, sections, { allowMissing = false } = {}) {
  if (!fs.existsSync(file)) {
    if (allowMissing) return null;
    throw new Error(`[r2-section-lock] lease context file is missing for owner ${owner}`);
  }
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`[r2-section-lock] lease context file is invalid: ${error?.message ?? error}`);
  }
  if (stored?.version !== SECTION_LEASE_FILE_VERSION || stored.owner !== owner || !Array.isArray(stored.locks)) {
    throw new Error('[r2-section-lock] lease context file does not belong to this owner');
  }
  const normalized = parseSections(sections.join(','));
  return normalized.map((section) => {
    const lock = stored.locks.find((candidate) => candidate?.section === section);
    if (!lock || typeof lock.leaseId !== 'string' || lock.leaseId.length === 0) {
      throw new Error(`[r2-section-lock] lease context file has no leaseId for ${section}`);
    }
    const etag = lock.etag === undefined ? undefined : normalizeS3MatchEtag(lock.etag);
    if (lock.etag !== undefined && !etag) {
      throw new Error(`[r2-section-lock] lease context file has no strong ETag for ${section}`);
    }
    return {
      section,
      owner,
      leaseId: lock.leaseId,
      key: lockKey(section),
      ...(etag ? { etag } : {}),
    };
  });
}

async function main(args = process.argv.slice(2), env = process.env) {
  const command = args[0];
  if (command !== 'acquire' && command !== 'renew' && command !== 'release') {
    throw new Error('usage: r2-section-lock.mjs <acquire|renew|release> --section <frontaliere[,svizzera]> --owner <run-id>');
  }
  const sections = parseSections(flagValue(args, '--section'));
  const owner = flagValue(args, '--owner');
  const request = createR2Request(env);
  const leaseFile = sectionLeaseFilePath(owner, env);
  if (command === 'acquire') {
    let locks;
    try {
      locks = await acquireSectionLocks(sections, { owner, request });
      writeSectionLeaseFile(leaseFile, owner, locks);
    } catch (error) {
      if (locks?.length) {
        try {
          await releaseSectionLocks(locks, { request });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `[r2-section-lock] acquisition failed and lease context cleanup failed: ${error?.message ?? error}; ${cleanupError?.message ?? cleanupError}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    console.log(`[r2-section-lock] acquired ${locks.map((lock) => lock.section).join(', ')}`);
    return;
  }
  if (command === 'renew') {
    const intervalValue = optionalFlagValue(args, '--interval-ms');
    const intervalMs = intervalValue === undefined ? LOCK_RENEW_INTERVAL_MS : Number(intervalValue);
    const initialDelayValue = optionalFlagValue(args, '--initial-delay-ms');
    const initialDelayMs =
      initialDelayValue === undefined ? LOCK_RENEW_INITIAL_DELAY_MS : Number(initialDelayValue);
    const failureFile = optionalFlagValue(args, '--failure-file');
    const locks = readSectionLeaseFile(leaseFile, owner, sections);
    try {
      await renewSectionLocksUntilStopped(sections, {
        owner,
        locks,
        request,
        onRenewed: () => writeSectionLeaseFile(leaseFile, owner, locks),
        intervalMs,
        initialDelayMs,
      });
    } catch (error) {
      if (failureFile) {
        fs.writeFileSync(failureFile, `${error?.message ?? error}\n`, 'utf8');
      }
      throw error;
    }
    return;
  }
  const locks = readSectionLeaseFile(leaseFile, owner, sections, { allowMissing: true });
  if (!locks) {
    console.log('[r2-section-lock] no lease context for this owner; no lock released');
    return;
  }
  const released = await releaseSectionLocks(locks, { request });
  fs.rmSync(leaseFile, { force: true });
  console.log(`[r2-section-lock] released ${released.join(', ') || 'no lock owned by this run'}`);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`[r2-section-lock] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

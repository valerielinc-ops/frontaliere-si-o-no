#!/usr/bin/env node

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
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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
      && value.expiresAt > value.acquiredAt,
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

function readHeader(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()];
}

async function responseText(response) {
  if (typeof response?.text === 'function') return response.text();
  return '';
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

/**
 * Build the signed R2 transport. Keeping the transport injectable makes the
 * lease race testable without ever contacting the production bucket.
 */
export function createR2Request(env = process.env, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const config = configFromEnv(env);
  if (typeof fetchImpl !== 'function') throw new Error('[r2-section-lock] fetch is unavailable');

  return async ({ method, key, body = '', headers = {} }) => {
    const signed = signRequest({ ...config, now: now(), method, key, body, headers });
    const response = await fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      ...(method === 'GET' || method === 'HEAD' || method === 'DELETE' ? {} : { body: signed.body }),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined,
    });
    return response;
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
    return { etag: readHeader(response, 'etag') };
  }
  if (response.status === 412) return null;
  const body = await responseText(response);
  throw new Error(`[r2-section-lock] acquire ${section} failed (${response.status}): ${body.slice(0, 300)}`);
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
    section,
    acquiredAt: startedAt,
    expiresAt: startedAt + leaseMs,
  };

  while (now() <= deadline) {
    const created = await putLock(request, section, payload, { name: 'if-none-match', value: '*' });
    if (created) {
      return { section, owner, key: lockKey(section), etag: created.etag };
    }

    const current = await readCurrentLock(request, section);
    if (!current) {
      await sleep(100);
      continue;
    }
    if (isLockExpired(current.payload, now())) {
      if (!current.etag) {
        throw new Error(`[r2-section-lock] lock ${section} has no ETag; refusing an unsafe takeover`);
      }
      const replacement = await putLock(request, section, payload, { name: 'if-match', value: current.etag });
      if (replacement) {
        return { section, owner, key: lockKey(section), etag: replacement.etag };
      }
      continue;
    }

    onWait({ section, owner: current.payload.owner, expiresAt: current.payload.expiresAt });
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  throw new Error(`[r2-section-lock] timed out waiting for section ${section}`);
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

/**
 * Extend a lease only if the exact lock read above is still present. A late
 * heartbeat must never revive a lease that another owner already replaced.
 */
export async function renewSectionLock(
  section,
  { owner, request = createR2Request(), now = Date.now, leaseMs = LOCK_LEASE_MS } = {},
) {
  asString(owner, 'owner');
  positiveDuration(leaseMs, 'lease duration');
  const current = await readCurrentLock(request, section);
  if (!current) {
    console.log(`[r2-section-lock] ${section} disappeared before renewal`);
    return false;
  }
  if (current.payload.owner !== owner) {
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
  return true;
}

export async function renewSectionLocks(sections, options = {}) {
  if (!Array.isArray(sections)) throw new Error('[r2-section-lock] sections must be an array');
  const normalized = parseSections(sections.join(','));
  for (const section of normalized) {
    if (!(await renewSectionLock(section, options))) return false;
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
    if (!(await renewSectionLocks(normalized, { owner, request, now, leaseMs }))) {
      throw new Error('[r2-section-lock] lease ownership was lost before renewal started');
    }
    while (!(await waitForStopImpl(intervalMs, stopped))) {
      if (!(await renewSectionLocks(normalized, { owner, request, now, leaseMs }))) {
        throw new Error('[r2-section-lock] lease ownership was lost during renewal');
      }
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

export async function releaseSectionLock(section, { owner, request = createR2Request() } = {}) {
  asString(owner, 'owner');
  const current = await readCurrentLock(request, section);
  if (!current) return false;
  if (current.payload.owner !== owner) {
    // An expired lease may already have been taken over. Never delete the new
    // owner's lock from an always-run cleanup step.
    console.log(`[r2-section-lock] ${section} is owned by another run; leaving it intact`);
    return false;
  }
  if (!current.etag) {
    throw new Error(`[r2-section-lock] lock ${section} has no ETag; refusing an unsafe release`);
  }
  const response = await request({
    method: 'DELETE',
    key: lockKey(section),
    headers: { 'if-match': current.etag },
  });
  if (response.status === 404 || response.status === 412) return false;
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
      if (await releaseSectionLock(lock.section, { ...options, owner: lock.owner })) released.push(lock.section);
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

async function main(args = process.argv.slice(2), env = process.env) {
  const command = args[0];
  if (command !== 'acquire' && command !== 'renew' && command !== 'release') {
    throw new Error('usage: r2-section-lock.mjs <acquire|renew|release> --section <frontaliere[,svizzera]> --owner <run-id>');
  }
  const sections = parseSections(flagValue(args, '--section'));
  const owner = flagValue(args, '--owner');
  const request = createR2Request(env);
  if (command === 'acquire') {
    const locks = await acquireSectionLocks(sections, { owner, request });
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
    try {
      await renewSectionLocksUntilStopped(sections, { owner, request, intervalMs, initialDelayMs });
    } catch (error) {
      if (failureFile) {
        fs.writeFileSync(failureFile, `${error?.message ?? error}\n`, 'utf8');
      }
      throw error;
    }
    return;
  }
  const released = await releaseSectionLocks(
    sections.map((section) => ({ section, owner })),
    { owner, request },
  );
  console.log(`[r2-section-lock] released ${released.join(', ') || 'no lock owned by this run'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[r2-section-lock] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

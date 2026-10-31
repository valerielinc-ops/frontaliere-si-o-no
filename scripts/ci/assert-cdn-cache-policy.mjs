#!/usr/bin/env node
/**
 * assert-cdn-cache-policy.mjs — live check of the browser cache policy on the CDN.
 *
 * The header a browser sees on cdn.frontaliereticino.ch is decided by a zone
 * Transform Rule, downstream of what R2 stores, so a test on the deploy script
 * cannot see it. That gap hid a real regression: R2 and the edge held the release
 * graph as immutable while cdn-assets-revalidate told every browser 600 s
 * (infra/cloudflare/rules.md).
 *
 * Always GET: HEAD is never answered from the edge cache on this zone, so it
 * reports `cf-cache-status: DYNAMIC` on every path and the reading means nothing.
 *
 * Read-only. Exit 1 when a policy is wrong or the CDN answers an error status; a
 * network failure after the retries is a warning, because this runs after a Worker
 * rollout that must not be reported as failed for a problem on the runner side.
 */
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const CDN_ORIGIN = 'https://cdn.frontaliereticino.ch';
const MIN_IMMUTABLE_MAX_AGE = 31536000;

export function parseReleaseId(bootstrapSource) {
  return /FRONTALIERE_RELEASE_ID\s*=\s*"?(\d+)"?/.exec(bootstrapSource)?.[1] ?? null;
}

function maxAge(cacheControl) {
  const match = /(?:^|[,\s])max-age=(\d+)/.exec(cacheControl);
  return match ? Number(match[1]) : null;
}

/** @returns {string|null} why the header is wrong for this class of URL, or null. */
export function cachePolicyProblem(kind, cacheControl) {
  const value = (cacheControl || '').toLowerCase();
  if (kind === 'release') {
    if (!value.includes('immutable')) return `release asset is not immutable: "${cacheControl}"`;
    if ((maxAge(value) ?? 0) < MIN_IMMUTABLE_MAX_AGE) return `release asset max-age too short: "${cacheControl}"`;
    return null;
  }
  if (kind === 'stable-alias') {
    if (value.includes('immutable')) return `stable alias must never be immutable: "${cacheControl}"`;
    const age = maxAge(value);
    if (age === null || age > 600) return `stable alias TTL is not bounded to 600 s: "${cacheControl}"`;
    return null;
  }
  if (kind === 'early-boot') {
    return value.includes('no-cache') ? null : `early-boot.js must be no-cache: "${cacheControl}"`;
  }
  throw new Error(`unknown asset class: ${kind}`);
}

/** A status the CDN really answered, unlike a network failure on the probe side. */
class HttpProbeError extends Error {}

async function getWithRetry(url, { fetchImpl, retryDelayMs }, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(20000) });
      if (response.ok) return response;
      lastError = new HttpProbeError(`${url}: HTTP ${response.status}`);
    } catch (error) {
      lastError = new Error(`${url}: ${error?.message ?? 'unreachable'}`);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw lastError;
}

/** @returns {Promise<number>} the exit code: 1 when a policy or an asset is wrong. */
export async function runCachePolicyCheck({ fetchImpl = fetch, retryDelayMs = 5000 } = {}) {
  const options = { fetchImpl, retryDelayMs };
  const problems = [];
  // A missing asset is a broken CDN and blocks; an unreachable one is this
  // runner's network and only warns.
  const record = (error) => {
    if (error instanceof HttpProbeError) problems.push(error.message);
    else console.log(`::warning::CDN cache policy probe skipped: ${error.message}`);
  };

  let bootstrap;
  try {
    bootstrap = await getWithRetry(`${CDN_ORIGIN}/assets/index-entry.js`, options);
  } catch (error) {
    record(error);
  }
  if (!bootstrap) {
    for (const problem of problems) console.log(`::error::${problem}`);
    return problems.length ? 1 : 0;
  }
  const bootstrapCacheControl = bootstrap.headers.get('cache-control');
  const releaseId = parseReleaseId(await bootstrap.text());
  if (!releaseId) {
    console.log('::error::index-entry.js has no FRONTALIERE_RELEASE_ID: the stable entry is not the bootstrap');
    return 1;
  }

  const probes = [
    ['stable-alias', `${CDN_ORIGIN}/assets/index.css`],
    ['early-boot', `${CDN_ORIGIN}/assets/early-boot.js`],
    ['release', `${CDN_ORIGIN}/assets/releases/${releaseId}/index-entry.js`],
    ['release', `${CDN_ORIGIN}/assets/releases/${releaseId}/index.css`],
  ];
  const bootstrapProblem = cachePolicyProblem('stable-alias', bootstrapCacheControl);
  if (bootstrapProblem) problems.push(`assets/index-entry.js: ${bootstrapProblem}`);
  for (const [kind, url] of probes) {
    try {
      const response = await getWithRetry(url, options);
      await response.arrayBuffer();
      const cacheControl = response.headers.get('cache-control');
      console.log(`${kind} ${url} -> ${cacheControl} (${response.headers.get('cf-cache-status')})`);
      const problem = cachePolicyProblem(kind, cacheControl);
      if (problem) problems.push(`${url}: ${problem}`);
    } catch (error) {
      record(error);
    }
  }
  for (const problem of problems) console.log(`::error::${problem}`);
  return problems.length ? 1 : 0;
}

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = await runCachePolicyCheck();
}

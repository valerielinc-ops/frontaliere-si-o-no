import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  createPublicConnectionLookup,
  isPrivateOrLocalAddress,
} from './lib/prospector/public-fetch-policy.mjs';

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 5;
const MAX_DOMAIN_CONCURRENCY = 4;
const DEFAULT_DOMAIN_CONCURRENCY = 2;
const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 307, 308]);
const HEAD_FALLBACK_STATUSES = new Set([403, 405, 501]);
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/** @typedef {{ get?: (name: string) => string|null }} ResolverHeaders */
/** @typedef {{ cancel?: () => Promise<unknown>|unknown }} ResolverBody */
/** @typedef {{ ok: boolean, status: number, url?: string, headers?: ResolverHeaders, body?: ResolverBody|null }} ResolverResponse */
/** @typedef {{ method: 'HEAD'|'GET', redirect: 'manual', signal: AbortSignal, headers: Record<string, string>, dispatcher?: import('undici').Dispatcher }} ResolverRequestInit */
/** @typedef {(input: string, init: ResolverRequestInit) => Promise<ResolverResponse>} ResolverFetch */
/** @typedef {{ address: string, family: number }} ResolverLookupRecord */
/** @typedef {{ all: true, verbatim: true }} ResolverLookupOptions */
/** @typedef {(hostname: string, options: ResolverLookupOptions) => Promise<ResolverLookupRecord[]|ResolverLookupRecord>} ResolverLookup */
/** @typedef {{ fetchImpl?: ResolverFetch, lookupImpl?: ResolverLookup, timeoutMs?: number, dispatcher?: import('undici').Dispatcher }} ResolverOptions */

/** @param {unknown} value @returns {string|null} */
export function normalizeDomain(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return hostname || null;
  } catch {
    return null;
  }
}

function canonicalHttpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isBlockedAddress(address) {
  const normalized = String(address).replace(/^\[|\]$/g, '');
  return isIP(normalized) === 0 || isPrivateOrLocalAddress(normalized);
}

async function validatePublicHttpsUrl(value, lookupImpl) {
  const canonical = canonicalHttpsUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) return null;

  if (isIP(hostname)) return isBlockedAddress(hostname) ? null : canonical;

  let records;
  try {
    records = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    return null;
  }
  const addresses = (Array.isArray(records) ? records : [records])
    .map((record) => typeof record === 'string' ? record : record?.address)
    .filter(Boolean);
  return addresses.length > 0 && addresses.every((address) => !isBlockedAddress(address)) ? canonical : null;
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Releasing a response body is best-effort; the resolver still fails closed.
  }
}

async function finishBeforeDeadline(operation, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return null;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), remainingMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createBoundedPublicDispatcher(lookupImpl, timeoutMs) {
  const boundedLookup = async (hostname, options) => {
    const records = await finishBeforeDeadline(
      () => lookupImpl(hostname, options),
      Date.now() + Math.max(0, Number(timeoutMs) || 0),
    );
    if (!records) throw new Error(`DNS lookup timed out for ${hostname}`);
    return records;
  };
  return new Agent({ connect: { lookup: createPublicConnectionLookup(boundedLookup) } });
}

async function fetchBeforeDeadline(url, method, fetchImpl, deadline, dispatcher) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return null;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'frontaliere-company-website-resolver/1.0' },
        ...(dispatcher ? { dispatcher } : {}),
      })).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function followRedirects(startUrl, method, { fetchImpl, lookupImpl, deadline, dispatcher }) {
  let current = startUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const validated = await finishBeforeDeadline(
      () => validatePublicHttpsUrl(current, lookupImpl),
      deadline,
    );
    if (!validated) return null;

    const response = await fetchBeforeDeadline(validated, method, fetchImpl, deadline, dispatcher);
    if (!response) return null;

    let effectiveUrl = validated;
    if (response?.url && response.url !== validated) {
      effectiveUrl = await finishBeforeDeadline(
        () => validatePublicHttpsUrl(response.url, lookupImpl),
        deadline,
      );
      if (!effectiveUrl) {
        await cancelBody(response);
        return null;
      }
    }

    if (REDIRECT_STATUSES.has(response?.status)) {
      const location = response?.headers?.get?.('location');
      await cancelBody(response);
      if (!location || redirectCount === MAX_REDIRECTS) return null;
      try {
        current = new URL(location, effectiveUrl).toString();
      } catch {
        return null;
      }
      continue;
    }

    const result = response?.ok ? canonicalHttpsUrl(effectiveUrl) : null;
    const status = response?.status;
    await cancelBody(response);
    return { result, status };
  }
  return null;
}

async function request(url, options) {
  for (const method of ['HEAD', 'GET']) {
    const response = await followRedirects(url, method, options);
    if (response?.result) return response.result;
    if (method === 'HEAD' && HEAD_FALLBACK_STATUSES.has(response?.status)) continue;
    return null;
  }
  return null;
}

/**
 * @param {string} domain
 * @param {ResolverOptions} [options]
 * @returns {Promise<string|null>}
 */
export async function resolveCompanyWebsite(domain, {
  fetchImpl = undiciFetch,
  lookupImpl = lookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dispatcher,
} = {}) {
  if (!domain) return null;
  const ownsDispatcher = !dispatcher;
  const activeDispatcher = dispatcher || createBoundedPublicDispatcher(lookupImpl, timeoutMs);
  try {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    const options = { fetchImpl, lookupImpl, deadline, dispatcher: activeDispatcher };
    const results = await Promise.all([
      request(`https://${domain}/`, options),
      request(`https://www.${domain}/`, options),
    ]);
    const winners = results.filter(Boolean);
    if (winners.length === 1) return winners[0];
    return winners.length === 2 && winners[0] === winners[1] ? winners[0] : null;
  } finally {
    if (ownsDispatcher) await activeDispatcher.close();
  }
}

/**
 * @param {Array<{website?: unknown}>} companies
 * @param {ResolverOptions & {limit?: number, concurrency?: number}} [options]
 * @returns {Promise<Record<string, string|null>>}
 */
export async function resolveCompanyWebsites(companies, options = {}) {
  const domains = [...new Set(companies.map(({ website }) => normalizeDomain(website)).filter(Boolean))].sort();
  const limit = Number.isInteger(options.limit) ? options.limit : domains.length;
  const selected = domains.slice(0, Math.max(0, limit));
  if (selected.length === 0) return {};

  const requestedConcurrency = Number.isInteger(options.concurrency)
    ? options.concurrency
    : DEFAULT_DOMAIN_CONCURRENCY;
  const concurrency = Math.min(MAX_DOMAIN_CONCURRENCY, Math.max(1, requestedConcurrency), selected.length);
  const entries = Array(selected.length);
  const ownsDispatcher = !options.dispatcher;
  const dispatcher = options.dispatcher || createBoundedPublicDispatcher(
    options.lookupImpl || lookup,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const domain = selected[index];
      entries[index] = [domain, await resolveCompanyWebsite(domain, { ...options, dispatcher })];
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return Object.fromEntries(entries);
  } finally {
    if (ownsDispatcher) await dispatcher.close();
  }
}

/**
 * @param {ResolverOptions & {inputPath?: string, outputPath?: string, limit?: number, concurrency?: number}} [options]
 * @returns {Promise<{schemaVersion: 1, domains: Record<string, string|null>}>}
 */
export async function run({
  inputPath = path.resolve('data/crawler-companies-auto.json'),
  outputPath = path.resolve('data/company-website-resolved.json'),
  limit = 22,
  fetchImpl = undiciFetch,
  lookupImpl = lookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_DOMAIN_CONCURRENCY,
} = {}) {
  const companies = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!Array.isArray(companies)) throw new Error('crawler companies input must be an array');
  const domains = await resolveCompanyWebsites(companies, {
    fetchImpl,
    lookupImpl,
    timeoutMs,
    limit,
    concurrency,
  });
  const registry = { schemaVersion: /** @type {const} */ (1), domains };
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  let current = null;
  try {
    current = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== serialized) writeJsonAtomic(outputPath, registry);
  return registry;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const limitIndex = process.argv.indexOf('--limit');
  const limit = limitIndex === -1 ? 22 : Number(process.argv[limitIndex + 1]);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const registry = await run({ limit });
  console.log(`resolved ${Object.keys(registry.domains).length} company website domains`);
}

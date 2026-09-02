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

export function normalizeDomain(value) {
  try {
    const url = new URL(value);
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

async function fetchWithTimeout(url, method, fetchImpl, timeoutMs, dispatcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'frontaliere-company-website-resolver/1.0' },
      ...(dispatcher ? { dispatcher } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function followRedirects(startUrl, method, { fetchImpl, lookupImpl, timeoutMs, dispatcher }) {
  let current = startUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const validated = await validatePublicHttpsUrl(current, lookupImpl);
    if (!validated) return null;

    let response;
    try {
      response = await fetchWithTimeout(validated, method, fetchImpl, timeoutMs, dispatcher);
    } catch {
      return null;
    }

    if (REDIRECT_STATUSES.has(response?.status)) {
      const location = response?.headers?.get?.('location');
      await cancelBody(response);
      if (!location || redirectCount === MAX_REDIRECTS) return null;
      try {
        current = new URL(location, validated).toString();
      } catch {
        return null;
      }
      continue;
    }

    const result = response?.ok ? canonicalHttpsUrl(validated) : null;
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

export async function resolveCompanyWebsite(domain, {
  fetchImpl = undiciFetch,
  lookupImpl = lookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dispatcher,
} = {}) {
  if (!domain) return null;
  const ownsDispatcher = !dispatcher;
  const activeDispatcher = dispatcher || new Agent({ connect: { lookup: createPublicConnectionLookup(lookupImpl) } });
  try {
    const options = { fetchImpl, lookupImpl, timeoutMs, dispatcher: activeDispatcher };
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
  const dispatcher = options.dispatcher || new Agent({ connect: { lookup: createPublicConnectionLookup(options.lookupImpl || lookup) } });
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
  const registry = { schemaVersion: 1, domains };
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

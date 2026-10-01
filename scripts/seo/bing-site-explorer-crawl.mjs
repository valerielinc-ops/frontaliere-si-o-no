#!/usr/bin/env node

/**
 * Deterministic, Bing-compatible sitemap/tree crawler.
 *
 * Bing Site Explorer's UI counters are useful but its private browser endpoints
 * are not a stable CI API. This script owns the reproducible contract: fetch
 * the complete sitemap graph, partition every URL deterministically, probe every
 * partition, and classify HTTP/SEO findings for reconciliation with Bing.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAttributes } from '../lib/meta-description-extract.mjs';
import { classifyCanonicalMismatch } from '../lib/canonicalExemptions.mjs';

export const CRAWLER_SCHEMA_VERSION = 1;
export const DEFAULT_BASE_URL = 'https://frontaliereticino.ch';
export const DEFAULT_SITEMAP_URL = `${DEFAULT_BASE_URL}/sitemap.xml`;
export const CRAWLER_USER_AGENT = 'frontaliere-bing-tree-crawler/1.0 (+https://frontaliereticino.ch/)';
export const DEFAULT_PARTITIONS = 24;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_TIMEOUT_MS = 30_000;
// Pages sits behind an edge that can answer a small fraction of concurrent
// requests with a transient 5xx. Five total attempts keep the full-tree report
// focused on persistent failures without changing deterministic URL ownership.
export const DEFAULT_RETRIES = 4;
// A partition can still finish with a handful of transient 5xx responses when
// its normal workers hit the edge at the same time. Recheck only those URLs
// after the partition drains, at low concurrency, so a burst is not promoted
// to a backlog finding. Persistent failures remain findings after this rescue.
export const DEFAULT_RESCUE_CONCURRENCY = 2;
export const DEFAULT_RESCUE_RETRIES = 4;
export const DEFAULT_RESCUE_DELAY_MS = 3_000;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_MAX_SITEMAP_BYTES = 64 * 1024 * 1024;
export const DISCOVERY_SAMPLE_LIMIT = 100;
export const TITLE_MAX_CHARS = 66;
export const META_DESCRIPTION_MIN_CHARS = 120;

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractLocs(xml, tagName) {
  const values = [];
  const rx = new RegExp(`<${tagName}\\b[\\s\\S]*?<loc>([\\s\\S]*?)</loc>[\\s\\S]*?</${tagName}>`, 'gi');
  let match;
  while ((match = rx.exec(String(xml || ''))) !== null) {
    const value = decodeXmlEntities(match[1]).trim();
    if (value) values.push(value);
  }
  return values;
}

/** Keep slash conventions for pages without turning explicit files into dirs. */
export function normalizeUrl(value, baseUrl = DEFAULT_BASE_URL) {
  try {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const url = new URL(raw, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+/g, '/') || '/';
    const last = url.pathname.split('/').filter(Boolean).at(-1) || '';
    if (url.pathname !== '/' && !url.pathname.endsWith('/') && !last.includes('.')) url.pathname += '/';
    return url.toString();
  } catch {
    return null;
  }
}

function originFor(value) {
  return new URL(value).origin;
}

function isSameOrigin(value, baseUrl) {
  try { return originFor(value) === originFor(baseUrl); } catch { return false; }
}

/** Parse either a sitemap index or a urlset. */
export function parseSitemapDocument(xml, baseUrl = DEFAULT_BASE_URL) {
  const sitemapUrls = extractLocs(xml, 'sitemap')
    .map((value) => normalizeUrl(value, baseUrl))
    .filter((value) => value && isSameOrigin(value, baseUrl));
  const pageUrls = extractLocs(xml, 'url')
    .map((value) => normalizeUrl(value, baseUrl))
    .filter((value) => value && isSameOrigin(value, baseUrl));
  return {
    kind: sitemapUrls.length > 0 && pageUrls.length === 0 ? 'sitemapindex' : 'urlset',
    sitemapUrls: [...new Set(sitemapUrls)],
    pageUrls: [...new Set(pageUrls)],
  };
}

export function folderFor(value) {
  const first = new URL(value).pathname.split('/').filter(Boolean)[0];
  return first ? `/${first}/` : '/';
}

/** Stable partitioning: changing concurrency never changes URL ownership. */
export function partitionFor(value, partitions = DEFAULT_PARTITIONS) {
  const count = Number(partitions);
  if (!Number.isInteger(count) || count < 1) throw new Error(`partitions non valido: ${partitions}`);
  const digest = createHash('sha256').update(String(value)).digest();
  return digest.readUInt32BE(0) % count;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const equal = item.indexOf('=');
    if (equal >= 0) args[item.slice(2, equal)] = item.slice(equal + 1);
    else args[item.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function intArg(args, name, fallback) {
  const raw = args[name];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stringArg(args, name, fallback) {
  return args[name] === undefined || args[name] === true ? fallback : String(args[name]);
}

function ensureParent(filePath) {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function header(response, name) {
  return response?.headers?.get?.(name) || response?.headers?.[name] || '';
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchWithTimeout(url, options = {}, fetchImpl = globalThis.fetch) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _ignored, ...fetchOptions } = options;
  try {
    return await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedBody(response, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  if (!response?.body?.getReader) {
    const text = await response.text();
    return { text: String(text || '').slice(0, maxBytes), truncated: String(text || '').length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(chunk.slice(0, remaining));
      total += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

async function fetchSitemap(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': CRAWLER_USER_AGENT, accept: 'application/xml,text/xml,text/plain;q=0.8' },
    timeoutMs,
  }, fetchImpl);
  if (!response.ok) throw new Error(`sitemap ${response.status} ${url}`);
  const body = await readLimitedBody(response, DEFAULT_MAX_SITEMAP_BYTES);
  if (body.truncated) throw new Error(`sitemap oltre ${DEFAULT_MAX_SITEMAP_BYTES} byte: ${url}`);
  return body.text;
}

/** Fetch the complete sitemap graph and return one canonical URL manifest. */
export async function collectSitemapInventory({
  sitemapUrl = DEFAULT_SITEMAP_URL,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxSitemaps = 2_000,
} = {}) {
  const root = normalizeUrl(sitemapUrl, baseUrl);
  if (!root || !isSameOrigin(root, baseUrl)) throw new Error(`sitemap fuori origine: ${sitemapUrl}`);
  const pending = [root];
  const visited = new Set();
  const sitemapUrls = [];
  const pageUrls = new Set();
  const errors = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (visited.size > maxSitemaps) throw new Error(`troppi sitemap: oltre ${maxSitemaps}`);
    try {
      const xml = await fetchSitemap(current, { fetchImpl, timeoutMs });
      const parsed = parseSitemapDocument(xml, baseUrl);
      if (parsed.sitemapUrls.length === 0 && parsed.pageUrls.length === 0) {
        throw new Error(`sitemap vuoto o formato non supportato: ${current}`);
      }
      sitemapUrls.push(current);
      for (const nested of parsed.sitemapUrls) if (!visited.has(nested)) pending.push(nested);
      for (const page of parsed.pageUrls) pageUrls.add(page);
    } catch (error) {
      errors.push({ url: current, error: error?.message || String(error) });
    }
  }
  const urls = [...pageUrls].sort();
  const folders = {};
  const partitions = {};
  for (const url of urls) {
    const folder = folderFor(url);
    folders[folder] = (folders[folder] || 0) + 1;
    const partition = partitionFor(url);
    partitions[partition] = (partitions[partition] || 0) + 1;
  }
  return {
    schemaVersion: CRAWLER_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    baseUrl: originFor(baseUrl),
    sitemap: root,
    sitemapCount: sitemapUrls.length,
    sitemapUrls,
    manifestCount: urls.length,
    urls,
    folders,
    partitions,
    errors,
  };
}

function decodedPath(value) {
  try { return decodeURIComponent(new URL(value).pathname); } catch { return new URL(value).pathname; }
}

/**
 * Decide whether a same-site link is an HTML route worth crawling as part of
 * the SEO tree. Query-string links are deliberately kept as evidence but not
 * expanded into the crawl frontier: calculators, filters and tracking URLs
 * can create an unbounded parameter space and are not sitemap documents.
 */
export function classifyDiscoveredUrl(value, baseUrl = DEFAULT_BASE_URL) {
  const normalized = normalizeUrl(value, baseUrl);
  if (!normalized || !isSameOrigin(normalized, baseUrl)) return { url: normalized || String(value || ''), reason: 'outside-origin' };
  const parsed = new URL(normalized);
  if (parsed.search) return { url: normalized, reason: 'dynamic-query' };
  if (!isCrawlableLink(normalized)) return { url: normalized, reason: 'non-html-or-private' };
  // Broken editor tokens such as <nav:calculator> are useful findings, not
  // valid routes to expand. Keep them in the evidence ledger separately.
  if (/<\s*nav\s*:/i.test(decodedPath(normalized))) return { url: normalized, reason: 'malformed-route' };
  return { url: normalized, reason: 'crawl' };
}

/**
 * Build the next deterministic frontier from links found during the sitemap
 * crawl. This is intentionally a separate manifest: the first pass remains
 * the authoritative sitemap coverage, while the second pass verifies real
 * HTML routes that are linked internally but omitted from XML sitemaps.
 */
export function collectDiscoveredInventory({
  reports = [],
  manifest,
  baseUrl = manifest?.baseUrl || DEFAULT_BASE_URL,
  partitions = DEFAULT_PARTITIONS,
} = {}) {
  if (!manifest || !Array.isArray(manifest.urls)) throw new Error('manifest.urls mancante');
  const manifestSet = new Set(manifest.urls);
  const discovered = new Set();
  for (const report of reports) {
    for (const url of report?.discoveredOutOfSitemap || []) {
      if (!manifestSet.has(url)) discovered.add(url);
    }
  }
  const urls = [];
  const excludedByReason = {};
  const excludedSamplesByReason = {};
  const frontierFindings = [];
  for (const value of [...discovered].sort()) {
    const classified = classifyDiscoveredUrl(value, baseUrl);
    if (classified.reason === 'crawl') {
      urls.push(classified.url);
      continue;
    }
    increment(excludedByReason, classified.reason);
    const samples = excludedSamplesByReason[classified.reason] || (excludedSamplesByReason[classified.reason] = []);
    if (samples.length < DISCOVERY_SAMPLE_LIMIT) samples.push(classified.url);
    if (classified.reason === 'malformed-route') {
      frontierFindings.push({
        code: 'internal-link-malformed',
        url: classified.url,
        detail: 'Link interno verso un token di navigazione/editor non valido.',
        root: folderFor(classified.url),
      });
    }
  }
  const uniqueUrls = [...new Set(urls)].sort();
  const folders = {};
  const partitionCounts = {};
  for (const url of uniqueUrls) {
    const folder = folderFor(url);
    increment(folders, folder);
    const partition = partitionFor(url, partitions);
    increment(partitionCounts, partition);
  }
  return {
    schemaVersion: CRAWLER_SCHEMA_VERSION,
    kind: 'discovered-frontier',
    generatedAt: new Date().toISOString(),
    baseUrl: originFor(baseUrl),
    parentManifestCount: manifest.urls.length,
    sourceReportCount: reports.length,
    sourceDiscoveredCount: discovered.size,
    manifestCount: uniqueUrls.length,
    urls: uniqueUrls,
    folders,
    partitions: partitionCounts,
    excludedByReason,
    excludedSamplesByReason,
    findings: frontierFindings,
    errors: [],
  };
}

function attr(attributes, name) {
  const parsed = parseAttributes(attributes);
  return decodeXmlEntities(parsed[String(name || '').toLowerCase()] ?? '');
}

function stripTags(value) {
  return decodeXmlEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function findMetaRobots(html) {
  const values = [];
  for (const match of String(html || '').matchAll(/<meta\b([^>]*)>/gi)) {
    const name = attr(match[1], 'name').toLowerCase();
    if (name === 'robots' || name === 'bingbot' || name === 'googlebot') {
      const content = attr(match[1], 'content').toLowerCase();
      if (content) values.push(content);
    }
  }
  return values;
}

function findCanonical(html, pageUrl) {
  for (const match of String(html || '').matchAll(/<link\b([^>]*)>/gi)) {
    if (!attr(match[1], 'rel').toLowerCase().split(/\s+/).includes('canonical')) continue;
    return normalizeUrl(attr(match[1], 'href'), pageUrl);
  }
  return '';
}

function findTitle(html) {
  return stripTags(String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
}

function normalizeMetadataText(value) {
  return decodeXmlEntities(stripTags(String(value || ''))).replace(/\s+/g, ' ').trim();
}

/**
 * Google News headlines are intentionally allowed to exceed the generic SERP
 * title budget when the emitted `<title>` is byte-identical to the
 * NewsArticle headline. Capping only one of the two fields would break the
 * eligibility contract; this is an explicit, machine-checked exemption.
 */
function hasNewsArticleTitleInvariant(html, title) {
  const expected = normalizeMetadataText(title);
  if (!expected) return false;
  const scripts = String(html || '').matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const match of scripts) {
    try {
      const stack = [JSON.parse(match[1])];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        const type = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        if (type.includes('NewsArticle') && normalizeMetadataText(node.headline) === expected) return true;
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    } catch {
      // One malformed JSON-LD block must not hide a valid NewsArticle block.
    }
  }
  return false;
}

function findMetaDescription(html) {
  for (const match of String(html || '').matchAll(/<meta\b([^>]*)>/gi)) {
    if (attr(match[1], 'name').toLowerCase() !== 'description') continue;
    return attr(match[1], 'content').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function isSoft404(html, title) {
  const heading = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '';
  const signal = `${title} ${stripTags(heading)}`.trim();
  return /^(?:404\b|pagina non trovata\b|page not found\b|seite nicht gefunden\b|page introuvable\b)/i.test(signal);
}

function isCrawlableLink(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (/\.(?:css|csv|gif|ico|jpe?g|js|json|map|pdf|png|svg|webp|woff2?|xml|zip)$/i.test(url.pathname)) return false;
    return !url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export function extractInternalLinks(html, pageUrl, baseUrl = DEFAULT_BASE_URL) {
  const links = new Set();
  for (const match of String(html || '').matchAll(/<a\b([^>]*)>/gi)) {
    const href = attr(match[1], 'href');
    if (!href || href.startsWith('#')) continue;
    const normalized = normalizeUrl(href, pageUrl);
    if (!normalized || !isSameOrigin(normalized, baseUrl) || !isCrawlableLink(normalized)) continue;
    links.add(normalized);
  }
  return [...links].sort();
}

function finding(code, url, detail, extra = {}) {
  return { code, url, detail, ...extra };
}

/** Pure classification used by the crawler and its unit tests. */
export function classifyDocument({ url, status, finalUrl = url, headers = {}, contentType = '', html = '' }) {
  const findings = [];
  const statusNumber = Number(status) || 0;
  const xRobots = typeof headers.get === 'function' ? headers.get('x-robots-tag') || '' : headers['x-robots-tag'] || '';
  if (statusNumber === 0) {
    findings.push(finding('fetch-error', url, 'La richiesta non ha prodotto una risposta HTTP.'));
    return { findings, title: '', description: '', canonical: '', noindex: false, soft404: false };
  }
  if (statusNumber >= 300 && statusNumber < 400) {
    findings.push(finding('redirect', url, `HTTP ${statusNumber} verso ${finalUrl}.`, { status: statusNumber }));
    return { findings, title: '', description: '', canonical: '', noindex: false, soft404: false };
  }
  if (statusNumber < 200 || statusNumber >= 400) {
    findings.push(finding('http-error', url, `HTTP ${statusNumber}.`, { status: statusNumber }));
    return { findings, title: '', description: '', canonical: '', noindex: false, soft404: false };
  }
  const normalizedContentType = String(contentType || '').toLowerCase();
  const headerNoindex = /\bnoindex\b/i.test(xRobots);
  if (normalizedContentType && !/(?:text\/html|application\/xhtml\+xml)\b/i.test(normalizedContentType)) {
    if (headerNoindex) findings.push(finding('noindex-in-sitemap', url, 'La risorsa pubblicata in sitemap dichiara noindex.'));
    return { findings, title: '', description: '', canonical: '', noindex: headerNoindex, soft404: false };
  }
  const title = findTitle(html);
  const description = findMetaDescription(html);
  const canonical = findCanonical(html, url);
  const metaRobots = findMetaRobots(html).join(',');
  const noindex = /\bnoindex\b/i.test(`${xRobots},${metaRobots}`);
  const soft404 = isSoft404(html, title);
  if (!title) findings.push(finding('title-missing', url, 'La pagina in sitemap non contiene un <title>.'));
  else if (title.length > TITLE_MAX_CHARS && !hasNewsArticleTitleInvariant(html, title)) {
    findings.push(finding(
      'title-too-long',
      url,
      `<title> misura ${title.length} caratteri; limite ${TITLE_MAX_CHARS}.`,
    ));
  }
  if (!description) {
    findings.push(finding('meta-description-missing', url, 'La pagina in sitemap non contiene una meta description.'));
  } else if (description.length < META_DESCRIPTION_MIN_CHARS) {
    findings.push(finding(
      'meta-description-too-short',
      url,
      `La meta description misura ${description.length} caratteri; minimo ${META_DESCRIPTION_MIN_CHARS}.`,
    ));
  }
  if (noindex) findings.push(finding('noindex-in-sitemap', url, 'La pagina pubblicata in sitemap dichiara noindex.'));
  if (!canonical) findings.push(finding('canonical-missing', url, 'Manca il canonical nella risposta HTML.'));
  else if (normalizeUrl(canonical) !== normalizeUrl(finalUrl || url)) {
    const exemption = classifyCanonicalMismatch({ url: finalUrl || url, canonical, html });
    if (exemption) {
      findings.push(finding(
        'canonical-expected',
        url,
        `Canonical ${canonical} consolidato correttamente (${exemption}).`,
        { exemption },
      ));
    } else {
      findings.push(finding('canonical-drift', url, `Canonical ${canonical} diverso dalla URL finale ${finalUrl || url}.`));
    }
  }
  if (soft404) findings.push(finding('soft-404', url, 'La risposta è 200 ma il titolo/H1 identifica una pagina non trovata.'));
  return { findings, title, description, canonical, noindex, soft404 };
}

async function probeOnce(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': CRAWLER_USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
      timeoutMs,
    }, fetchImpl);
  } catch (error) {
    return { url, status: 0, finalUrl: url, findings: [finding('fetch-error', url, error?.message || String(error))], links: [] };
  }
  const location = header(response, 'location');
  const finalUrl = location ? normalizeUrl(location, url) || location : url;
  const contentType = header(response, 'content-type').toLowerCase();
  const body = response.status >= 200 && response.status < 400 && (contentType.includes('html') || !contentType)
    ? await readLimitedBody(response, maxBodyBytes)
    : { text: '', truncated: false };
  const classified = classifyDocument({
    url,
    status: response.status,
    finalUrl,
    headers: response.headers,
    contentType,
    html: body.text,
  });
  return {
    url,
    status: response.status,
    finalUrl,
    title: classified.title,
    description: classified.description,
    canonical: classified.canonical,
    noindex: classified.noindex,
    soft404: classified.soft404,
    truncated: body.truncated,
    findings: classified.findings,
    links: response.status === 200 && body.text ? extractInternalLinks(body.text, url) : [],
  };
}

export async function probeWithRetries(url, options = {}) {
  const retries = Number(options.retries ?? DEFAULT_RETRIES);
  const configuredTimeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutBudgetMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  const configuredDeadlineAt = Number(options.deadlineAt);
  const deadlineAt = Number.isFinite(configuredDeadlineAt) ? configuredDeadlineAt : Number.POSITIVE_INFINITY;
  let result;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (Date.now() >= deadlineAt) {
      return result || {
        url,
        status: 0,
        finalUrl: url,
        findings: [finding('fetch-error', url, 'Il budget temporale della verifica è scaduto.')],
        links: [],
      };
    }
    const remainingBudgetMs = Math.max(1, deadlineAt - Date.now());
    result = await probeOnce(url, { ...options, timeoutMs: Math.min(timeoutBudgetMs, remainingBudgetMs) });
    const retryable = result.status === 0 || result.status === 429 || result.status >= 500;
    if (!retryable || attempt === retries) return result;
    const backoffMs = Math.min(8_000, 500 * (2 ** attempt));
    if (Date.now() + backoffMs >= deadlineAt) return result;
    await sleep(backoffMs);
  }
  return result;
}

function isTransientResult(result) {
  const status = Number(result?.status) || 0;
  return status === 0 || status === 429 || status >= 500;
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

export async function crawlPartition({
  manifest,
  partition = 0,
  partitions = DEFAULT_PARTITIONS,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  rescueConcurrency = DEFAULT_RESCUE_CONCURRENCY,
  rescueRetries = DEFAULT_RESCUE_RETRIES,
  rescueDelayMs = DEFAULT_RESCUE_DELAY_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!manifest || !Array.isArray(manifest.urls)) throw new Error('manifest.urls mancante');
  const part = Number(partition);
  const totalPartitions = Number(partitions);
  if (!Number.isInteger(part) || part < 0 || part >= totalPartitions) throw new Error(`partition non valida: ${partition}/${partitions}`);
  const selected = manifest.urls.filter((url) => partitionFor(url, totalPartitions) === part);
  const manifestSet = new Set(manifest.urls);
  const entries = selected.map((url, index) => ({ url, index }));
  const results = new Array(selected.length);

  const probeEntries = async (items, poolConcurrency, attemptRetries) => {
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        const entry = items[index];
        results[entry.index] = await probeWithRetries(entry.url, {
          fetchImpl,
          timeoutMs,
          retries: attemptRetries,
          maxBodyBytes,
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, Number(poolConcurrency) || 1), items.length) },
        () => worker(),
      ),
    );
  };

  await probeEntries(entries, concurrency, retries);

  // Recheck only edge/transient failures after all normal workers have drained.
  // Keeping this pool separate from the main pass is important: lowering the
  // global concurrency would make the full crawl unnecessarily slow, while
  // rescuing every URL would hide real persistent failures behind extra load.
  const transientEntries = entries.filter((entry) => isTransientResult(results[entry.index]));
  if (transientEntries.length > 0) {
    const delay = Math.max(0, Number(rescueDelayMs) || 0);
    if (delay > 0) await sleep(delay);
    await probeEntries(transientEntries, rescueConcurrency, rescueRetries);
  }

  const findings = [];
  const discovered = new Set();
  const statusCounts = {};
  const codeCounts = {};
  const folderStats = {};
  for (let index = 0; index < selected.length; index += 1) {
    const url = selected[index];
    const result = results[index] || {
      url,
      status: 0,
      findings: [finding('fetch-error', url, 'La richiesta non ha prodotto una risposta HTTP.')],
      links: [],
    };
    const folder = folderFor(url);
    const stats = folderStats[folder] || (folderStats[folder] = { checked: 0, statuses: {}, findings: {} });
    stats.checked += 1;
    increment(statusCounts, String(result.status));
    increment(stats.statuses, String(result.status));
    for (const item of result.findings || []) {
      findings.push({ ...item, root: folder, status: result.status });
      increment(codeCounts, item.code);
      increment(stats.findings, item.code);
    }
    for (const link of result.links || []) if (!manifestSet.has(link)) discovered.add(link);
  }
  return {
    schemaVersion: CRAWLER_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    baseUrl: manifest.baseUrl,
    manifestCount: manifest.urls.length,
    partition: part,
    partitions: totalPartitions,
    partitionTotal: selected.length,
    checkedCount: selected.length,
    statusCounts,
    codeCounts,
    folderStats,
    findings,
    discoveredOutOfSitemap: [...discovered].sort(),
  };
}

function writeJson(filePath, value) {
  ensureParent(filePath);
  writeFileSync(resolve(filePath), `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = stringArg(args, 'base-url', DEFAULT_BASE_URL);
  const sitemapUrl = stringArg(args, 'sitemap', `${baseUrl.replace(/\/$/, '')}/sitemap.xml`);
  const out = stringArg(args, 'out', 'bing-site-tree-report.json');
  if (args['inventory-only']) {
    try {
      const inventory = await collectSitemapInventory({ baseUrl, sitemapUrl, timeoutMs: intArg(args, 'timeout-ms', DEFAULT_TIMEOUT_MS) });
      writeJson(out, inventory);
      console.log(JSON.stringify({ mode: 'inventory', manifestCount: inventory.manifestCount, sitemapCount: inventory.sitemapCount, errors: inventory.errors.length, out }, null, 2));
      if (inventory.errors.length > 0) process.exitCode = 1;
    } catch (error) {
      // Preserve a machine-readable, fail-closed manifest even when the root
      // sitemap itself is invalid or unreachable. The workflow can then upload
      // it and open the backlog issue with the exact coverage failure instead
      // of disappearing before the reporter gets a chance to run.
      const fallback = {
        schemaVersion: CRAWLER_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        baseUrl,
        sitemap: sitemapUrl,
        sitemapCount: 0,
        sitemapUrls: [],
        manifestCount: 0,
        urls: [],
        folders: {},
        partitions: {},
        errors: [{ url: sitemapUrl, error: error?.message || String(error) }],
      };
      writeJson(out, fallback);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
    return;
  }
  if (args['discovered-inventory']) {
    const manifestFile = stringArg(args, 'base-manifest-file', '');
    const reportsDir = stringArg(args, 'reports-dir', 'bing-site-tree-reports');
    if (!manifestFile) throw new Error('specificare --base-manifest-file con --discovered-inventory');
    const manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'));
    const reports = readdirSync(resolve(reportsDir))
      .filter((name) => /^partition-\d+\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(readFileSync(resolve(reportsDir, name), 'utf8')));
    const inventory = collectDiscoveredInventory({
      manifest,
      reports,
      baseUrl,
      partitions: intArg(args, 'partitions', DEFAULT_PARTITIONS),
    });
    writeJson(out, inventory);
    console.log(JSON.stringify({
      mode: 'discovered-frontier',
      sourceDiscoveredCount: inventory.sourceDiscoveredCount,
      manifestCount: inventory.manifestCount,
      excludedByReason: inventory.excludedByReason,
      out,
    }, null, 2));
    return;
  }
  const manifestFile = stringArg(args, 'manifest-file', '');
  if (!manifestFile) throw new Error('specificare --inventory-only oppure --manifest-file');
  const manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'));
  const report = await crawlPartition({
    manifest,
    partition: intArg(args, 'partition', 0),
    partitions: intArg(args, 'partitions', DEFAULT_PARTITIONS),
    concurrency: intArg(args, 'concurrency', DEFAULT_CONCURRENCY),
    timeoutMs: intArg(args, 'timeout-ms', DEFAULT_TIMEOUT_MS),
    retries: intArg(args, 'retries', DEFAULT_RETRIES),
    rescueConcurrency: intArg(args, 'rescue-concurrency', DEFAULT_RESCUE_CONCURRENCY),
    rescueRetries: intArg(args, 'rescue-retries', DEFAULT_RESCUE_RETRIES),
    rescueDelayMs: intArg(args, 'rescue-delay-ms', DEFAULT_RESCUE_DELAY_MS),
    maxBodyBytes: intArg(args, 'max-body-bytes', DEFAULT_MAX_BODY_BYTES),
  });
  writeJson(out, report);
  console.log(JSON.stringify({ mode: 'partition', partition: report.partition, partitions: report.partitions, manifestCount: report.manifestCount, checkedCount: report.checkedCount, findings: report.findings.length, out }, null, 2));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { await main(); }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}

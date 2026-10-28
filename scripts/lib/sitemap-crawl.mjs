/**
 * Sitemap graph discovery shared by the deploy snapshot and IndexNow paths.
 *
 * The site has more than one sitemap index: robots.txt points at the main
 * index, the news sitemap and the canton article index. The main index also
 * grows as build/edge producers add sitemap-*.xml files. Keeping discovery in
 * one module prevents the post-deploy submitter, the batch recovery job and
 * the deploy snapshot from silently using different URL universes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_LIVE_CHECK_USER_AGENT } from './live-link-check.mjs';

export const DEFAULT_SITEMAP_SEEDS = [
  'sitemap.xml',
  'sitemap-news.xml',
  'sitemap-cantons.xml',
];

const DEFAULT_HOST = 'frontaliereticino.ch';
const XML_URL_RE = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
const XML_SITEMAP_RE = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
const XML_LINK_RE = /<[^>]*link\b[^>]*>/gi;

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function attributes(tag) {
  const result = {};
  for (const match of String(tag || '').matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    result[match[1].toLowerCase()] = decodeXml(match[2]);
  }
  return result;
}

function allowedHostSet(host, baseUrl) {
  const values = new Set([String(host || DEFAULT_HOST).toLowerCase()]);
  try {
    values.add(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    // The caller gets a useful URL error from normalizeUrl below.
  }
  return values;
}

export function normalizeUrl(raw, { baseUrl, host = DEFAULT_HOST } = {}) {
  const value = decodeXml(String(raw || '').trim());
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value, baseUrl || `https://${host}`);
  } catch {
    return null;
  }
  const hosts = allowedHostSet(host, baseUrl || `https://${host}`);
  if (!hosts.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

export function sitemapKey(url, { baseUrl } = {}) {
  const parsed = new URL(url, baseUrl);
  const pathname = parsed.pathname.replace(/^\/+/, '');
  return pathname || 'sitemap.xml';
}

function firstLoc(xml) {
  return decodeXml(xml.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1] || '').trim();
}

function lastmodFrom(xml) {
  return decodeXml(xml.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1] || '').trim();
}

function addUrl(target, raw, options) {
  const normalized = normalizeUrl(raw, options);
  if (normalized) target.add(normalized);
  return normalized;
}

/** Parse a sitemap index or URL set without assuming a fixed filename list. */
export function parseSitemapXml(xml, { baseUrl, host = DEFAULT_HOST } = {}) {
  const text = String(xml || '');
  const options = { baseUrl, host };
  const rootMatch = text.match(/<(?:(?:[\w.-]+):)?(sitemapindex|urlset)\b[^>]*>/i);
  if (!rootMatch) {
    throw new Error('Invalid sitemap XML: expected a <sitemapindex> or <urlset> root');
  }
  const urls = new Set();
  const primaryUrls = new Set();
  const alternateUrls = new Set();
  const lastmod = {};
  const referencedSitemaps = new Set();
  const isIndex = rootMatch[1].toLowerCase() === 'sitemapindex';

  if (isIndex) {
    for (const match of text.matchAll(XML_SITEMAP_RE)) {
      const block = match[1];
      addUrl(referencedSitemaps, firstLoc(block), options);
    }
  } else {
    const blocks = [...text.matchAll(XML_URL_RE)].map((match) => match[1]);
    const pageBlocks = blocks.length > 0 ? blocks : [text];
    for (const block of pageBlocks) {
      const pageUrl = addUrl(primaryUrls, firstLoc(block), options);
      if (!pageUrl) continue;
      urls.add(pageUrl);
      const pageLastmod = lastmodFrom(block);
      if (pageLastmod) lastmod[pageUrl] = pageLastmod;

      for (const link of block.matchAll(XML_LINK_RE)) {
        const attrs = attributes(link[0]);
        if (attrs.rel && attrs.rel.toLowerCase() !== 'alternate') continue;
        if (!attrs.href) continue;
        const alternate = addUrl(alternateUrls, attrs.href, options);
        if (alternate && pageLastmod) lastmod[alternate] = pageLastmod;
      }
    }
  }

  const digest = createHash('sha256').update(text).digest('hex');
  return {
    kind: isIndex ? 'index' : 'urlset',
    urls: [...new Set([...urls, ...alternateUrls])].sort(),
    // Consumers that inspect one URL-set entry at a time sometimes need the
    // canonical `<loc>` values without treating hreflang links as additional
    // listings. Keep the union above for the existing crawl/indexing contract,
    // and expose the primary values separately for those consumers.
    primaryUrls: [...primaryUrls].sort(),
    alternateUrls: [...alternateUrls].sort(),
    lastmod: Object.fromEntries(Object.entries(lastmod).sort(([a], [b]) => a.localeCompare(b))),
    referencedSitemaps: [...referencedSitemaps],
    digest,
  };
}

function sitemapUrlsFromText(text, options) {
  const values = [];
  for (const match of String(text || '').matchAll(/(?:^|\n)\s*Sitemap:\s*([^\s#]+)/gi)) {
    const normalized = normalizeUrl(match[1], options);
    if (normalized) values.push(normalized);
  }
  return values;
}

async function fetchLiveText(url, {
  attempts = 3,
  timeoutMs = 15_000,
  retryDelayMs = 1_000,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/xml,text/xml,text/plain',
          'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.text();
      // A sitemap can be referenced by an index before the edge has finished
      // propagating the child object. Treat 404 like the other transient
      // delivery failures here; the caller still fails closed after all
      // attempts, so a genuinely retired sitemap is never silently omitted.
      const retryableStatus = response.status === 404 || response.status === 429 || response.status >= 500;
      if (!retryableStatus || attempt === attempts) return null;
    } catch {
      if (attempt === attempts) return null;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, retryDelayMs * attempt));
  }
  return null;
}

function localRelativePath(value, { baseUrl, host }) {
  let pathname;
  try {
    pathname = new URL(value, baseUrl || `https://${host}`).pathname;
  } catch {
    return null;
  }
  const relative = pathname.replace(/^\/+/, '');
  if (!relative || relative.split('/').includes('..')) return null;
  return relative;
}

function localSitemapSeeds(rootDir, options) {
  const seeds = new Set(DEFAULT_SITEMAP_SEEDS);
  const robotsPath = resolve(rootDir, 'robots.txt');
  if (existsSync(robotsPath)) {
    for (const sitemap of sitemapUrlsFromText(readFileSync(robotsPath, 'utf8'), options)) {
      const relative = localRelativePath(sitemap, options);
      if (relative) seeds.add(relative);
    }
  }
  if (!existsSync(resolve(rootDir, 'sitemap.xml'))) {
    for (const name of readdirSync(rootDir)) {
      if (/^sitemap(?:-[^/]+)?\.xml$/i.test(name)) seeds.add(name);
    }
  }
  return [...seeds];
}

function makeLocalLoader(rootDir, options) {
  return async (url) => {
    const relative = localRelativePath(url, options);
    if (!relative) return null;
    const file = resolve(rootDir, relative);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
}

/**
 * Crawl all reachable same-host sitemap nodes.
 *
 * Live crawls are strict: a sitemap named by robots.txt or another index must
 * be readable, otherwise the caller receives an error instead of submitting a
 * silently truncated URL set. Local crawls are intentionally non-strict because
 * edge-owned sitemap files are not materialized in the build's dist/ directory.
 */
export async function crawlSitemaps({
  baseUrl = `https://${DEFAULT_HOST}`,
  host = DEFAULT_HOST,
  source = 'live',
  rootDir,
  seeds,
  requiredSeeds = ['sitemap.xml'],
  strict = source === 'live',
  fetchAttempts = 3,
  fetchDelayMs = 1_000,
  logger = console,
} = {}) {
  if (source === 'local' && !rootDir) {
    throw new Error('A local sitemap crawl requires rootDir');
  }
  const options = { baseUrl, host };
  const loader = source === 'local'
    ? makeLocalLoader(rootDir, options)
    : (url) => fetchLiveText(url, { attempts: fetchAttempts, retryDelayMs: fetchDelayMs });
  let seedValues;
  if (source === 'local') {
    seedValues = seeds || localSitemapSeeds(rootDir, options);
  } else {
    const robots = await fetchLiveText(new URL('/robots.txt', baseUrl).href);
    seedValues = [...new Set([
      ...(seeds || DEFAULT_SITEMAP_SEEDS),
      ...(robots ? sitemapUrlsFromText(robots, options) : []),
    ])];
  }

  const queue = seedValues.map((value) => normalizeUrl(value, options)).filter(Boolean);
  const queued = new Set(queue);
  const requiredValues = source === 'live' ? seedValues : (requiredSeeds || []);
  const required = new Set(
    requiredValues.map((value) => normalizeUrl(value, options)).filter(Boolean),
  );
  const visited = new Set();
  const records = new Map();
  const missing = [];
  const missingRequired = [];

  while (queue.length > 0) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const xml = await loader(url);
    if (xml == null) {
      const key = sitemapKey(url, options);
      missing.push(key);
      if (required.has(url)) missingRequired.push(key);
      continue;
    }
    const parsed = parseSitemapXml(xml, options);
    const key = sitemapKey(url, options);
    records.set(key, { ...parsed, key, url, xml });
    for (const child of parsed.referencedSitemaps) {
      required.add(child);
      if (!queued.has(child) && !visited.has(child)) {
        queued.add(child);
        queue.push(child);
      }
    }
  }

  if (missingRequired.length > 0 && strict) {
    throw new Error(
      `Sitemap crawl incomplete: ${missingRequired.length} unreachable sitemap(s): ${[...new Set(missingRequired)].sort().join(', ')}`,
    );
  }
  if (missing.length > 0) {
    logger.warn?.(`⚠️ Sitemap crawl skipped ${missing.length} unavailable local/edge sitemap(s): ${[...new Set(missing)].sort().join(', ')}`);
  }

  return {
    version: 3,
    source,
    host,
    baseUrl,
    records,
    missing: [...new Set(missing)].sort(),
    missingRequired: [...new Set(missingRequired)].sort(),
  };
}

export function snapshotFromCrawl(crawl) {
  const perSitemap = {};
  const perSitemapDigests = {};
  const perSitemapLastmod = {};
  const allUrls = new Set();
  for (const [key, record] of [...crawl.records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    perSitemap[key] = record.urls;
    perSitemapDigests[key] = record.digest;
    perSitemapLastmod[key] = record.lastmod;
    for (const url of record.urls) allUrls.add(url);
  }
  return {
    version: 3,
    capturedAt: new Date().toISOString(),
    source: crawl.source,
    host: crawl.host,
    sitemapFiles: Object.keys(perSitemap),
    perSitemap,
    perSitemapDigests,
    perSitemapLastmod,
    missingSitemaps: crawl.missing,
    _allUrls: [...allUrls].sort(),
  };
}

function asSet(value) {
  return new Set(Array.isArray(value) ? value : []);
}

export function snapshotUrls(snapshot) {
  if (Array.isArray(snapshot)) return new Set(snapshot);
  if (snapshot?._allUrls && Array.isArray(snapshot._allUrls)) return asSet(snapshot._allUrls);
  const urls = new Set();
  for (const values of Object.values(snapshot?.perSitemap || {})) {
    for (const url of values || []) urls.add(url);
  }
  return urls;
}

function snapshotPerSitemap(snapshot) {
  if (Array.isArray(snapshot)) return { _legacy_flat: snapshot };
  return snapshot?.perSitemap && typeof snapshot.perSitemap === 'object' ? snapshot.perSitemap : {};
}

/** Return URLs whose sitemap membership, lastmod, or XML payload changed. */
export function changedUrls(
  current,
  previous,
  { includeRemoved = false, includeRemovedFromMissingSitemaps = true } = {},
) {
  const currentPer = snapshotPerSitemap(current);
  const previousPer = snapshotPerSitemap(previous);
  const currentDigests = current?.perSitemapDigests || {};
  const previousDigests = previous?.perSitemapDigests || {};
  const currentLastmods = current?.perSitemapLastmod || {};
  const previousLastmods = previous?.perSitemapLastmod || {};
  const legacyPrevious = Array.isArray(previous) || previous?.version !== 3 || Object.keys(previousDigests).length === 0;
  const changed = new Set();

  if (legacyPrevious && previousPer._legacy_flat) {
    // A flat v1 snapshot has no membership information. Reconcile every
    // current URL on the migration run, and include only genuinely absent old
    // URLs when the caller explicitly asks for removals.
    for (const url of snapshotUrls(current)) changed.add(url);
    if (includeRemoved && includeRemovedFromMissingSitemaps) {
      const now = snapshotUrls(current);
      for (const url of previousPer._legacy_flat) if (!now.has(url)) changed.add(url);
    }
    return [...changed].sort();
  }

  for (const key of Object.keys(currentPer)) {
    const now = asSet(currentPer[key]);
    const before = asSet(previousPer[key]);
    for (const url of now) if (!before.has(url)) changed.add(url);
    if (includeRemoved) for (const url of before) if (!now.has(url)) changed.add(url);

    if (!Object.prototype.hasOwnProperty.call(previousPer, key)) {
      for (const url of now) changed.add(url);
      continue;
    }
    if (legacyPrevious) {
      // A v1/v2 snapshot has no content fingerprint/lastmod metadata. The
      // first run after this fix must be conservative, otherwise an existing
      // page edit could be mistaken for an unchanged URL.
      if (now.size > 0) for (const url of now) changed.add(url);
      continue;
    }
    const nowLastmod = currentLastmods[key] || {};
    const beforeLastmod = previousLastmods[key] || {};
    if (currentDigests[key] === previousDigests[key]) {
      for (const url of now) {
        if ((nowLastmod[url] || '') !== (beforeLastmod[url] || '')) changed.add(url);
      }
      continue;
    }
    // A sitemap digest covers the complete XML block, including alternate,
    // image and news metadata that may not have its own lastmod. Once the
    // payload changes, submit every current URL unless a future per-URL digest
    // can prove a narrower affected set.
    if (now.size > 0) for (const url of now) changed.add(url);
  }

  if (includeRemoved && includeRemovedFromMissingSitemaps) {
    for (const key of Object.keys(previousPer)) {
      if (Object.prototype.hasOwnProperty.call(currentPer, key)) continue;
      for (const url of asSet(previousPer[key])) changed.add(url);
    }
  }

  return [...changed].sort();
}

export function filterSnapshot(snapshot, filters = []) {
  const normalized = filters.map((filter) => String(filter || '').trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return snapshot;
  const selected = {
    ...snapshot,
    perSitemap: {},
    perSitemapDigests: {},
    perSitemapLastmod: {},
    sitemapFiles: [],
    _allUrls: [],
  };
  const all = new Set();
  for (const key of Object.keys(snapshot?.perSitemap || {})) {
    if (!normalized.some((filter) => key.toLowerCase().includes(filter))) continue;
    selected.perSitemap[key] = snapshot.perSitemap[key];
    if (snapshot.perSitemapDigests?.[key]) selected.perSitemapDigests[key] = snapshot.perSitemapDigests[key];
    if (snapshot.perSitemapLastmod?.[key]) selected.perSitemapLastmod[key] = snapshot.perSitemapLastmod[key];
    selected.sitemapFiles.push(key);
    for (const url of snapshot.perSitemap[key] || []) all.add(url);
  }
  selected._allUrls = [...all].sort();
  return selected;
}

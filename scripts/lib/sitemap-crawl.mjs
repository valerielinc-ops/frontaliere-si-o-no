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

// Snapshot file format (v4 NDJSON) lives in its own dependency-free module so
// the validate-dist job, which sparse-checks out only a handful of scripts, can
// read snapshots without pulling in the crawler. Re-exported here so every
// consumer keeps one import surface.
export {
  SNAPSHOT_FORMAT_VERSION,
  readSitemapSnapshot,
  serializeSnapshotChunks,
  writeSnapshotFile,
} from './sitemap-snapshot.mjs';

export const DEFAULT_SITEMAP_SEEDS = [
  'sitemap.xml',
  'sitemap-news.xml',
  'sitemap-cantons.xml',
];

const DEFAULT_HOST = 'frontaliereticino.ch';
export const DEFAULT_LIVE_FETCH_ATTEMPTS = 5;
export const DEFAULT_LIVE_FETCH_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 30_000;
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

function retryAfterMs(response) {
  const value = response.headers.get('Retry-After');
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) {
    return Math.min(Number(value.trim()) * 1_000, MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

async function fetchLiveTextResult(url, {
  attempts = DEFAULT_LIVE_FETCH_ATTEMPTS,
  timeoutMs = 15_000,
  retryDelayMs = DEFAULT_LIVE_FETCH_RETRY_DELAY_MS,
} = {}) {
  let lastResponse = { status: null, cfCacheStatus: null, age: null };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let providerDelay = 0;
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/xml,text/xml,text/plain',
          'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastResponse = {
        status: response.status,
        cfCacheStatus: response.headers.get('cf-cache-status'),
        age: response.headers.get('age'),
      };
      if (response.ok) return { text: await response.text(), ...lastResponse };
      // A sitemap can be referenced by an index before the edge has finished
      // propagating the child object. Treat 404 like the other transient
      // delivery failures here; the caller still fails closed after all
      // attempts, so a genuinely retired sitemap is never silently omitted.
      const retryableStatus = response.status === 404 || response.status === 429 || response.status >= 500;
      if (!retryableStatus || attempt === attempts) return { text: null, ...lastResponse };
      providerDelay = retryAfterMs(response);
    } catch {
      if (attempt === attempts) return { text: null, ...lastResponse };
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(retryDelayMs * attempt, providerDelay)));
  }
  return { text: null, ...lastResponse };
}

async function fetchLiveText(url, options) {
  return (await fetchLiveTextResult(url, options)).text;
}

function withCacheBust(url, cacheBust) {
  const retryUrl = new URL(url);
  retryUrl.searchParams.set('cb', String(cacheBust));
  return retryUrl.href;
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
  fetchAttempts = DEFAULT_LIVE_FETCH_ATTEMPTS,
  fetchDelayMs = DEFAULT_LIVE_FETCH_RETRY_DELAY_MS,
  // Publisher 44007052100 measured apex sitemap XML with s-maxage=86400.
  // Cache-bust pre-deploy requests so the capture reads origin, not stale Cloudflare edge content.
  liveCacheBust = '',
  tolerateMissing,
  unreachableRetry,
  logger = console,
} = {}) {
  if (source === 'local' && !rootDir) {
    throw new Error('A local sitemap crawl requires rootDir');
  }
  const options = { baseUrl, host };
  const loader = source === 'local'
    ? makeLocalLoader(rootDir, options)
    : (url, { retry = false, cacheBust = liveCacheBust } = {}) => fetchLiveTextResult(
      retry || liveCacheBust ? withCacheBust(url, retry ? cacheBust : liveCacheBust) : url,
      {
        attempts: retry ? 1 : fetchAttempts,
        retryDelayMs: retry ? 0 : fetchDelayMs,
      },
    );
  let seedValues;
  if (source === 'local') {
    seedValues = seeds || localSitemapSeeds(rootDir, options);
  } else {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const robots = await fetchLiveText(liveCacheBust ? withCacheBust(robotsUrl, liveCacheBust) : robotsUrl);
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
  const parentByChild = new Map();
  const missing = [];
  const missingRequired = [];
  const toleratedByKey = new Map();
  const retryConfig = unreachableRetry && typeof unreachableRetry === 'object'
    ? { attempts: 2, delaysMs: [30_000, 90_000], cacheBust: '', ...unreachableRetry }
    : null;

  while (queue.length > 0) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const loaded = await loader(url);
    let fetchResult = typeof loaded === 'string'
      ? { text: loaded, status: null, cfCacheStatus: null, age: null }
      : loaded || { text: null, status: null, cfCacheStatus: null, age: null };
    const key = sitemapKey(url, options);
    const isRequired = required.has(url);
    const mayTolerate = strict && isRequired
      && typeof tolerateMissing === 'function'
      && tolerateMissing(key);
    if (fetchResult.text == null && mayTolerate && retryConfig) {
      let recovered = false;
      let lastHttpResponse = fetchResult;
      const attempts = Math.max(0, Math.floor(Number(retryConfig.attempts) || 0));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const delayMs = Math.max(0, Number(retryConfig.delaysMs?.[attempt]) || 0);
        if (delayMs > 0) await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
        const retryResult = await loader(url, { retry: true, cacheBust: retryConfig.cacheBust });
        if (retryResult.status !== null) lastHttpResponse = retryResult;
        if (retryResult.text != null) {
          fetchResult = retryResult;
          recovered = true;
          logger.warn?.(`⚠️ recovered on retry: ${key}`);
          break;
        }
      }
      if (!recovered) {
        const parent = parentByChild.get(url) ?? null;
        if (!toleratedByKey.has(key)) {
          toleratedByKey.set(key, {
            key,
            parent,
            status: lastHttpResponse.status,
            cfCacheStatus: lastHttpResponse.cfCacheStatus,
            age: lastHttpResponse.age,
          });
        }
      }
    }
    const xml = fetchResult.text;
    if (xml == null) {
      if (toleratedByKey.has(key)) continue;
      missing.push(key);
      if (isRequired) missingRequired.push(key);
      continue;
    }
    const parsed = parseSitemapXml(xml, options);
    // The raw XML is deliberately NOT retained: no consumer reads it after the
    // parse, and on the full local graph it doubled the crawl's resident set
    // (about 480 MB of strings beside the parsed URL lists).
    records.set(key, { ...parsed, key, url });
    for (const child of parsed.referencedSitemaps) {
      required.add(child);
      if (!parentByChild.has(child)) parentByChild.set(child, key);
      if (!queued.has(child) && !visited.has(child)) {
        queued.add(child);
        queue.push(child);
      }
    }
  }

  const toleratedMissing = [...toleratedByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (toleratedMissing.length > 0) {
    const details = toleratedMissing.map(({ key, parent, status }) =>
      `${key} (parent: ${parent ?? 'unknown'}, status: ${status ?? 'unknown'})`).join('; ');
    logger.warn?.(`⚠️ Sitemap crawl tolerated ${toleratedMissing.length} unreachable expired-archive sitemap(s): ${details}`);
  }
  const nonToleratedMissingRequired = [...new Set(missingRequired)]
    .filter((key) => !toleratedByKey.has(key))
    .sort();
  if (nonToleratedMissingRequired.length > 0 && strict) {
    throw new Error(
      `Sitemap crawl incomplete: ${nonToleratedMissingRequired.length} unreachable sitemap(s): ${nonToleratedMissingRequired.join(', ')}`,
    );
  }
  if (missing.length > 0 && !strict) {
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
    toleratedMissing,
  };
}

export function snapshotFromCrawl(crawl, { includeDerivedIndexes = true } = {}) {
  const perSitemap = {};
  const perSitemapDigests = {};
  const perSitemapLastmod = includeDerivedIndexes ? {} : null;
  const allUrls = includeDerivedIndexes ? new Set() : null;
  for (const [key, record] of [...crawl.records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    perSitemap[key] = record.urls;
    perSitemapDigests[key] = record.digest;
    if (includeDerivedIndexes) {
      perSitemapLastmod[key] = record.lastmod;
      for (const url of record.urls) allUrls.add(url);
    }
  }
  const snapshot = {
    version: 3,
    capturedAt: new Date().toISOString(),
    source: crawl.source,
    host: crawl.host,
    sitemapFiles: Object.keys(perSitemap),
    perSitemap,
    perSitemapDigests,
    missingSitemaps: crawl.missing,
  };
  if (includeDerivedIndexes) {
    snapshot.perSitemapLastmod = perSitemapLastmod;
    snapshot._allUrls = [...allUrls].sort();
  }
  return snapshot;
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

function hasSitemapMembership(snapshot) {
  return !Array.isArray(snapshot)
    && snapshot?.perSitemap
    && typeof snapshot.perSitemap === 'object'
    && !Array.isArray(snapshot.perSitemap);
}

function missingSitemapKeys(snapshot) {
  if (Array.isArray(snapshot) || !Array.isArray(snapshot?.missingSitemaps)) return new Set();
  // The canton index is an edge-owned article surface, not a job sitemap. It
  // may be absent from the local post-build crawl without making the job
  // sitemap membership incomplete. Every other missing sitemap remains
  // evidence that archive-only classification is unsafe.
  return new Set(snapshot.missingSitemaps.filter((key) => key !== 'sitemap-cantons.xml'));
}

// A missing job sitemap in EITHER snapshot makes the URL membership incomplete:
// a URL that lives in a regular sitemap could then look archive-only and be
// deferred behind the whole archive. Only known non-job surfaces are removed
// by missingSitemapKeys above; identical unknown gaps are not authoritative.
function hasUnstableMissingSitemaps(current, previous) {
  const currentMissing = missingSitemapKeys(current);
  const previousMissing = missingSitemapKeys(previous);
  return currentMissing.size > 0 || previousMissing.size > 0;
}

function archiveOnlyCurrentUrls(currentPer, current, previous, digestIgnoredSitemap) {
  if (typeof digestIgnoredSitemap !== 'function' || !hasSitemapMembership(current)) return new Set();
  if (hasUnstableMissingSitemaps(current, previous)) return new Set();

  const archiveUrls = new Set();
  for (const [key, urls] of Object.entries(currentPer)) {
    if (!digestIgnoredSitemap(key)) continue;
    for (const url of asSet(urls)) archiveUrls.add(url);
  }
  for (const [key, urls] of Object.entries(currentPer)) {
    if (digestIgnoredSitemap(key)) continue;
    for (const url of asSet(urls)) archiveUrls.delete(url);
  }
  return archiveUrls;
}

function changedUrlsWithArchiveAddedLast(changed, current, previous, digestIgnoredSitemap) {
  const sorted = [...changed].sort();
  const archiveOnlyUrls = archiveOnlyCurrentUrls(snapshotPerSitemap(current), current, previous, digestIgnoredSitemap);
  if (archiveOnlyUrls.size === 0) return sorted;

  const previousUrls = snapshotUrls(previous);
  const addedArchive = sorted.filter((url) => archiveOnlyUrls.has(url) && !previousUrls.has(url));
  if (addedArchive.length === 0) return sorted;

  const addedArchiveSet = new Set(addedArchive);
  return [...sorted.filter((url) => !addedArchiveSet.has(url)), ...addedArchive];
}

/** Return URLs whose sitemap membership, lastmod, or XML payload changed. */
export function changedUrls(
  current,
  previous,
  {
    includeRemoved = false,
    includeRemovedFromMissingSitemaps = true,
    digestIgnoredSitemap,
  } = {},
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
    return changedUrlsWithArchiveAddedLast(changed, current, previous, digestIgnoredSitemap);
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
      // Large publisher snapshots can omit the URL-indexed lastmod map. When
      // it is present on both sides, retain the finer-grained comparison; when
      // absent, the sitemap digest remains authoritative for embedded XML data.
      if (Object.keys(nowLastmod).length > 0 && Object.keys(beforeLastmod).length > 0) {
        for (const url of now) {
          if ((nowLastmod[url] || '') !== (beforeLastmod[url] || '')) changed.add(url);
        }
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

  return changedUrlsWithArchiveAddedLast(changed, current, previous, digestIgnoredSitemap);
}

/** Return changed URLs grouped by graph-level priority without double-counting. */
export function changedUrlTiers(
  current,
  previous,
  {
    includeRemoved = false,
    includeRemovedFromMissingSitemaps = true,
    digestIgnoredSitemap,
  } = {},
) {
  const currentPer = snapshotPerSitemap(current);
  const previousPer = snapshotPerSitemap(previous);
  const currentDigests = current?.perSitemapDigests || {};
  const previousDigests = previous?.perSitemapDigests || {};
  const currentLastmods = current?.perSitemapLastmod || {};
  const previousLastmods = previous?.perSitemapLastmod || {};
  const legacy = Array.isArray(previous) || previous?.version !== 3 || Object.keys(previousDigests).length === 0;
  const currentUrls = snapshotUrls(current);
  const previousUrls = snapshotUrls(previous);
  let added = [...currentUrls].filter((url) => !previousUrls.has(url)).sort();

  const removedSet = new Set();
  if (includeRemoved) {
    if (Array.isArray(previous)) {
      if (includeRemovedFromMissingSitemaps) {
        for (const url of previous) if (!currentUrls.has(url)) removedSet.add(url);
      }
    } else {
      for (const key of Object.keys(previousPer)) {
        if (!includeRemovedFromMissingSitemaps && !Object.prototype.hasOwnProperty.call(currentPer, key)) continue;
        for (const url of asSet(previousPer[key])) {
          if (!currentUrls.has(url)) removedSet.add(url);
        }
      }
    }
  }
  const removed = [...removedSet].sort();

  // Classify the original additions before splitting the archive-only last tier.
  const alreadyClassified = new Set([...added, ...removed]);
  const currentArchiveUrls = new Set();
  const previousArchiveUrls = new Set();
  const hasCurrentSitemapMembership = hasSitemapMembership(current);
  const hasPreviousSitemapMembership = hasSitemapMembership(previous);
  if (typeof digestIgnoredSitemap === 'function' && hasCurrentSitemapMembership && hasPreviousSitemapMembership) {
    for (const [key, urls] of Object.entries(currentPer)) {
      if (!digestIgnoredSitemap(key)) continue;
      for (const url of asSet(urls)) currentArchiveUrls.add(url);
    }
    for (const [key, urls] of Object.entries(previousPer)) {
      if (!digestIgnoredSitemap(key)) continue;
      for (const url of asSet(urls)) previousArchiveUrls.add(url);
    }
  }
  const movedIntoArchive = [...currentArchiveUrls]
    .filter((url) => previousUrls.has(url) && !previousArchiveUrls.has(url))
    .sort();
  const movedOutOfArchive = [...previousArchiveUrls]
    .filter((url) => currentUrls.has(url) && !currentArchiveUrls.has(url))
    .sort();
  for (const url of movedIntoArchive) alreadyClassified.add(url);
  for (const url of movedOutOfArchive) alreadyClassified.add(url);

  const currentArchiveOnlyUrls = archiveOnlyCurrentUrls(currentPer, current, previous, digestIgnoredSitemap);
  const addedArchive = added.filter((url) => currentArchiveOnlyUrls.has(url));
  added = added.filter((url) => !currentArchiveOnlyUrls.has(url));

  const lastmodSet = new Set();
  for (const key of Object.keys(currentPer)) {
    if (!Object.prototype.hasOwnProperty.call(previousPer, key)) continue;
    const nowLastmod = currentLastmods[key] || {};
    const beforeLastmod = previousLastmods[key] || {};
    if (Object.keys(nowLastmod).length === 0 || Object.keys(beforeLastmod).length === 0) continue;
    for (const url of asSet(currentPer[key])) {
      if (alreadyClassified.has(url)) continue;
      if ((nowLastmod[url] || '') !== (beforeLastmod[url] || '')) lastmodSet.add(url);
    }
  }
  const lastmod = [...lastmodSet].sort();
  for (const url of lastmod) alreadyClassified.add(url);

  const digestBySitemap = {};
  const suppressedSitemaps = new Set();
  const suppressedUrls = new Set();
  for (const key of Object.keys(currentPer).sort()) {
    const digestChanged = legacy
      || !Object.prototype.hasOwnProperty.call(previousPer, key)
      || currentDigests[key] !== previousDigests[key];
    if (!digestChanged) continue;

    const urls = [...asSet(currentPer[key])].sort();
    if (typeof digestIgnoredSitemap === 'function' && digestIgnoredSitemap(key)) {
      suppressedSitemaps.add(key);
      for (const url of urls) {
        if (!alreadyClassified.has(url)) suppressedUrls.add(url);
      }
      continue;
    }

    const affected = urls.filter((url) => !alreadyClassified.has(url));
    digestBySitemap[key] = affected;
  }

  return {
    added,
    addedArchive,
    removed,
    movedIntoArchive,
    movedOutOfArchive,
    lastmod,
    digestBySitemap,
    suppressedDigest: { sitemaps: suppressedSitemaps.size, urls: suppressedUrls.size },
    legacy,
  };
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

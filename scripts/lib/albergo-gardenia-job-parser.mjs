#!/usr/bin/env node
/**
 * Albergo Gardenia authoritative source-state reader.
 *
 * The hotel does not publish vacancies today. Its legacy website has no
 * dedicated careers endpoint, so an empty snapshot is authoritative only
 * after every content page advertised by its sitemap has been fetched and
 * checked. Any incomplete inventory or newly observed career signal fails
 * closed and leaves the previous slice untouched.
 */
import { JSDOM } from 'jsdom';
import { CAREER_TOKEN_RX } from './prospector/config.mjs';
import { decodeEntities } from './prospector/entities.mjs';
import { politeFetch } from './prospector/polite-fetch.mjs';

export const ALBERGO_GARDENIA_KEY = 'albergo-gardenia';
export const ALBERGO_GARDENIA_COMPANY_NAME = 'Albergo Gardenia';
export const ALBERGO_GARDENIA_COMPANY_DOMAIN = 'albergo-gardenia.ch';
export const ALBERGO_GARDENIA_HOME_URL = 'https://www.albergo-gardenia.ch/';
export const ALBERGO_GARDENIA_SITEMAP_URL = 'https://www.albergo-gardenia.ch/sitemap.xml';

export const ALBERGO_GARDENIA_FETCH_BUDGET = Object.freeze({
  sitemap: Object.freeze({ timeoutMs: 20_000, retries: 4, retryBaseMs: 1_500 }),
  content: Object.freeze({ timeoutMs: 15_000, retries: 2, retryBaseMs: 750 }),
});

const MIN_SITEMAP_URLS = 50;
const MIN_CONTENT_URLS = 40;
const CONTENT_PATH_RX = /^\/(?:index|story)\.php$/i;
const EXPECTED_BRAND_RX = /(?:albergo|villa|garni)\s+gardenia/i;
const GARDENIA_APEX_HOST = ALBERGO_GARDENIA_COMPANY_DOMAIN;
const GARDENIA_WWW_HOST = `www.${ALBERGO_GARDENIA_COMPANY_DOMAIN}`;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isAlbergoGardeniaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');

  return (
    key === ALBERGO_GARDENIA_KEY
    || key.startsWith('albergo-gardenia')
    || company.includes('albergo gardenia')
    || isTrustedDomain(job?.url)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === ALBERGO_GARDENIA_COMPANY_DOMAIN
      || host.endsWith(`.${ALBERGO_GARDENIA_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

function isSameGardeniaResource(leftUrl, rightUrl) {
  try {
    const left = new URL(leftUrl);
    const right = new URL(rightUrl);
    return isTrustedDomain(left.href)
      && isTrustedDomain(right.href)
      && left.pathname === right.pathname
      && left.search === right.search;
  } catch {
    return false;
  }
}

function gardeniaTransportCandidates(rawUrl) {
  const primary = new URL(rawUrl);
  const alternate = new URL(primary);
  alternate.hostname = primary.hostname === GARDENIA_WWW_HOST
    ? GARDENIA_APEX_HOST
    : GARDENIA_WWW_HOST;
  return alternate.href === primary.href ? [primary.href] : [primary.href, alternate.href];
}

function gardeniaFetchError(resource, response, sourceUrl = '') {
  const status = Number(response?.status || 0);
  /** @type {Error & { status?: number, code?: string }} */
  const error = new Error(
    `Albergo Gardenia ${resource} fetch failed${sourceUrl ? ` for ${sourceUrl}` : ''} (${status})`,
  );
  // crawler-template may preserve data on connection-level failures. Tag every
  // response/policy outcome (including deterministic status 0 denials) so only
  // a genuine no-response exhaustion can enter that soft-exit branch.
  if (status > 0 || response?.blockedByRobots || response?.policyBlocked) {
    error.status = status;
  }
  if (response?.policyBlocked) error.code = 'ERR_PUBLIC_FETCH_POLICY';
  return error;
}

/**
 * Fetch one bounded Gardenia source resource. The live host is served through
 * a two-hop CNAME chain and has intermittently timed out from GitHub Actions.
 * Give the slow origin an explicit per-attempt budget and, only after a pure
 * connection-level exhaustion (status 0), retry the byte-identical apex/www
 * host alias. HTTP responses, robots denials and URL-policy failures never
 * cross the alias boundary: those are authoritative failures, not transport
 * noise. The caller still validates resource identity and source content.
 *
 * @param {string} rawUrl
 * @param {{ kind?: 'sitemap'|'content', fetchPage?: typeof politeFetch }} [runtime]
 */
export async function fetchAlbergoGardeniaSourcePage(
  rawUrl,
  { kind = 'content', fetchPage = politeFetch } = {},
) {
  const budget = ALBERGO_GARDENIA_FETCH_BUDGET[kind];
  if (!budget) throw new TypeError(`Unknown Albergo Gardenia fetch budget: ${kind}`);

  let last = null;
  for (const [index, candidateUrl] of gardeniaTransportCandidates(rawUrl).entries()) {
    const response = await fetchPage(candidateUrl, {
      ...budget,
      ...(kind === 'sitemap' ? { accept: 'application/xml,text/xml,*/*' } : {}),
    });
    last = response;
    if (response?.ok) return response;

    const connectionFailure = Number(response?.status || 0) === 0
      && !response?.blockedByRobots
      && !response?.policyBlocked;
    if (!connectionFailure) return response;
    if (index === 0) {
      console.warn(`  ⚠️ Gardenia origin connection exhausted for ${candidateUrl}; trying the canonical host alias.`);
    }
  }
  return last;
}

function decodeSitemapLocation(value = '') {
  let decoded = String(value).trim();
  // The live sitemap double-encodes query separators as `&amp;amp;`.
  // Decode to a fixed point instead of teaching URL identity about bad XML.
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntities(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/**
 * Parse and prove the bounded website inventory advertised by Gardenia.
 *
 * @param {string} xml
 * @returns {{ allUrls: string[], contentUrls: string[] }}
 */
export function parseAlbergoGardeniaSitemap(xml = '') {
  const locations = [...String(xml).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeSitemapLocation(match[1]));
  if (locations.length < MIN_SITEMAP_URLS) {
    throw new Error(`Albergo Gardenia sitemap is incomplete (${locations.length} < ${MIN_SITEMAP_URLS})`);
  }

  const allUrls = [];
  const seen = new Set();
  for (const rawUrl of locations) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Albergo Gardenia sitemap contains an invalid URL: ${rawUrl}`);
    }
    if (parsed.protocol !== 'https:' || !isTrustedDomain(parsed.href)) {
      throw new Error(`Albergo Gardenia sitemap escaped the trusted source: ${parsed.href}`);
    }
    parsed.hash = '';
    const normalized = parsed.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      allUrls.push(normalized);
    }
  }
  if (allUrls.length !== locations.length) {
    throw new Error(`Albergo Gardenia sitemap contains duplicate identities (${locations.length - allUrls.length})`);
  }

  const contentUrls = allUrls.filter((url) => CONTENT_PATH_RX.test(new URL(url).pathname));
  if (contentUrls.length < MIN_CONTENT_URLS) {
    throw new Error(`Albergo Gardenia content inventory is incomplete (${contentUrls.length} < ${MIN_CONTENT_URLS})`);
  }
  if (allUrls.some((url) => CAREER_TOKEN_RX.test(new URL(url).pathname))) {
    throw new Error('Albergo Gardenia sitemap now advertises a career surface');
  }
  return { allUrls, contentUrls };
}

/**
 * Reject a newly introduced vacancy/career surface. We deliberately inspect
 * semantic headings and links rather than arbitrary body prose: old hotel
 * pages can mention work/jobs conversationally, while a navigable career
 * surface must expose a heading, link or structured JobPosting.
 *
 * @param {string} html
 * @param {string} pageUrl
 */
export function assertNoGardeniaCareerSurface(html = '', pageUrl = '') {
  const dom = new JSDOM(html, { url: pageUrl });
  try {
    const document = dom.window.document;
    const title = String(document.title || '').replace(/\s+/g, ' ').trim();
    if (!EXPECTED_BRAND_RX.test(title)) {
      throw new Error(`Albergo Gardenia source identity is missing at ${pageUrl}`);
    }

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (/"@type"\s*:\s*"JobPosting"/i.test(script.textContent || '')) {
        throw new Error(`Albergo Gardenia JobPosting detected at ${pageUrl}`);
      }
    }

    const semanticNodes = document.querySelectorAll('title, h1, h2, h3, a[href]');
    for (const node of semanticNodes) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      const href = node.tagName === 'A' ? String(node.getAttribute('href') || '') : '';
      if (CAREER_TOKEN_RX.test(text) || (href && CAREER_TOKEN_RX.test(href))) {
        throw new Error(`Albergo Gardenia career signal detected at ${pageUrl}`);
      }
    }
  } finally {
    dom.window.close();
  }
}

function markAuthoritativeEmptySnapshot(jobs, sourcePageCount) {
  Object.defineProperties(jobs, {
    gardeniaSnapshotState: { value: 'authoritative-site-zero', enumerable: false },
    discoveredCount: { value: 0, enumerable: false },
    sourcePageCount: { value: sourcePageCount, enumerable: false },
  });
  return jobs;
}

export function assertCompleteAlbergoGardeniaSnapshot(jobs) {
  if (
    !Array.isArray(jobs)
    || jobs.length !== 0
    || Reflect.get(jobs, 'gardeniaSnapshotState') !== 'authoritative-site-zero'
    || Number(Reflect.get(jobs, 'sourcePageCount')) < MIN_CONTENT_URLS
  ) {
    throw new Error('Albergo Gardenia snapshot is not a proven authoritative empty state');
  }
  return true;
}

/**
 * @param {{ fetchPage?: typeof politeFetch }} [runtime]
 */
export async function fetchAllAlbergoGardeniaJobs({ fetchPage = politeFetch } = {}) {
  console.log('🔍 Fetching Albergo Gardenia authoritative site inventory');
  console.log(`   Sitemap: ${ALBERGO_GARDENIA_SITEMAP_URL}\n`);

  const sitemap = await fetchAlbergoGardeniaSourcePage(ALBERGO_GARDENIA_SITEMAP_URL, {
    kind: 'sitemap',
    fetchPage,
  });
  if (!sitemap?.ok || !isSameGardeniaResource(
    sitemap.url || ALBERGO_GARDENIA_SITEMAP_URL,
    ALBERGO_GARDENIA_SITEMAP_URL,
  )) {
    throw gardeniaFetchError('sitemap', sitemap);
  }
  const { allUrls, contentUrls } = parseAlbergoGardeniaSitemap(sitemap.body);

  for (const sourceUrl of contentUrls) {
    const page = await fetchAlbergoGardeniaSourcePage(sourceUrl, { kind: 'content', fetchPage });
    if (!page?.ok || !isTrustedDomain(page.url || '')) {
      const error = gardeniaFetchError('content', page, sourceUrl);
      throw error;
    }
    if (!isSameGardeniaResource(page.url, sourceUrl)) {
      throw new Error(`Albergo Gardenia content redirected outside its inventory: ${sourceUrl} -> ${page.url}`);
    }
    assertNoGardeniaCareerSurface(page.body, page.url);
  }

  console.log(`  ✅ ${allUrls.length} sitemap URLs; ${contentUrls.length} content pages; 0 vacancy surfaces.`);
  return markAuthoritativeEmptySnapshot([], contentUrls.length);
}

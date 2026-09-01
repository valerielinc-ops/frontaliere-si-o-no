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

const MIN_SITEMAP_URLS = 50;
const MIN_CONTENT_URLS = 40;
const CONTENT_PATH_RX = /^\/(?:index|story)\.php$/i;
const EXPECTED_BRAND_RX = /(?:albergo|villa|garni)\s+gardenia/i;

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

  const sitemap = await fetchPage(ALBERGO_GARDENIA_SITEMAP_URL, {
    accept: 'application/xml,text/xml,*/*',
  });
  if (!sitemap?.ok || !isTrustedDomain(sitemap.url || ALBERGO_GARDENIA_SITEMAP_URL)) {
    throw new Error(`Albergo Gardenia sitemap fetch failed (${sitemap?.status || 0})`);
  }
  const { allUrls, contentUrls } = parseAlbergoGardeniaSitemap(sitemap.body);

  for (const sourceUrl of contentUrls) {
    const page = await fetchPage(sourceUrl);
    if (!page?.ok || !isTrustedDomain(page.url || '')) {
      throw new Error(`Albergo Gardenia content fetch failed for ${sourceUrl} (${page?.status || 0})`);
    }
    const expectedIdentity = new URL(sourceUrl).href;
    if (new URL(page.url).href !== expectedIdentity) {
      throw new Error(`Albergo Gardenia content redirected outside its inventory: ${sourceUrl} -> ${page.url}`);
    }
    assertNoGardeniaCareerSurface(page.body, page.url);
  }

  console.log(`  ✅ ${allUrls.length} sitemap URLs; ${contentUrls.length} content pages; 0 vacancy surfaces.`);
  return markAuthoritativeEmptySnapshot([], contentUrls.length);
}

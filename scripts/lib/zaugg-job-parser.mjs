#!/usr/bin/env node
/**
 * ZAUGG AG's welding vacancy, read only from the employer's official site.
 *
 * The official listing uses query-string detail IDs and image/card links with
 * no anchor text. Its extraction contract therefore lives in the adjacent
 * source-backed spec instead of the generic URL-template extractor.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, normalizeSpace, slugify, stripHtml } from './crawler-template.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { extractStableJobId } from './job-match-key.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';

export const ZAUGG_SOURCE_SPEC = JSON.parse(readFileSync(
  new URL('../../data/prospector/crawlers/zaugg.json', import.meta.url),
  'utf8',
));

// Keep the writer key statically visible to crawler-manifest-slice-key.test.ts;
// the JSON spec remains the source-backed contract and is checked below.
export const ZAUGG_KEY = 'zaugg';
if (ZAUGG_SOURCE_SPEC.companyKey !== ZAUGG_KEY) {
  throw new Error(`ZAUGG source spec companyKey drifted from ${ZAUGG_KEY}`);
}
export const ZAUGG_COMPANY_NAME = ZAUGG_SOURCE_SPEC.companyName;
export const ZAUGG_COMPANY_DOMAIN = ZAUGG_SOURCE_SPEC.companyHost;
const CAREER_URL = ZAUGG_SOURCE_SPEC.seedUrls[0];
const SOURCE_SELECTORS = ZAUGG_SOURCE_SPEC.selectors;
const SOURCE_LOCATION = ZAUGG_SOURCE_SPEC.location;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeTitle(value = '') {
  return normalizeSpace(String(value || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function officialUrl(rawUrl, baseUrl = CAREER_URL) {
  let url;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    throw new Error(`ZAUGG source returned an invalid vacancy URL: ${String(rawUrl || '')}`);
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.zaugg.swiss') {
    throw new Error(`ZAUGG source returned a non-official vacancy URL: ${url.origin}`);
  }
  return url;
}

function detailIdFromUrl(rawUrl) {
  const url = officialUrl(rawUrl);
  const id = url.searchParams.get(ZAUGG_SOURCE_SPEC.detailIdParameter);
  if (url.pathname !== '/' || !/^\d+$/.test(id || '')
      || url.searchParams.get(ZAUGG_SOURCE_SPEC.detailFlagParameter) !== '1') {
    throw new Error('ZAUGG vacancy URL no longer matches the official detail-link contract');
  }
  return id;
}

/**
 * Match only the employer's welding role, not other ZAUGG openings.
 * The required material words make title suffix changes harmless while
 * preventing a generic "Schweisser" mention from widening this assignment.
 */
export function isZauggTargetRoleTitle(title = '') {
  const value = normalizeTitle(title);
  return /\bschweisser\b/.test(value)
    && /\bstahl\b/.test(value)
    && /\balu\b/.test(value)
    && /\binox\b/.test(value);
}

/** Parse the employer's recognized open-positions container. */
export function extractZauggListingCards(html, baseUrl = CAREER_URL) {
  const pageUrl = officialUrl(baseUrl);
  const dom = new JSDOM(String(html || ''), { url: pageUrl.href });
  try {
    const container = dom.window.document.querySelector(SOURCE_SELECTORS.listingContainer);
    if (!container) {
      throw new Error('ZAUGG official listing container was not found; refusing an unproven zero');
    }

    const anchors = [...container.querySelectorAll(SOURCE_SELECTORS.listingLinks)];
    if (anchors.length === 0) {
      throw new Error('ZAUGG official listing container has no recognized detail links; refusing an unproven zero');
    }

    const byId = new Map();
    for (const anchor of anchors) {
      const title = normalizeSpace(anchor.textContent || '');
      const url = officialUrl(anchor.getAttribute('href') || '', pageUrl.href);
      const sourceId = detailIdFromUrl(url.href);
      const previous = byId.get(sourceId);
      if (!title) {
        if (!previous) byId.set(sourceId, { title: '', url: url.href, sourceId });
        continue;
      }
      if (previous?.title && normalizeTitle(previous.title) !== normalizeTitle(title)) {
        throw new Error(`ZAUGG official listing gave conflicting titles for detail id ${sourceId}`);
      }
      byId.set(sourceId, { title, url: url.href, sourceId });
    }
    const cards = [...byId.values()];
    const untitled = cards.find((card) => !card.title);
    if (untitled) {
      throw new Error(`ZAUGG official detail id ${untitled.sourceId} has no title-bearing link`);
    }
    return cards;
  } finally {
    dom.window.close();
  }
}

function normalizeSourceDate(rawDate = '') {
  const value = normalizeSpace(rawDate);
  // The official German page prefixes the employer-supplied calendar date
  // with a weekday (e.g. "Montag 14 Jul 2025"). Keep the date itself intact.
  return value.replace(
    /^(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\s+(?=\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$)/i,
    '',
  );
}

export function parseZauggSourceDate(rawDate = '') {
  return sourcePostingDateFields(normalizeSourceDate(rawDate));
}

function parseRequiredZauggSourceDate(rawDate = '') {
  const sourceDate = parseZauggSourceDate(rawDate);
  if (sourceDate.postingDateSource !== 'reported') {
    throw new Error('ZAUGG detail page has no valid source-backed posting date');
  }
  return sourceDate;
}

/** Keep the job copy while excluding recruiter contact details from output. */
export function sanitizeZauggDescription(rawText = '') {
  const withoutEmail = String(rawText || '').replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    '',
  );
  return normalizeSpace(stripContactPII(withoutEmail));
}

/** Parse and validate one target detail page before it can become a job row. */
export function parseZauggDetailPage(html, detailUrl) {
  const detailPageUrl = officialUrl(detailUrl);
  const expectedId = detailIdFromUrl(detailPageUrl.href);
  const dom = new JSDOM(String(html || ''), { url: detailPageUrl.href });
  try {
    const document = dom.window.document;
    const title = normalizeSpace(document.querySelector(SOURCE_SELECTORS.detailTitle)?.textContent || '');
    if (!isZauggTargetRoleTitle(title)) {
      throw new Error('ZAUGG detail page does not prove the requested welding role');
    }

    const canonical = normalizeSpace(
      document.querySelector('meta[property="og:url"]')?.getAttribute('content') || '',
    );
    if (!canonical) {
      throw new Error('ZAUGG detail page has no source-backed og:url vacancy identity');
    }
    const canonicalUrl = officialUrl(canonical, detailPageUrl.href);
    if (detailIdFromUrl(canonicalUrl.href) !== expectedId) {
      throw new Error('ZAUGG detail canonical URL points to a different vacancy');
    }

    const descriptionElement = document.querySelector(SOURCE_SELECTORS.detailDescription);
    const description = sanitizeZauggDescription(stripHtml(descriptionElement?.innerHTML || ''));
    if (!descriptionElement || !meetsSourceBodyFloor(description)) {
      throw new Error('ZAUGG detail body is missing or below the shared 50-word source floor');
    }

    const sourceLocation = normalizeTitle(SOURCE_LOCATION.city);
    if (!normalizeTitle(description).includes(sourceLocation)) {
      throw new Error('ZAUGG detail body no longer source-backs the configured workplace');
    }
    const canton = inferSwissTargetCanton(SOURCE_LOCATION.city);
    if (!canton || canton !== SOURCE_LOCATION.canton) {
      throw new Error('ZAUGG workplace no longer resolves to its configured Swiss canton');
    }

    const dateText = normalizeSpace(document.querySelector(SOURCE_SELECTORS.postingDate)?.textContent || '');
    const sourceDate = parseRequiredZauggSourceDate(dateText);
    return {
      title,
      description,
      location: SOURCE_LOCATION.city,
      canton,
      sourceDate,
    };
  } finally {
    dom.window.close();
  }
}

function buildZauggJob(listing, detail) {
  const sourceUrl = officialUrl(listing.url).href;
  const stableSourceId = extractStableJobId(sourceUrl);
  if (!stableSourceId) throw new Error('ZAUGG vacancy URL has no stable source identity');
  const stableHash = createHash('sha1').update(stableSourceId).digest('hex').slice(0, 12);
  const sourceLang = detectLang(detail.description || detail.title, ZAUGG_SOURCE_SPEC.sourceLang);
  const jobSlug = slugify(`${detail.title} ${detail.location} zaugg ch`);
  const hq = getCompanyDefaults(ZAUGG_KEY);
  if (!hq || hq.city !== detail.location || hq.canton !== detail.canton) {
    throw new Error('ZAUGG source-backed location is missing from the company location registry');
  }

  return {
    id: `${ZAUGG_KEY}-${stableHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: ZAUGG_COMPANY_NAME,
    companyKey: ZAUGG_KEY,
    companyDomain: ZAUGG_COMPANY_DOMAIN,
    title: detail.title,
    titleByLocale: { [sourceLang]: detail.title },
    description: detail.description,
    descriptionByLocale: { [sourceLang]: detail.description },
    location: detail.location,
    canton: detail.canton,
    url: sourceUrl,
    source: 'ZAUGG AG official careers page',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: hq.city,
    addressRegion: hq.addressRegion,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: hq.postalCode,
    sector: 'Altro',
    contract: 'other',
    employmentType: 'OTHER',
    featured: false,
    ...detail.sourceDate,
    applyUrl: sourceUrl,
  };
}

/**
 * Check whether a job belongs to this employer. Job URLs are parsed as URLs,
 * not substring-matched, so a lookalike host cannot pass the contract.
 */
export function isZauggJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  return key === ZAUGG_KEY
    || key.startsWith('zaugg-')
    || company.includes('zaugg ag')
    || isTrustedDomain(job?.url || '');
}

/** Trust only ZAUGG's official domain and its subdomains. */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (host === ZAUGG_COMPANY_DOMAIN || host.endsWith(`.${ZAUGG_COMPANY_DOMAIN}`));
  } catch {
    return false;
  }
}

/** Fetch and map only source-proven open welding vacancies. */
export async function fetchAllZauggJobs(runtime = {}) {
  console.log(`🔍 Fetching ZAUGG AG jobs from ${CAREER_URL}`);
  const fetchPage = typeof runtime.fetchPage === 'function'
    ? runtime.fetchPage
    : (url) => fetchHtml(url, { validateRedirectUrl: isTrustedDomain, maxRedirects: 4 });
  const listingHtml = await fetchPage(CAREER_URL);
  const cards = extractZauggListingCards(listingHtml, CAREER_URL);
  const targets = cards.filter((card) => isZauggTargetRoleTitle(card.title));
  if (targets.length === 0) {
    console.log(`  Official listing is readable (${cards.length} vacancy links); target role is not listed.`);
    return markAuthoritativeEmptySnapshot(
      [],
      `ZAUGG official open-positions list exposed ${cards.length} titled detail links and no matching welding role`,
    );
  }

  const jobs = [];
  for (const listing of targets) {
    const detailHtml = await fetchPage(listing.url);
    const detail = parseZauggDetailPage(detailHtml, listing.url);
    jobs.push(buildZauggJob(listing, detail));
  }
  console.log(`  Source-backed ZAUGG welding vacancies: ${jobs.length}`);
  return jobs;
}

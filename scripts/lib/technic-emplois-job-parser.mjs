#!/usr/bin/env node
/**
 * Technic Emplois SA job parser.
 *
 * The employer's official vacancy page still embeds the legacy Jobeo tenant at
 * https://blog.jobeo.ch/technicemploi/. Current openings are now published on
 * Technic Emplois' Jobup employer search, so the legacy tenant is probed first
 * and Jobup is the source-backed fallback. Every discovered detail URL is still
 * fetched and checked before a job is published.
 */
import { createHash } from 'node:crypto';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { extractLinks } from './prospector/careers-trail.mjs';
import { extractJsonLd } from './prospector/extract.mjs';
import { extractRuntimeDetailFields } from './prospector/detail-extract.mjs';
import {
  fetchHtmlViaBrowser,
  fetchRuntimePage,
  loadSpec,
  createSpecUrlPolicy,
} from './prospector/spec-crawler.mjs';
import {
  resolveDetailOrListingSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { mapPool } from './prospector/polite-fetch.mjs';
import { readAttr, scanStartTags } from './html-attr.mjs';
import { fetchViaJinaWithRetry } from './jina-proxy.mjs';
import {
  filterJobupCardsByEmployer,
  parseJobupLieu,
  parseJobupSearchCards,
} from './jobup-ch-feed-common.mjs';

export const TECHNIC_EMPLOIS_KEY = 'technic-emplois';
export const TECHNIC_EMPLOIS_COMPANY_NAME = 'Technic Emplois SA';
export const TECHNIC_EMPLOIS_COMPANY_DOMAIN = 'technic-emplois.ch';
export const TECHNIC_EMPLOIS_OFFICIAL_URL = 'https://technic-emplois.ch/offre-demploi/';
export const TECHNIC_EMPLOIS_JOBUP_SEARCH_URL = 'https://www.jobup.ch/fr/emplois/?term=Technic%20Emplois%20SA';

const OFFICIAL_HOST = 'technic-emplois.ch';
const OFFICIAL_WIDGET_HOST = 'blog.jobeo.ch';
const OFFICIAL_WIDGET_PATH = '/technicemploi';
const JOBEO_HOST = 'jobeo.ch';
const DEFAULT_WIDGET_URL = 'https://blog.jobeo.ch/technicemploi/';
const JOBUP_HOSTS = new Set(['jobup.ch', 'www.jobup.ch']);
const JOBUP_DETAIL_PATH_RE = /^\/(?:fr\/emplois|en\/jobs)\/detail\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}
function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCompany(value = '') {
  return normalize(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameOrSubdomain(host, domain) {
  const value = String(host || '').toLowerCase();
  return value === domain || value.endsWith(`.${domain}`);
}

function canonicalUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function isOfficialUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return sameOrSubdomain(url.hostname, OFFICIAL_HOST);
  } catch {
    return false;
  }
}

function isOfficialWidgetUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === OFFICIAL_WIDGET_HOST
      && url.pathname.replace(/\/+$/, '').toLowerCase() === OFFICIAL_WIDGET_PATH;
  } catch {
    return false;
  }
}

function isJobeoHost(host = '') {
  return sameOrSubdomain(host, JOBEO_HOST);
}

function isJobupHost(host = '') {
  return JOBUP_HOSTS.has(String(host || '').toLowerCase());
}

/**
 * Jobeo has used more than one public detail path over time. Jobup detail
 * pages use UUID paths. Both shapes must still identify an employment page;
 * accepting every URL from either host would leak blog, account and navigation
 * links from the source pages.
 */
export function isTechnicDetailUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
    if (isJobupHost(url.hostname)) return JOBUP_DETAIL_PATH_RE.test(path);
    if (!isJobeoHost(url.hostname) || !path || path === OFFICIAL_WIDGET_PATH) return false;
    return path.split('/').filter(Boolean).length >= 2
      && /\/(?:offre|offres|emploi|emplois|job|jobs|candidat|postul|vacan|recrut)/i.test(path);
  } catch {
    return false;
  }
}

/**
 * Check if a job belongs to the Technic Emplois slice.
 */
export function isTechnicEmploisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalizeCompany(job?.company || '');
  const url = String(job?.url || '');
  return key === TECHNIC_EMPLOIS_KEY
    || key.startsWith(`${TECHNIC_EMPLOIS_KEY}-`)
    || company.includes('technic emplois')
    || isOfficialUrl(url);
}

/**
 * Trusted source URLs are the employer's official site, the legacy Jobeo host
 * explicitly embedded by that site, and the employer's current Jobup detail
 * pages. Other aggregator domains are intentionally not accepted.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return sameOrSubdomain(host, OFFICIAL_HOST) || isJobeoHost(host) || isJobupHost(host);
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const value = normalize(title);
  if (/\b(soudeur|soudeuse|soudage|tuyauteur|tuyauterie|electric|electri|cv[cs]|techni|mecan|maintenance|install)/.test(value)) {
    return 'Tecnica';
  }
  if (/\b(admin|secre|compt|contab|buchhalt)/.test(value)) return 'Amministrazione';
  if (/\b(logist|magasin|entrep|warehouse)/.test(value)) return 'Logistica';
  if (/\b(commercial|vente|sales|verkauf)/.test(value)) return 'Commerciale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const value = normalize(title);
  if (/\b(junior|jr|debutant|apprenti|apprentie|stagiaire)/.test(value)) return 'junior';
  if (/\b(senior|sr|chef|responsable|lead|directeur|directrice)/.test(value)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const value = normalize(text);
  if (/\b(part.?time|temps partiel|teilzeit|50\s*%|80\s*%)/.test(value)) return 'PART_TIME';
  if (/\b(full.?time|temps plein|vollzeit|100\s*%)/.test(value)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Read only the iframe that the official page assigns to the Technic tenant.
 * A generic iframe/first-link fallback would make the crawler follow an
 * unrelated embedded asset when the page layout changes.
 */
export function extractOfficialWidgetUrl(html = '', baseUrl = TECHNIC_EMPLOIS_OFFICIAL_URL) {
  for (const tag of scanStartTags(html, 'iframe')) {
    const rawSrc = readAttr(tag.raw, 'src');
    if (!rawSrc) continue;
    let absolute;
    try { absolute = new URL(rawSrc, baseUrl).toString(); } catch { continue; }
    if (isOfficialWidgetUrl(absolute)) return canonicalUrl(absolute);
  }
  return '';
}

function addCandidate(byUrl, candidate, sourceUrl) {
  const url = canonicalUrl(candidate?.url || '');
  if (!isTechnicDetailUrl(url) || byUrl.has(url)) return;
  const title = normalizeSpace(candidate?.title || candidate?.text || '');
  byUrl.set(url, {
    title: title.length >= 3 ? title.slice(0, 180) : '',
    url,
    sourceUrl,
    company: normalizeSpace(candidate?.company || ''),
    location: normalizeSpace(candidate?.location || ''),
    description: candidate?.description || '',
    locationCandidates: Array.isArray(candidate?.locationCandidates)
      ? candidate.locationCandidates
      : [],
    ...mergeSourcePostingDates({}, candidate || {}),
  });
}

/**
 * Extract detail URLs from the rendered Jobeo tenant page. JSON-LD is
 * preferred, while explicit cross-origin anchors/data URLs are accepted only
 * when their source path identifies a vacancy detail page.
 */
export function extractTechnicEmploisListings(html = '', pageUrl = DEFAULT_WIDGET_URL) {
  const byUrl = new Map();
  for (const candidate of extractJsonLd(html, pageUrl)) {
    addCandidate(byUrl, candidate, pageUrl);
  }
  for (const link of extractLinks(html, pageUrl, { sameOriginOnly: false })) {
    addCandidate(byUrl, { ...link, title: link.text }, pageUrl);
  }
  for (const tag of scanStartTags(html)) {
    const raw = readAttr(tag.raw, ['data-href', 'data-url', 'data-link']);
    if (!raw) continue;
    let absolute;
    try { absolute = new URL(raw, pageUrl).toString(); } catch { continue; }
    addCandidate(byUrl, { url: absolute }, pageUrl);
  }
  return [...byUrl.values()];
}

/**
 * Extract only Technic Emplois cards from the current Jobup employer search.
 * The term search is relevance-ranked and can include other employers, so the
 * exact employer filter is mandatory before any detail URL is followed.
 */
export function extractTechnicJobupListings(html = '', pageUrl = TECHNIC_EMPLOIS_JOBUP_SEARCH_URL) {
  const cards = filterJobupCardsByEmployer(
    parseJobupSearchCards(html),
    TECHNIC_EMPLOIS_COMPANY_NAME,
  );
  return cards.map((card) => {
    const parsedLocation = parseJobupLieu(card.location);
    const listing = {
      title: card.title,
      url: card.url,
      sourceUrl: pageUrl,
      company: card.company,
      location: parsedLocation.city || card.location,
      description: '',
    };
    if (parsedLocation.city && !parsedLocation.city.includes(',')) {
      listing.locationCandidates = [{
        location: parsedLocation.city,
        addressLocality: parsedLocation.city,
        addressCountry: 'CH',
        ...(parsedLocation.postal ? { postalCode: parsedLocation.postal } : {}),
      }];
    }
    return listing;
  });
}

function pageFromResult(result, requestedUrl) {
  if (typeof result === 'string') return { body: result, url: requestedUrl };
  if (result && typeof result.body === 'string') {
    return { body: result.body, url: result.url || requestedUrl };
  }
  return { body: '', url: requestedUrl };
}

async function fetchSourcePage(url, {
  policy,
  runtime,
  accept,
}) {
  if (typeof runtime.fetchPageImpl === 'function') {
    return pageFromResult(await runtime.fetchPageImpl(url), url);
  }

  const page = await fetchRuntimePage(url, policy, runtime);
  if (accept(page.body, page.url || url)) return page;

  // A 200 JavaScript shell is not evidence of an empty board. Render the same
  // source page once, then apply the identical source-specific acceptance gate.
  const browserFetch = runtime.browserFetchImpl || fetchHtmlViaBrowser;
  if (typeof browserFetch === 'function') {
    const rendered = await browserFetch(url);
    if (typeof rendered === 'string' && rendered.trim() && accept(rendered, url)) {
      return { body: rendered, url };
    }
  }
  return page;
}

async function fetchTechnicJobupSearchPage(runtime = {}) {
  if (typeof runtime.fetchJobupSearchImpl === 'function') {
    return pageFromResult(
      await runtime.fetchJobupSearchImpl(TECHNIC_EMPLOIS_JOBUP_SEARCH_URL),
      TECHNIC_EMPLOIS_JOBUP_SEARCH_URL,
    );
  }

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 40_000;
  const response = await fetchViaJinaWithRetry(TECHNIC_EMPLOIS_JOBUP_SEARCH_URL, {
    timeoutMs,
    format: 'html',
  });
  if (!response.ok) {
    const reason = response.headers.get('x-jina-retry-reason') || `HTTP ${response.status}`;
    const error = new Error(`Jobup listing fetch failed (${reason})`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return {
    body: await response.text(),
    url: TECHNIC_EMPLOIS_JOBUP_SEARCH_URL,
  };
}

async function fetchTechnicPages({ spec, runtime, officialUrl }) {
  const policy = typeof runtime.fetchPageImpl === 'function'
    ? null
    : createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl });
  const pageRuntime = {
    ...runtime,
    browserFetchImpl: runtime.browserFetchImpl || fetchHtmlViaBrowser,
  };
  try {
    let officialError = null;
    try {
      const official = await fetchSourcePage(officialUrl, {
        policy,
        runtime: pageRuntime,
        accept: (html, url) => Boolean(extractOfficialWidgetUrl(html, url)),
      });
      const widgetUrl = extractOfficialWidgetUrl(official.body, official.url || officialUrl);
      if (widgetUrl) {
        const widget = await fetchSourcePage(widgetUrl, {
          policy,
          runtime: pageRuntime,
          accept: (html, url) => extractTechnicEmploisListings(html, url).length > 0,
        });
        const listings = extractTechnicEmploisListings(widget.body, widget.url || widgetUrl);
        if (listings.length) return { listings, discoveredCount: listings.length };
      }
    } catch (err) {
      officialError = err;
      console.warn(`⚠️ ${TECHNIC_EMPLOIS_COMPANY_NAME}: legacy Jobeo source unavailable: ${err?.message || err}`);
    }

    const jobup = await fetchTechnicJobupSearchPage(runtime);
    const listings = extractTechnicJobupListings(jobup.body, jobup.url || TECHNIC_EMPLOIS_JOBUP_SEARCH_URL);
    if (listings.length) {
      console.log(`  📋 Jobup listings found: ${listings.length}`);
    } else if (officialError) {
      // A successful but empty Jobup response is still a selector miss; keep
      // the monitor's fail-closed diagnosis rather than hiding the legacy error.
      console.warn(`⚠️ ${TECHNIC_EMPLOIS_COMPANY_NAME}: both listing sources returned no matching vacancies`);
    }
    return { listings, discoveredCount: listings.length };
  } finally {
    await policy?.dispatcher?.close?.().catch(() => {});
  }
}

function buildTechnicJob(listing, detail) {
  const title = normalizeSpace(detail.title || listing.title || '');
  if (title.length < 3) return null;

  const detailCompany = normalizeCompany(detail.company || '');
  if (detailCompany && !detailCompany.includes('technic emplois')) return null;

  const decision = resolveDetailOrListingSwissGeography(detail, listing);
  const geography = decision.geography
    ? sourceBackedSwissGeographyFields(decision.candidate, decision.geography)
    : null;
  if (!geography) return null;

  const description = stripHtml(detail.description || listing.description || '');
  if (!meetsSourceBodyFloor(description)) return null;

  const publicUrl = canonicalUrl(listing.url);
  if (!publicUrl || !isTechnicDetailUrl(publicUrl)) return null;

  const sourceLang = detectLang(description || title, 'fr');
  const employmentType = detectEmploymentType([
    detail.employmentType,
    title,
    description,
  ].filter(Boolean).join(' '));
  const publication = mergeSourcePostingDates(listing, detail);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} ${geography.location} technic emplois ch`);

  return {
    id: `${TECHNIC_EMPLOIS_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: TECHNIC_EMPLOIS_COMPANY_NAME,
    companyKey: TECHNIC_EMPLOIS_KEY,
    companyDomain: TECHNIC_EMPLOIS_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: geography.location,
    canton: geography.canton,
    addressLocality: geography.addressLocality,
    addressRegion: geography.addressRegion,
    ...(geography.addressCountry ? { addressCountry: geography.addressCountry, country: geography.addressCountry } : {}),
    ...(geography.postalCode ? { postalCode: geography.postalCode } : {}),
    ...(geography.streetAddress ? { streetAddress: geography.streetAddress } : {}),
    url: publicUrl,
    source: publicUrl.includes('jobup.ch')
      ? 'Technic Emplois SA (Jobup employer search)'
      : 'Technic Emplois SA (official site → Jobeo tenant)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    category: detectCategory(title),
    contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType,
    experienceLevel: detectExperienceLevel(title),
    sector: 'Tecnica',
    currency: 'CHF',
    featured: false,
    ...publication,
    postedAt: publication.postedDate || null,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

function hasPublishableTechnicDetail(detail = {}, listing = {}) {
  const title = normalizeSpace(detail.title || listing.title || '');
  const description = stripHtml(detail.description || listing.description || '');
  const geography = resolveDetailOrListingSwissGeography(detail, listing).geography;
  return title.length >= 3
    && meetsSourceBodyFloor(description)
    && Boolean(geography);
}

/**
 * Fetch and parse the complete official-source vacancy snapshot.
 *
 * Only source-locale fields are emitted. The standard crawler pipeline owns
 * localization, validation, slug preservation and slice publication.
 */
export async function fetchAllTechnicEmploisJobs({
  spec = loadSpec(TECHNIC_EMPLOIS_KEY),
  runtime = {},
} = {}) {
  const officialUrl = (spec.seedUrls || []).find(isOfficialUrl) || TECHNIC_EMPLOIS_OFFICIAL_URL;
  console.log(`🔍 Fetching ${TECHNIC_EMPLOIS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${officialUrl}\n`);

  const { listings, discoveredCount } = await fetchTechnicPages({ spec, runtime, officialUrl });
  if (!listings.length) {
    console.warn('⚠️ No Technic Emplois detail links returned by the configured source pages.');
    const empty = [];
    Object.defineProperties(empty, {
      discoveredCount: { value: discoveredCount, enumerable: false },
      fetchOutcome: { value: 'selector_miss', enumerable: false },
    });
    return empty;
  }

  console.log(`  📋 Detail links found: ${listings.length}`);
  const detailWorkers = Math.max(1, Math.min(4, Number(spec.detailFetchWorkers) || 2));
  const policy = typeof runtime.fetchPageImpl === 'function'
    ? null
    : createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl });
  const pageRuntime = {
    ...runtime,
    browserFetchImpl: runtime.browserFetchImpl || fetchHtmlViaBrowser,
  };
  try {
    const parsed = await mapPool(listings, detailWorkers, async (listing) => {
      const page = await fetchSourcePage(listing.url, {
        policy,
        runtime: pageRuntime,
        accept: (html, url) => {
          const detail = extractRuntimeDetailFields(spec, html, url, {
            recordUrl: listing.url,
            recordTitle: listing.title,
          });
          return hasPublishableTechnicDetail(detail, listing);
        },
      });
      const detail = extractRuntimeDetailFields(spec, page.body, page.url || listing.url, {
        recordUrl: listing.url,
        recordTitle: listing.title,
      });
      return buildTechnicJob(listing, detail);
    });
    const jobs = parsed.filter(Boolean);
    console.log(`\n📋 Total ${TECHNIC_EMPLOIS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
    Object.defineProperties(jobs, {
      discoveredCount: { value: discoveredCount, enumerable: false },
      fetchOutcome: { value: jobs.length ? 'ok' : 'selector_miss', enumerable: false },
    });
    return jobs;
  } finally {
    await policy?.dispatcher?.close?.().catch(() => {});
  }
}

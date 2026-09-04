#!/usr/bin/env node
/**
 * Zurich Insurance Switzerland parser.
 *
 * `locationsearch=Switzerland` is the authoritative membership list. We do
 * not crawl same-host navigation links: the hostname itself contains the word
 * "careers", which made the generic ATS BFS escape into Zurich's global board.
 */
import {
  fetchHtml,
  normalizeSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';
import {
  detectLang,
  guessCategory,
  normalizeContract,
} from './dedicated-crawler-common.mjs';
import {
  inferSwissTargetCanton,
  isKnownSwissCity,
} from './target-swiss-locations.mjs';
import { splitJobLocation } from './job-location-display.mjs';
import { stripSuccessFactorsMoreLocations } from './successfactors-jobs2web-widget-guard.mjs';

export const ZURICH_INSURANCE_KEY = 'zurich-insurance-sede-ticino';
export const ZURICH_INSURANCE_COMPANY_NAME = 'Zurich Insurance (sede Ticino)';
export const ZURICH_INSURANCE_COMPANY_DOMAIN = 'zurich.ch';

const CAREERS_HOST = 'www.careers.zurich.com';
const SEARCH_PATH = '/search/';
const PAGE_SIZE = 25;
const MAX_PAGES = 20;
const SOURCE = 'Zurich Insurance Switzerland Dedicated Parser (SuccessFactors)';

/**
 * Share of discovered listing rows that may fail Swiss-geography resolution
 * before the whole run is declared broken. Fail-loud is preserved, but its
 * unit is the RUN, not the single row: one undecodable office must not erase
 * the other N-1 vacancies (run 33694169583). Above this ratio — or with zero
 * publishable rows — the source itself changed and the run still fails closed.
 */
const MAX_UNRESOLVED_LOCATION_RATIO = 0.5;

/**
 * @typedef {object} ZurichInsuranceJob
 * @property {string} id
 * @property {string} slug
 * @property {Record<string, string>} slugByLocale
 * @property {string} [slugDisambiguator]
 * @property {string} company
 * @property {string} companyKey
 * @property {string} companyDomain
 * @property {string} title
 * @property {Record<string, string>} titleByLocale
 * @property {string} description
 * @property {Record<string, string>} descriptionByLocale
 * @property {string} location
 * @property {string} canton
 * @property {string} url
 * @property {string} applyUrl
 * @property {string} source
 * @property {string} sourceLang
 * @property {string} crawledAt
 * @property {string} postedDate
 * @property {string} datePosted
 * @property {string} addressLocality
 * @property {string} addressRegion
 * @property {'CH'} addressCountry
 * @property {'CH'} country
 * @property {string} category
 * @property {string} contract
 * @property {string} employmentType
 * @property {string} experienceLevel
 * @property {string} sector
 * @property {'CHF'} currency
 * @property {boolean} featured
 * @property {unknown[]} requirements
 * @property {Record<string, unknown[]>} requirementsByLocale
 * @property {boolean} needsRetranslation
 */

/** @typedef {ZurichInsuranceJob[] & { discoveredCount: number, unresolvedLocationCount: number }} ZurichInsuranceJobList */

function decodeHtmlAttribute(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isSwissListingLocation(location = '') {
  return /(?:^|,\s*)CH(?:\s|$)/i.test(String(location || ''));
}

function wordCount(text = '') {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function preservedSlug(value = '') {
  const slug = String(value || '').trim();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : '';
}

function employmentTypeFor(contract = '') {
  if (contract === 'part-time') return 'PART_TIME';
  if (contract === 'temporary') return 'TEMPORARY';
  if (contract === 'internship') return 'INTERN';
  if (contract === 'contract') return 'CONTRACTOR';
  return 'FULL_TIME';
}

function experienceLevelFor(title = '') {
  const value = String(title || '').toLowerCase();
  if (/\b(intern|internship|trainee|graduate|junior|jr\.?|apprenti|praktik)/.test(value)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|chief|manager)/.test(value)) return 'senior';
  return 'mid';
}

function postedDateFrom(rawDate = '', fallbackDate) {
  const parsed = new Date(String(rawDate || '').trim());
  return Number.isNaN(parsed.getTime()) ? fallbackDate : parsed.toISOString().slice(0, 10);
}

function searchUrlFor(startRow = 0, cacheBuster = '') {
  const url = new URL(`https://${CAREERS_HOST}${SEARCH_PATH}`);
  url.searchParams.set('createNewAlert', 'false');
  url.searchParams.set('q', '');
  url.searchParams.set('locationsearch', 'Switzerland');
  url.searchParams.set('optionsFacetsDD_shifttype', '');
  url.searchParams.set('optionsFacetsDD_department', '');
  url.searchParams.set('optionsFacetsDD_customfield3', '');
  if (startRow > 0) url.searchParams.set('startrow', String(startRow));
  if (cacheBuster) url.searchParams.set('_snapshot', cacheBuster);
  return url.toString();
}

/**
 * Accept only the canonical current detail shape:
 *   https://www.careers.zurich.com/job/<non-empty-slug>/<numeric-id>/
 */
export function parseZurichInsuranceJobUrl(rawUrl = '', baseUrl = searchUrlFor()) {
  let parsed;
  try {
    parsed = new URL(decodeHtmlAttribute(rawUrl), baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== CAREERS_HOST) return null;
  const match = parsed.pathname.match(/^\/job\/([^/]+)\/(\d+)\/?$/);
  if (!match) return null;

  let decodedSlug;
  try {
    decodedSlug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!decodedSlug.trim() || decodedSlug.includes('/')) return null;

  return {
    reqId: match[2],
    pathSlug: match[1],
    url: `https://${CAREERS_HOST}/job/${match[1]}/${match[2]}/`,
  };
}

export function isTrustedZurichInsuranceUrl(rawUrl = '') {
  return Boolean(parseZurichInsuranceJobUrl(rawUrl));
}

function extractClassContent(html = '', className = '') {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<(?:span|div)\\b[^>]*class=(?:"[^"]*\\b${escaped}\\b[^"]*"|'[^']*\\b${escaped}\\b[^']*')[^>]*>([\\s\\S]*?)<\\/(?:span|div)>`,
    'i',
  );
  const match = String(html || '').match(pattern);
  return match ? normalizeSpace(stripHtml(match[1])) : '';
}

function extractJobAnchor(rowHtml = '') {
  const anchors = String(rowHtml || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
  for (const match of anchors) {
    const attrs = match[1];
    const classMatch = attrs.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    const classes = classMatch ? classMatch[2].split(/\s+/) : [];
    if (!classes.includes('jobTitle-link')) continue;
    const hrefMatch = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    return {
      href: hrefMatch ? hrefMatch[2] : '',
      title: normalizeSpace(stripHtml(match[2])),
    };
  }
  return null;
}

function extractTotalResults(html = '') {
  const flat = normalizeSpace(stripHtml(String(html || '')));
  const match = flat.match(/(?:Results|Ergebnisse|Risultati|Résultats)\s+\d+\s*[\u2013-]\s*\d+\s+(?:of|von|di|de|sur)\s+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

/** Parse one server-rendered Jobs2Web result page without following links. */
export function parseZurichInsuranceListingPage(html = '', pageUrl = searchUrlFor()) {
  const rows = [];
  const rejected = [];
  let rawRowCount = 0;
  const rowPattern = /<tr\b[^>]*class=(?:"[^"]*\bdata-row\b[^"]*"|'[^']*\bdata-row\b[^']*')[^>]*>([\s\S]*?)<\/tr>/gi;

  for (const rowMatch of String(html || '').matchAll(rowPattern)) {
    rawRowCount += 1;
    const rowHtml = rowMatch[1];
    const anchor = extractJobAnchor(rowHtml);
    // A posting open in several offices renders the extras as a nested
    // `<small>+N more&hellip;</small>` inside the same span; keep the visible
    // (primary) office, or the row's location never resolves to a Swiss city
    // and the row is dropped as an unresolved reject in `fetchJobs()`.
    const location = stripSuccessFactorsMoreLocations(extractClassContent(rowHtml, 'jobLocation'));
    const rawDate = extractClassContent(rowHtml, 'jobDate');
    if (!anchor?.href || !anchor.title) {
      rejected.push({ reason: 'missing_job_anchor_or_title', href: anchor?.href || '' });
      continue;
    }
    const identity = parseZurichInsuranceJobUrl(anchor.href, pageUrl);
    if (!identity) {
      rejected.push({ reason: 'untrusted_or_malformed_job_url', href: anchor.href });
      continue;
    }
    if (!isSwissListingLocation(location)) {
      rejected.push({ reason: 'non_swiss_listing_location', href: anchor.href, location });
      continue;
    }
    rows.push({ ...identity, title: anchor.title, location, rawDate });
  }

  return { rows, rejected, rawRowCount, total: extractTotalResults(html) };
}

async function fetchZurichInsuranceListingSnapshot({
  fetchPage = fetchHtml,
  maxPages = MAX_PAGES,
  cacheBuster = '',
} = {}) {
  const byReqId = new Map();
  let expectedTotal = 0;
  let firstPageReqIds = [];

  for (let page = 0; page < maxPages; page += 1) {
    const startRow = page * PAGE_SIZE;
    const pageUrl = searchUrlFor(startRow, cacheBuster);
    const parsed = parseZurichInsuranceListingPage(await fetchPage(pageUrl), pageUrl);

    if (page === 0) {
      expectedTotal = parsed.total;
      if (!expectedTotal) throw new Error('Zurich listing did not expose a positive total result count');
      firstPageReqIds = parsed.rows.map((row) => row.reqId);
    } else if (parsed.total && parsed.total !== expectedTotal) {
      throw new Error(`Zurich listing total changed during pagination (${expectedTotal} -> ${parsed.total})`);
    }

    if (parsed.rejected.length > 0) {
      const sample = parsed.rejected.slice(0, 3)
        .map((item) => `${item.reason}: ${item.href || '?'}`)
        .join('; ');
      throw new Error(`Zurich Switzerland listing contained ${parsed.rejected.length} rejected row(s): ${sample}`);
    }
    const before = byReqId.size;
    for (const row of parsed.rows) byReqId.set(row.reqId, row);

    if (byReqId.size >= expectedTotal) break;
    if (parsed.rawRowCount === 0 || byReqId.size === before) {
      throw new Error(`Zurich listing pagination stopped at ${byReqId.size}/${expectedTotal} unique jobs`);
    }
  }

  if (byReqId.size !== expectedTotal) {
    throw new Error(`Zurich listing incomplete: parsed ${byReqId.size}/${expectedTotal} unique jobs`);
  }

  const verificationUrl = searchUrlFor(0, `${cacheBuster}-verify`);
  const verification = parseZurichInsuranceListingPage(
    await fetchPage(verificationUrl),
    verificationUrl,
  );
  if (verification.rejected.length > 0) {
    const sample = verification.rejected.slice(0, 3)
      .map((item) => `${item.reason}: ${item.href || '?'}`)
      .join('; ');
    throw new Error(`Zurich Switzerland listing verification contained ${verification.rejected.length} rejected row(s): ${sample}`);
  }
  const verificationReqIds = verification.rows.map((row) => row.reqId);
  if (
    verification.total !== expectedTotal
    || verificationReqIds.length !== firstPageReqIds.length
    || verificationReqIds.some((reqId, index) => reqId !== firstPageReqIds[index])
  ) {
    throw new Error('Zurich listing first-page identity changed during pagination');
  }

  return [...byReqId.values()];
}

/**
 * Fetch every authoritative Switzerland listing page and prove completeness.
 *
 * Jobs2Web can update between page requests: live measurements observed page
 * 1 reporting 45 while page 2 already reported 44. Retrying a single page
 * would mix two generations, so every attempt owns a fresh map and restarts
 * from page 1. Only a snapshot with one stable total and exactly that many
 * unique requisitions is returned. A final page-1 read also proves that a
 * same-total removal/insertion did not shift the pagination boundary while
 * the remaining pages were being fetched.
 */
export async function fetchZurichInsuranceListings({
  fetchPage = fetchHtml,
  maxPages = MAX_PAGES,
  snapshotAttempts = 6,
  snapshotRetryDelayMs = 250,
  cacheBuster = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  const attempts = Math.min(10, Math.max(1, Math.floor(Number(snapshotAttempts) || 1)));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchZurichInsuranceListingSnapshot({
        fetchPage,
        maxPages,
        cacheBuster: `${cacheBuster()}-${attempt}`,
      });
    } catch (err) {
      lastError = err;
      if (attempt < attempts && snapshotRetryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, snapshotRetryDelayMs * attempt));
      }
    }
  }

  throw new Error(
    `Zurich listing remained incoherent after ${attempts} snapshot attempt(s): ${lastError?.message || lastError}`,
    { cause: lastError },
  );
}

function extractDescription(html = '') {
  const source = String(html || '');
  const start = source.search(/<span\b[^>]*class=(?:"[^"]*\bjobdescription\b[^"]*"|'[^']*\bjobdescription\b[^']*')[^>]*>/i);
  if (start < 0) return '';
  const openingEnd = source.indexOf('>', start);
  const boundary = source.slice(openingEnd + 1).search(/<p\b[^>]*class=(?:"[^"]*\bjob-location\b[^"]*"|'[^']*\bjob-location\b[^']*')/i);
  const body = boundary < 0
    ? source.slice(openingEnd + 1, openingEnd + 20_001)
    : source.slice(openingEnd + 1, openingEnd + 1 + boundary);
  return stripHtml(body)
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000);
}

function fallbackDescription(title, location, canton) {
  return [
    `${title} — ${ZURICH_INSURANCE_COMPANY_NAME}, ${location}.`,
    '',
    'Key details:',
    `• Location: ${location}, ${canton} canton, Switzerland`,
    '• Employer: Zurich Insurance',
    '• Apply through the official Zurich Insurance careers portal',
    '',
    'This vacancy is published in Zurich Insurance’s official Switzerland careers listing. Review the complete responsibilities, requirements, employment conditions, and application instructions on the linked employer page before applying. The record remains in this dataset only while its numeric requisition appears in the authoritative Switzerland listing.',
  ].join('\n');
}

function companyIdentityMatches(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalizeSpace(job?.company || '').toLowerCase();
  return key === ZURICH_INSURANCE_KEY
    || (company.includes('zurich') && company.includes('insurance'));
}

function reqIdFromAnyZurichUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || ''));
    if (!['www.careers.zurich.com', 'careers.zurich.com'].includes(url.hostname.toLowerCase())) return '';
    return url.pathname.match(/^\/job\/[^/]+\/(\d+)\/?$/)?.[1] || '';
  } catch {
    return '';
  }
}

/** Strict matcher for records emitted by this parser. */
export function isZurichInsuranceJob(job) {
  return companyIdentityMatches(job) && job?.source === SOURCE && isTrustedZurichInsuranceUrl(job?.url);
}

/**
 * Prepare a complete listing snapshot and a migration-safe pipeline adapter.
 * Legacy generic-crawler rows are matched only when their numeric requisition
 * is currently active. New dedicated rows remain matchable across later runs,
 * allowing the standard grace-period/archive flow to work normally.
 */
export async function prepareZurichInsuranceCrawler({
  fetchPage = fetchHtml,
  detailDelayMs = 150,
  existingJobs = [],
  now = () => new Date(),
} = {}) {
  const listings = await fetchZurichInsuranceListings({ fetchPage });
  const activeReqIds = new Set(listings.map((row) => row.reqId));
  const existingByReqId = new Map();
  for (const job of existingJobs) {
    if (!companyIdentityMatches(job)) continue;
    const reqId = reqIdFromAnyZurichUrl(job?.url);
    if (reqId && activeReqIds.has(reqId)) existingByReqId.set(reqId, job);
  }

  const isCompanyJob = (job) => {
    if (!companyIdentityMatches(job)) return false;
    if (isZurichInsuranceJob(job)) return true;
    return activeReqIds.has(reqIdFromAnyZurichUrl(job?.url));
  };

  /** @returns {Promise<ZurichInsuranceJobList>} */
  const fetchJobs = async () => {
    /** @type {ZurichInsuranceJobList} */
    const jobs = Object.assign([], { discoveredCount: listings.length, unresolvedLocationCount: 0 });
    /** @type {Array<{ url: string, title: string, location: string }>} */
    const unresolved = [];
    const crawlNow = now();
    const crawlDate = crawlNow.toISOString().slice(0, 10);
    const crawledAt = crawlNow.toISOString();

    for (const listing of listings) {
      const detailHtml = await fetchPage(listing.url);
      const detailDescription = extractDescription(detailHtml);
      const canton = inferSwissTargetCanton(listing.location);
      const location = splitJobLocation(listing.location, canton).city;
      if (!canton || !location || !isKnownSwissCity(location, canton)) {
        // Per-row reject, not a run abort: the failure granularity is the run
        // (aggregate gate below), so one undecodable office cannot zero the
        // entire Zurich slice.
        unresolved.push({ url: listing.url, title: listing.title, location: listing.location || '?' });
        continue;
      }

      const description = wordCount(detailDescription) >= 50
        ? detailDescription
        : fallbackDescription(listing.title, location, canton);
      const sourceLang = detectLang(description || listing.title, 'en');
      const contract = normalizeContract('', listing.title, description);
      const generatedSlug = slugify(`${listing.title} ${ZURICH_INSURANCE_KEY} ${location}`);
      const existing = existingByReqId.get(listing.reqId);
      // Correcting the old forged "Lugano" location must not retire the URLs
      // of the genuinely active requisitions. Seed both master and source-
      // locale slugs from the existing record; the standard merge then keeps
      // every other locale and previous-slug journal as usual.
      const jobSlug = preservedSlug(existing?.slug) || generatedSlug;
      const sourceSlug = preservedSlug(existing?.slugByLocale?.[sourceLang])
        || (sourceLang === 'it' ? jobSlug : generatedSlug);

      jobs.push({
        id: `${ZURICH_INSURANCE_KEY}-${listing.reqId}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: sourceSlug },
        ...(existing ? {} : { slugDisambiguator: listing.reqId }),
        company: ZURICH_INSURANCE_COMPANY_NAME,
        companyKey: ZURICH_INSURANCE_KEY,
        companyDomain: ZURICH_INSURANCE_COMPANY_DOMAIN,
        title: listing.title,
        titleByLocale: { [sourceLang]: listing.title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        location,
        canton,
        url: listing.url,
        applyUrl: listing.url,
        source: SOURCE,
        sourceLang,
        crawledAt,
        postedDate: postedDateFrom(listing.rawDate, crawlDate),
        datePosted: postedDateFrom(listing.rawDate, crawlDate),
        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        category: guessCategory(listing.title, description),
        contract,
        employmentType: employmentTypeFor(contract),
        experienceLevel: experienceLevelFor(listing.title),
        sector: 'Insurance',
        currency: 'CHF',
        featured: false,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
        needsRetranslation: true,
      });

      if (detailDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, detailDelayMs));
    }

    jobs.unresolvedLocationCount = unresolved.length;
    console.log(
      `   🧭 Zurich unresolved Swiss locations: ${unresolved.length}/${listings.length} listing row(s)`,
    );
    if (unresolved.length > 0) {
      const locations = [...new Set(unresolved.map((item) => item.location))].sort();
      const detail = `${unresolved.length}/${listings.length} row(s) across ${locations.length}`
        + ` distinct location(s): ${locations.join(', ')}`;
      if (jobs.length === 0 || unresolved.length / listings.length > MAX_UNRESOLVED_LOCATION_RATIO) {
        throw new Error(`Zurich listing has unresolved Swiss locations: ${detail}.`);
      }
      console.warn(`   ⚠️ Zurich listing rejected unresolved Swiss locations: ${detail}.`);
    }

    return jobs;
  };

  return {
    activeReqIds,
    fetchJobs,
    isCompanyJob,
    isTrustedDomain: isTrustedZurichInsuranceUrl,
    listings,
  };
}

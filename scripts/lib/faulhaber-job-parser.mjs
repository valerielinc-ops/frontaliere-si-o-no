#!/usr/bin/env node
/**
 * Faulhaber job parser — Fetcher and job builder.
 *
 * Source: https://jobs.faulhaber.com/HPv3.Jobs/faulhaber/Joboffers/GetJoboffersData
 *
 * HPv3.Jobs (HR4YOU) Vue.js portal. The listing SPA reads its authoritative
 * vacancy records from the JSON endpoint above. Detail pages expose the full
 * description inside `.annonce #position`.
 *
 * This is a single-site Swiss crawler for the Croglio (TI) plant.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFaulhaberJobs()  — Fetch and parse all jobs
 *   - isFaulhaberJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 *
 * `validateDetailHtml()` is also exported as the testable detail-validation
 * boundary; it returns the parsed detail that the caller can reuse.
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { createHash } from 'node:crypto';
import { meetsSourceBodyFloor, sourceBodyWordCount } from './source-body-floor.mjs';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  slugify,
  buildJobSlug,
  stripHtml,
  normalizeSpace,
  fetchHtml,
  isConnectionLevelFetchError,
  WAF_IP_BLOCK_STATUS,
} from './crawler-template.mjs';
import { fetchHtmlViaJinaWithRetry, looksLikeAntiBotChallenge } from './jina-proxy.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import { isSpontaneousApplicationTitle } from './spontaneous-application.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://jobs.faulhaber.com';
const LISTING_DATA_URL = 'https://jobs.faulhaber.com/HPv3.Jobs/faulhaber/Joboffers/GetJoboffersData';
const LISTING_DATA_PATH = new URL(LISTING_DATA_URL).pathname;
const SERVER_ERROR_PATH = '/HPv3.Jobs/Errors/ServerError';
const JOB_DETAIL_PATH_RE = /^\/HPv3\.Jobs\/faulhaber\/stellenangebot\/\d+(?:\/|$)/;
const HQ = getCompanyDefaults('faulhaber');

/** @typedef {{ title: string, url: string, location: string, department: string }} FaulhaberListing */
/** @typedef {(url: string, options: { timeoutMs: number, validateRedirectUrl?: (url: string) => void }) => Promise<string>} FaulhaberHtmlFetcher */
/** @typedef {(url: string, options: { timeoutMs: number }) => Promise<string|null>} FaulhaberJinaFetcher */
/** @typedef {{ fetchHtmlImpl?: FaulhaberHtmlFetcher, fetchJinaImpl?: FaulhaberJinaFetcher }} FaulhaberFetchDependencies */

export const FAULHABER_KEY = 'faulhaber';
export const FAULHABER_COMPANY_NAME = 'Faulhaber';
export const FAULHABER_COMPANY_DOMAIN = 'faulhaber.com';

/**
 * Node-selection heuristic only: the first body block with this many
 * characters is taken as the vacancy text. Whether that text is published is
 * decided by the shared 50-word floor (source-body-floor.mjs).
 */
export const MIN_DESC_LENGTH = 100;

/** Only keep Swiss jobs from the Croglio site */
const SWISS_LOCATION_RE = /\bCH\b|croglio|schweiz|svizzera|switzerland/i;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Faulhaber.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFaulhaberJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FAULHABER_KEY ||
    key.startsWith('faulhaber') ||
    company.includes('faulhaber') ||
    url.includes('faulhaber.com')
  );
}

/**
 * Validate that a URL belongs to Faulhaber's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'faulhaber.com' || host.endsWith('.faulhaber.com');
  } catch {
    return false;
  }
}

function assertTrustedListingDataUrl(rawUrl = '') {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Faulhaber: invalid listing-data URL');
  }
  const approvedPath = url.pathname === LISTING_DATA_PATH
    || (url.pathname === SERVER_ERROR_PATH && url.searchParams.get('aspxerrorpath') === LISTING_DATA_PATH);
  if (url.protocol !== 'https:' || url.hostname !== 'jobs.faulhaber.com' || !approvedPath) {
    throw new Error(`Faulhaber: listing-data redirect escaped the approved endpoint (${url.origin}${url.pathname})`);
  }
}

function trustedDetailUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname === 'jobs.faulhaber.com'
      && JOB_DETAIL_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function detailRedirectValidator(expectedUrl) {
  const expectedPath = new URL(expectedUrl).pathname;
  return (rawUrl = '') => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Faulhaber: invalid detail redirect URL');
    }
    const approvedServerError = url.protocol === 'https:'
      && url.hostname === 'jobs.faulhaber.com'
      && url.pathname === SERVER_ERROR_PATH
      && url.searchParams.get('aspxerrorpath') === expectedPath;
    const approvedDetail = url.protocol === 'https:'
      && url.hostname === 'jobs.faulhaber.com'
      && url.pathname === expectedPath;
    if (!approvedDetail && !approvedServerError) {
      throw new Error('Faulhaber: detail URL escaped the requested vacancy');
    }
  };
}

/* ── Source parsing ───────────────────────────────────────── */

/** @returns {FaulhaberListing[]} */
function parseListingData(body = '') {
  if (!body) throw new Error('Faulhaber: empty listing-data response');
  const trimmed = String(body).trim();
  const serialized = trimmed.startsWith('{')
    ? trimmed
    : new JSDOM(trimmed).window.document.querySelector('pre')?.textContent || '';
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error('Faulhaber: listing-data response is not valid JSON');
  }
  if (!Array.isArray(payload?.Joboffers) || payload.JoboffersCount !== payload.Joboffers.length) {
    throw new Error('Faulhaber: listing-data response is incomplete');
  }
  const jobs = [];
  let swissSpontaneousApplications = 0;
  for (const row of payload.Joboffers) {
    const title = normalizeSpace(row?.JobofferName || '');
    const location = normalizeSpace(row?.LocationName || '');
    const department = normalizeSpace(row?.Department || '');
    let url;
    try {
      url = new URL(row?.JobofferUrl || '', BASE_URL).href;
    } catch {
      throw new Error('Faulhaber: listing data contains an invalid detail URL');
    }
    if (!trustedDetailUrl(url)) {
      throw new Error('Faulhaber: listing data contains an unsafe detail URL');
    }
    if (!title || !SWISS_LOCATION_RE.test(location)) continue;
    // HR4YOU lists the Croglio plant's standing "Candidatura spontanea" as an
    // offer (its `IsUnsolicitedApps` flag is not reliably set). It is an
    // application container, not a vacancy, and its one-paragraph body can
    // never meet the source-body floor (corpus run 36790878741).
    if (row?.IsUnsolicitedApps === true || isSpontaneousApplicationTitle(title)) {
      swissSpontaneousApplications += 1;
      continue;
    }
    jobs.push({ title, url, location, department });
  }
  // Non-enumerable, like the other source-proof fields of the repo: the whole
  // feed was read (`JoboffersCount` matched) and these counts describe it.
  Object.defineProperties(jobs, {
    listingOfferCount: { value: payload.Joboffers.length, enumerable: false },
    swissSpontaneousApplications: { value: swissSpontaneousApplications, enumerable: false },
  });
  return jobs;
}

/**
 * Parse a Faulhaber detail page for description and location.
 * HPv3 detail pages have the job description in structured sections.
 */
function parseDetailPage(html = '', document = null) {
  if (!html) return { description: '', location: '' };

  const parsedDocument = document || new JSDOM(html).window.document;

  // Extract location from meta or detail fields
  let location = '';
  const locationEls = parsedDocument.querySelectorAll('.tag, .detail-field, [class*="location"]');
  for (const el of locationEls) {
    const text = normalizeSpace(el.textContent || '');
    if (SWISS_LOCATION_RE.test(text)) {
      location = text;
      break;
    }
  }

  // Extract description
  const BODY_SELECTORS = [
    '.job-description',
    '.detail-content',
    '.joboffer-detail',
    '.content',
    'article',
    'main',
    '#content',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const els = parsedDocument.querySelectorAll(sel);
    for (const el of els) {
      const candidate = stripHtml(el.innerHTML || '');
      if (candidate.length > body.length) body = candidate;
    }
    if (body.length >= MIN_DESC_LENGTH) break;
  }

  if (body.length < MIN_DESC_LENGTH) {
    let best = null;
    let bestLen = 0;
    for (const el of parsedDocument.querySelectorAll('div, section, article')) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best && bestLen > body.length) {
      body = stripHtml(best.innerHTML || '');
    }
  }

  return { description: body, location };
}

export function validateDetailHtml(html = '') {
  if (!html) throw new Error('Faulhaber: empty detail response');
  const { document } = new JSDOM(html).window;
  if (!document.querySelector('.annonce #position')) {
    throw new Error('Faulhaber: detail response has no supported vacancy boundary');
  }
  const detail = parseDetailPage(html, document);
  // A page without any vacancy text is not a detail page (outage, template
  // change): the caller retries it through the proxy or fails the run. Whether
  // a real text is long enough to publish is decided by the shared 50-word
  // floor in fetchAllFaulhaberJobs, not by a character count here.
  if (!sourceBodyWordCount(detail.description)) {
    throw new Error('Faulhaber: detail response has no vacancy text');
  }
  return detail;
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = `${title} ${department}`.toLowerCase();
  if (/ingegner|engineer|entwickl|r&d|research/i.test(t)) return 'engineering';
  if (/techni|tecnic|mecanic|elektr|maschinen|cnc/i.test(t)) return 'engineering';
  if (/produk|produzi|manufactur|fertigung/i.test(t)) return 'production';
  if (/logist|magazz|lager|warehouse|supply/i.test(t)) return 'logistics';
  if (/admin|segret|contab|buchhalt|account/i.test(t)) return 'admin';
  if (/vendita|sales|verkauf|inside sales/i.test(t)) return 'sales';
  if (/qualit|qa|qc|quality|prüf/i.test(t)) return 'quality';
  if (/\bit\b|software|develop|programm|data/i.test(t)) return 'technology';
  if (/hr\b|human|risorse|personal/i.test(t)) return 'hr';
  if (/lehr|ausbildung|apprent|praktik|dual|studium|thesis/i.test(t)) return 'apprenticeship';
  return 'general';
}

function detectExperienceLevel(title = '') {
  if (/\b(lehr|ausbildung|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|junior|entry|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprent|praktik|dual|studium|thesis|schüler)/i.test(title)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chef|teamleit|gruppenleiter/i.test(title)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', description = '') {
  const combined = `${title} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Fetch a Faulhaber HR4YOU source, routing through the Jina clean-IP proxy on
 * HTTP 500. As of #6857 (verified live 2026-09-01) `jobs.faulhaber.com`'s
 * listing-data and detail routes consistently 500 for Node's egress while
 * Jina's clean IP returns the authoritative payload — the same
 * IP-reputation-WAF class `fetchHtml()` already rescues for 403/406/415/451
 * (WAF_IP_BLOCK_STATUS) and connection-level failures, just surfaced as 500
 * here instead. 500 is deliberately NOT in the generic Jina-rescue set
 * (transient-fetch.mjs: a persistent 5xx is usually a real server error and
 * Jina can't help), so this fallback is scoped to these Faulhaber fetches
 * rather than widening the shared status set for every crawler.
 */
/**
 * @template T
 * @param {string} url
 * @param {{
 *   timeoutMs: number,
 *   validateRedirectUrl: (url: string) => void,
 *   parseBody: (body: string) => T,
 *   label: string,
 *   fetchHtmlImpl?: FaulhaberHtmlFetcher,
 *   fetchJinaImpl?: FaulhaberJinaFetcher,
 * }} options
 * @returns {Promise<T>}
 */
async function fetchFaulhaberHtml(url, {
  timeoutMs,
  validateRedirectUrl,
  parseBody,
  label,
  fetchHtmlImpl = fetchHtml,
  fetchJinaImpl = fetchHtmlViaJinaWithRetry,
}) {
  try {
    const html = await fetchHtmlImpl(url, { timeoutMs, validateRedirectUrl });
    if (looksLikeAntiBotChallenge(html)) {
      console.warn(`  Direct fetch to the ${label} returned a WAF challenge page — retrying via Jina clean-IP proxy...`);
      const rescued = await fetchJinaImpl(url, { timeoutMs });
      if (rescued != null) return parseBody(rescued);
    }
    return parseBody(html);
  } catch (err) {
    if (!(isConnectionLevelFetchError(err) || WAF_IP_BLOCK_STATUS.has(err?.status) || err?.status === 500)) {
      throw err;
    }
    console.warn(`  Direct fetch to the ${label} failed (${err?.message || err}) — retrying via Jina clean-IP proxy...`);
    const html = await fetchJinaImpl(url, { timeoutMs });
    if (html != null) return parseBody(html);
    throw err;
  }
}

/**
 * @param {FaulhaberFetchDependencies} dependencies
 * @returns {Promise<FaulhaberListing[]>}
 */
export async function fetchListingData(dependencies = {}) {
  return await fetchFaulhaberHtml(LISTING_DATA_URL, {
    ...dependencies,
    timeoutMs: 20000,
    validateRedirectUrl: assertTrustedListingDataUrl,
    parseBody: parseListingData,
    label: 'listing-data endpoint',
  });
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Faulhaber jobs. Returns ParsedJob[] (source locale only).
 * Filters for the Croglio (TI) site only.
 */
/** @param {FaulhaberFetchDependencies} dependencies */
export async function fetchAllFaulhaberJobs({
  fetchHtmlImpl = fetchHtml,
  fetchJinaImpl = fetchHtmlViaJinaWithRetry,
} = /** @type {FaulhaberFetchDependencies} */ ({})) {
  console.log(`  Fetching Faulhaber jobs from ${LISTING_DATA_URL}`);
  let listings = [];
  try {
    listings = await fetchListingData({ fetchHtmlImpl, fetchJinaImpl });
  } catch (err) {
    throw new Error(`Faulhaber: failed to fetch the listing data: ${err.message}`, { cause: err });
  }
  console.log(`  Swiss jobs found in listing data: ${listings.length}`);
  if (!listings.length) {
    // `parseListingData` only returns after reading the complete feed (the
    // declared `JoboffersCount` matched every row and every detail URL was
    // trusted), so no Swiss vacancy in it is the source's own zero: retire
    // the stored Croglio jobs instead of keeping them live.
    const placeholders = Number(listings.swissSpontaneousApplications) || 0;
    return markAuthoritativeEmptySnapshot([], `HR4YOU listing data: ${listings.listingOfferCount} offer(s), `
      + `none at a Swiss site${placeholders ? ` besides ${placeholders} spontaneous-application entry` : ''}`);
  }

  const jobs = [];
  let belowFloor = 0;
  for (const listing of listings) {
    let description = '';
    let publication = sourcePostingDateFields();
    let detailLocation = listing.location;

    if (listing.url) {
      try {
        const detail = await fetchFaulhaberHtml(listing.url, {
          timeoutMs: 15000,
          validateRedirectUrl: detailRedirectValidator(listing.url),
          parseBody: (html) => {
            const detail = validateDetailHtml(html);
            const posting = extractJobPostingLd(html);
            let sameUrl = !posting?.url;
            if (posting?.url) {
              try { sameUrl = new URL(posting.url, listing.url).href === new URL(listing.url).href; }
              catch { sameUrl = false; }
            }
            const sameTitle = normalizeSpace(posting?.title || '').toLowerCase() === normalizeSpace(listing.title).toLowerCase();
            return { ...detail, ...sourcePostingDateFields(sameTitle && sameUrl ? posting?.datePosted : '') };
          },
          label: 'job detail',
          fetchHtmlImpl,
          fetchJinaImpl,
        });
        description = detail.description;
        publication = sourcePostingDateFields(detail.datePosted);
        if (!detailLocation && detail.location) detailLocation = detail.location;
      } catch (err) {
        throw new Error(`Faulhaber: failed to fetch a trusted detail page: ${err.message}`, { cause: err });
      }
    }

    // If we got no location from listing and detail didn't confirm Swiss, skip
    if (!listing.location && !SWISS_LOCATION_RE.test(detailLocation)) continue;

    // The shared 50-word floor (source-body-floor.mjs): a shorter text is not
    // published this run (the standard pipeline keeps the stored record for
    // its grace runs); 100 characters let a 20-word body through. Nothing is
    // ever composed in its place.
    if (!meetsSourceBodyFloor(description)) {
      belowFloor += 1;
      console.warn(`  ⏭️ ${listing.title}: source body under 50 words — not published this run (${listing.url})`);
      continue;
    }

    // Language of the published body, not of the title (issue 5253): titles
    // are loanword soup ("Candidatura spontanea", "Junior Logistics
    // Specialist", "Guest Experience Specialist") and filed the body under a
    // foreign source slot. The title is only the fallback when no body exists.
    const sourceLang = detectLang(description || listing.title, 'de');
    const jobSlug = buildJobSlug(`${listing.title} Croglio`, 'faulhaber');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, description);

    jobs.push({
      id: `${FAULHABER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FAULHABER_COMPANY_NAME,
      companyKey: FAULHABER_KEY,
      companyDomain: FAULHABER_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Croglio',
      canton: HQ.canton,
      addressLocality: 'Croglio',
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title, listing.department),
      sector: 'Meccanica di precisione / Motori elettrici',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      ...publication,
      url: listing.url,
      applyUrl: listing.url,
      source: 'Faulhaber Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  // Not one vacancy with a publishable body is a source-level failure (a
  // transient detail outage): fail the run so the previous slice stays,
  // instead of publishing thin text or emptying the slice.
  if (jobs.length === 0 && belowFloor > 0) {
    throw new Error(`Faulhaber: no detail page with a source body of 50 words (${belowFloor} below the floor)`);
  }
  console.log(`  Total Faulhaber jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Rituals Cosmetics Switzerland job parser — official Rituals careers site.
 *
 * Career URL:  https://careers.rituals.com/de-CH/jobs/
 *
 * Rituals is a Dutch cosmetics / home-fragrance retailer with a large Swiss
 * retail network (shop-in-shop counters inside Manor department stores plus
 * standalone boutiques). Swiss legal entity HQ: Landquart GR.
 *
 * The former Workday tenant stopped being the source for the official CH
 * career pages. The public board now exposes job links and store locations on
 * the branded site, with the vacancy body on each detail page. The parser
 * treats an unreadable page or detail as an incomplete snapshot and never
 * converts a transport/selector failure into an empty corpus.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRitualsCosmeticsJobs() — Fetch and parse all Swiss jobs
 *   - isRitualsCosmeticsJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()              — Validate URLs belong to the official source
 *   - RITUALS_COSMETICS_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { mergeSourcePostingDates, sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { appendSlugDisambiguator, detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import {
  fetchHtml,
  normalizeDescriptionSpace,
  normalizeSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';
import { inferSwissTargetCanton, swissCityFromLocationField } from './target-swiss-locations.mjs';
import { extractJobPostingNodesFromJson } from './jobposting-jsonld.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RITUALS_COSMETICS_KEY = 'rituals-cosmetics';
export const RITUALS_COSMETICS_COMPANY_NAME = 'Rituals Cosmetics Switzerland';
export const RITUALS_COSMETICS_COMPANY_DOMAIN = 'rituals.com';

export const RITUALS_COSMETICS_CAREER_URL = 'https://careers.rituals.com/de-CH/jobs/';
const RITUALS_CAREER_ENTRY_URLS = [
  RITUALS_COSMETICS_CAREER_URL,
  'https://careers.rituals.com/de-CH/',
  'https://careers.rituals.com/de-CH/shops/',
  'https://careers.rituals.com/de-CH/holidayjobs/',
];
const RITUALS_CAREERS_HOST = 'careers.rituals.com';
const KALIBER_CAREERS_HOST = 'rituals-careers-prd.kaliber.io';
const LEGACY_WORKDAY_HOST = 'rituals.wd3.myworkdayjobs.com';
const LISTING_PAGE_SIZE = 20;
const MAX_LISTING_PAGES = 100;

// Store localities the federal register does not list as municipalities, so
// the gazetteer cannot resolve them: Shoppyland Schönbühl lies in
// Urtenen-Schönbühl (BE). The GR legal seat used to fill this gap and
// published 30 Bernese store vacancies as Grisons ones.
const RITUALS_STORE_LOCALITY_CANTONS = new Map([
  ['schönbühl', 'BE'],
  ['schoenbuehl', 'BE'],
]);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Rituals location strings look like:
 *   "Basel St Jakob Park"
 *   "Manor Winterthur"
 *   "Landquart Fashion Outlet"
 *   "Zürich Bahnhofstraße 69a"
 * No country/canton prefix, no separator. Strip a leading department-store
 * partner name, then look up a known Swiss city token in the remainder
 * (falls back to the raw text, then the first word).
 */
function cleanRitualsLocation(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/\d+\s+location/i.test(trimmed)) return '';
  const stripped = trimmed.replace(/^\s*(manor|coop|migros|globus|jelmoli)\s+/i, '').trim() || trimmed;
  const city = swissCityFromLocationField(stripped, { allowUnqualifiedEnglishExonyms: true })
    || swissCityFromLocationField(trimmed, { allowUnqualifiedEnglishExonyms: true });
  if (city) return city;
  return stripped.split(/\s+/)[0] || trimmed.split(/\s+/)[0] || '';
}

/* ── Company matchers ──────────────────────────────────────── */

export function isRitualsCosmeticsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const sourceUrl = String(job?.url || '');

  return (
    key === RITUALS_COSMETICS_KEY ||
    key.startsWith('rituals') ||
    company.includes('rituals') ||
    isTrustedDomain(sourceUrl)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === RITUALS_COSMETICS_COMPANY_DOMAIN ||
      host.endsWith(`.${RITUALS_COSMETICS_COMPANY_DOMAIN}`) ||
      host === RITUALS_CAREERS_HOST ||
      host === KALIBER_CAREERS_HOST ||
      host === LEGACY_WORKDAY_HOST
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(store\s*manager|filialleiter|assistant\s*store|stellvertret)/.test(t)) return 'Vendite';
  if (/\b(verkauf|sales|kundenberat|beauty\s*advisor|advisor)/.test(t)) return 'Vendite';
  if (/\b(warenverr|stockroom|lager|logist|supply|magazzin)/.test(t)) return 'Logistica';
  if (/\b(market|kommunikation|brand)/.test(t)) return 'Marketing';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|controlling|buchhalt|finanz)/.test(t)) return 'Finanza';
  if (/\b(it\b|sap|cloud|cyber|data|digital)/.test(t)) return 'IT';
  return 'Vendite';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|lehrstelle|lernende?r?|apprenti|ausbildung|trainee|aushilfe)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|principal|manager|leiter|leitend|verantwort|filialleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|teilzeit|aushilfe|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b\d{1,3}\s*[-–]\s*\d{1,3}\s*(?:hours?|stunden|heures?|ore)\b/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Official careers-site fetcher ────────────────────────── */

function attachFetchMetadata(jobs, { discoveredCount = 0, fetchOutcome = 'selector_miss' } = {}) {
  Object.defineProperties(jobs, {
    discoveredCount: { value: discoveredCount, enumerable: false },
    fetchOutcome: { value: fetchOutcome, enumerable: false },
  });
  return jobs;
}

function jobPostingPath(rawUrl = '') {
  try {
    const url = new URL(rawUrl, RITUALS_COSMETICS_CAREER_URL);
    if (!isTrustedDomain(url.href)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const jobsIndex = parts.findIndex((part) => part.toLowerCase() === 'jobs');
    if (jobsIndex < 1 || parts.length < jobsIndex + 3) return null;
    const locale = parts[jobsIndex - 1];
    const slug = parts[jobsIndex + 1];
    const jobId = parts[jobsIndex + 2];
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale) || !slug || !jobId) return null;
    return {
      url: `${url.origin}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`,
      jobId,
    };
  } catch {
    return null;
  }
}

function extractListingTotal(html = '') {
  const text = normalizeSpace(stripHtml(html));
  const match = text.match(/\b\d+\s*(?:of|von|sur|di)\s*(\d+)\s*(?:jobs?|stellen|postes?|posti)\b/i);
  return match ? Number(match[1]) : null;
}

function listingCardForLink(link) {
  const title = normalizeSpace(link.textContent || '');
  let node = link;
  let fallback = link.parentElement || link;
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    const text = normalizeSpace(node.textContent || '');
    if (!text || (title && !text.includes(title))) continue;
    if (text.length <= 800 && /(?:hours?|stunden|heures?|ore)\b/i.test(text)) return node;
    fallback = node;
  }
  return fallback;
}

function extractListingLocation(card, title) {
  const text = normalizeSpace(stripHtml(card?.innerHTML || card?.textContent || ''));
  const lines = text.split(/\n+/).map(normalizeSpace).filter(Boolean);
  const metadata = lines.find((line) => /(?:hours?|stunden|heures?|ore)\b/i.test(line)) || text;
  const parts = metadata.split(/\s*[•·|]\s*/).map(normalizeSpace).filter(Boolean);
  const workloadIndex = parts.findIndex((part) => /(?:hours?|stunden|heures?|ore)\b/i.test(part));
  if (workloadIndex > 0) {
    const candidates = parts.slice(0, workloadIndex).filter((part) => part !== title);
    if (candidates.length > 0) return candidates.at(-1);
  }
  return lines.find((line) => line !== title && !/(?:hours?|stunden|heures?|ore)\b/i.test(line)) || '';
}

/** Parse detail links from the server-rendered official careers page. */
export function parseRitualsListingPage(html = '', pageUrl = RITUALS_COSMETICS_CAREER_URL) {
  const document = new JSDOM(String(html || '')).window.document;
  const rows = [];
  const seen = new Set();
  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') || '';
    let posting;
    try {
      posting = jobPostingPath(new URL(href, pageUrl).href);
    } catch {
      posting = null;
    }
    if (!posting || seen.has(posting.url)) continue;
    const card = listingCardForLink(link);
    const title = normalizeSpace(card?.querySelector('h2,h3,h4')?.textContent || link.textContent || '');
    if (!title || title.length < 3) continue;
    seen.add(posting.url);
    rows.push({
      title,
      url: posting.url,
      jobReqId: posting.jobId,
      locationRaw: extractListingLocation(card, title),
      timeType: normalizeSpace(card?.textContent || ''),
    });
  }
  return rows;
}

function paginationUrl(pageUrl, offset) {
  const url = new URL(pageUrl);
  url.searchParams.set('from', String(offset));
  return url.href;
}

function listingFailure(message, discoveredCount, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.specListingFailure = true;
  error.specDiscoveredCount = discoveredCount;
  return error;
}

async function fetchJobListings({ fetchHtmlImpl = fetchHtml } = {}) {
  const firstUrl = RITUALS_CAREER_ENTRY_URLS[0];
  const firstHtml = await fetchHtmlImpl(firstUrl, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    validateRedirectUrl: isTrustedDomain,
  });
  const listings = [];
  const seen = new Set();
  let pageUrl = firstUrl;
  let html = firstHtml;
  let total = null;

  let complete = false;
  for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
    const rows = parseRitualsListingPage(html, pageUrl);
    total = total ?? extractListingTotal(html);
    const before = listings.length;
    for (const row of rows) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      listings.push(row);
    }
    if (total != null && listings.length >= total) {
      complete = true;
      break;
    }
    if (rows.length < LISTING_PAGE_SIZE && total == null) {
      complete = true;
      break;
    }
    if (listings.length === before) {
      throw listingFailure(
        `Rituals careers listing pagination repeated page ${pageUrl}`,
        listings.length,
      );
    }

    const nextUrl = paginationUrl(firstUrl, (page + 1) * LISTING_PAGE_SIZE);
    try {
      html = await fetchHtmlImpl(nextUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        validateRedirectUrl: isTrustedDomain,
      });
      pageUrl = nextUrl;
    } catch (error) {
      throw listingFailure(
        `Rituals careers listing page ${nextUrl} could not be read`,
        listings.length,
        error,
      );
    }
  }

  if (!complete) {
    throw listingFailure(
      `Rituals careers listing exceeded the ${MAX_LISTING_PAGES}-page bound`,
      listings.length,
    );
  }

  if (listings.length > 0) {
    return { listings, discoveredCount: listings.length, fetchOutcome: 'ok' };
  }

  // These branded pages are a bounded recovery when the listing route has
  // rendered its shell but no cards. A zero-card result remains selector_miss;
  // it is never treated as proof that the source is empty.
  for (const entryUrl of RITUALS_CAREER_ENTRY_URLS.slice(1)) {
    let entryHtml;
    try {
      entryHtml = await fetchHtmlImpl(entryUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        validateRedirectUrl: isTrustedDomain,
      });
    } catch (error) {
      if (error?.status === 404) continue;
      throw error;
    }
    for (const row of parseRitualsListingPage(entryHtml, entryUrl)) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      listings.push(row);
    }
  }
  return {
    listings,
    discoveredCount: listings.length,
    fetchOutcome: listings.length > 0 ? 'ok' : 'selector_miss',
  };
}

function structuredUrlStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(structuredUrlStrings);
  if (!value || typeof value !== 'object') return [];
  return [value['@id'], value.url].flatMap(structuredUrlStrings);
}

function jobPostingUrls(posting) {
  for (const value of [posting?.url, posting?.mainEntityOfPage, posting?.['@id']]) {
    const urls = structuredUrlStrings(value).map((url) => url.trim()).filter(Boolean);
    if (urls.length > 0) return urls;
  }
  return [];
}

function sameRitualsPostingUrl(left, right) {
  const leftPosting = jobPostingPath(left);
  const rightPosting = jobPostingPath(right);
  if (!leftPosting || !rightPosting || leftPosting.jobId !== rightPosting.jobId) return false;
  return new URL(leftPosting.url).pathname === new URL(rightPosting.url).pathname;
}

function parseJobPostingJsonLd(document, listingUrl = '') {
  const urlLessNodes = [];
  const requestedPosting = jobPostingPath(listingUrl);
  let nodeCount = 0;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const nodes = extractJobPostingNodesFromJson(JSON.parse(script.textContent || ''));
      nodeCount += nodes.length;
      for (const node of nodes) {
        const urls = jobPostingUrls(node);
        if (requestedPosting && urls.some((url) => sameRitualsPostingUrl(url, listingUrl))) {
          return node;
        }
        if (urls.length === 0) urlLessNodes.push(node);
      }
    } catch {
      // An unrelated malformed JSON-LD block must not hide the detail body.
    }
  }
  return nodeCount === 1 && urlLessNodes.length === 1 ? urlLessNodes[0] : null;
}

function removeSourceChrome(root) {
  for (const element of root.querySelectorAll('script,style,noscript,nav,header,footer,aside,form')) {
    element.remove();
  }
}

function extractDetailDescription(document) {
  const main = document.querySelector('main,[role="main"],article');
  if (!main) return '';
  const h1 = main.querySelector('h1');
  if (!h1) return '';
  const stopHeading = [...main.querySelectorAll('h2,h3')].find((heading) =>
    /^(?:mehr|more|plus|più)\s+(?:shop|store|career|karrier|job|stelle|poste)/i.test(normalizeSpace(heading.textContent || '')),
  );
  const range = document.createRange();
  range.setStartAfter(h1);
  if (stopHeading) range.setEndBefore(stopHeading);
  else range.setEndAfter(main.lastChild || h1);
  const wrapper = document.createElement('div');
  wrapper.appendChild(range.cloneContents());
  removeSourceChrome(wrapper);
  return normalizeDescriptionSpace(stripHtml(wrapper.innerHTML));
}

function detailLocation(document, listing, posting) {
  const address = Array.isArray(posting?.jobLocation)
    ? posting.jobLocation[0]?.address
    : posting?.jobLocation?.address;
  const structured = address?.addressLocality || posting?.jobLocation?.name || '';
  const candidates = [listing.locationRaw, structured];
  const main = document.querySelector('main,[role="main"],article');
  if (main) {
    const lines = stripHtml(main.innerHTML).split(/\n+/).map(normalizeSpace).filter(Boolean);
    candidates.push(...lines.slice(0, 12));
  }
  for (const candidate of candidates) {
    const location = cleanRitualsLocation(candidate);
    if (!location) continue;
    const storeCanton = RITUALS_STORE_LOCALITY_CANTONS.get(normalize(location).normalize('NFC'));
    if (storeCanton || inferSwissTargetCanton(location)) return location;
  }
  return '';
}

export function parseRitualsDetailPage(html = '', listing = {}) {
  const document = new JSDOM(String(html || '')).window.document;
  const posting = parseJobPostingJsonLd(document, listing.url);
  const title = normalizeSpace(posting?.title || document.querySelector('main h1,h1')?.textContent || listing.title || '');
  const jsonDescription = posting?.description ? stripHtml(String(posting.description)) : '';
  const htmlDescription = extractDetailDescription(document);
  const description = normalizeDescriptionSpace(
    meetsSourceBodyFloor(jsonDescription) ? jsonDescription : htmlDescription,
  );
  const location = detailLocation(document, listing, posting);
  const employmentType = Array.isArray(posting?.employmentType)
    ? posting.employmentType.join(' ')
    : String(posting?.employmentType || listing.timeType || '');
  const datePosted = sourcePostingDateFields(String(posting?.datePosted || ''));
  return { title, description, location, employmentType, ...datePosted };
}

/* ── Slug identity ─────────────────────────────────────────── */

/**
 * Stable per-requisition slug suffix (crawler-template `slugDisambiguator`).
 *
 * Rituals runs several concurrent reqs for the same role in the same city,
 * often at the same store (see the "Job ID" note below). Their routes are
 * built from title + company (+ city once localized), so without a per-req
 * suffix those reqs collided on one slug, and the slice housekeeping kept one
 * req per slug and archived the others as within-slice duplicates. On
 * 2026-09-30 that filed 159 of the 665 live reqs under
 * data/jobs/expired/by-crawler/rituals-cosmetics.json; they came back as
 * "new" on the next crawl and were archived again, so the archive swung
 * between ~40 KB and ~1 MB twice a day while the downstream ghost
 * reconciliation removed them, and the accumulator byte guard aborted the
 * writers that saw the swing.
 *
 * The requisition ID is the req's own identity; the URL hash only covers a
 * posting whose source omits one.
 */
export function ritualsSlugDisambiguator(jobReqId = '', publicUrl = '') {
  const fromReqId = String(jobReqId || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (fromReqId) return fromReqId;
  return publicUrl ? createHash('sha1').update(publicUrl).digest('hex').slice(0, 8) : '';
}

function normalizeReqId(value) {
  return String(value || '').trim().toUpperCase();
}

/** Index the published Rituals slice by requisition ID and by job id. */
function indexPublishedRitualsJobs(existingJobs = []) {
  const byReqId = new Map();
  const byId = new Map();
  for (const job of Array.isArray(existingJobs) ? existingJobs : []) {
    if (!job || typeof job !== 'object' || !isRitualsCosmeticsJob(job)) continue;
    const reqId = normalizeReqId(job.jobReqId);
    if (reqId && !byReqId.has(reqId)) byReqId.set(reqId, job);
    const id = String(job.id || '').trim();
    if (id && !byId.has(id)) byId.set(id, job);
  }
  return { byReqId, byId };
}

/**
 * @param {{ existingJobs?: object[] }} [options] `existingJobs` is the
 *   published slice: a req already in it keeps the route it is indexed under
 *   (and the suffix it was minted with, if any). Only an unpublished req gets
 *   a new `slugDisambiguator`, because a new suffix on a published job is an
 *   explicit route migration for the slug pipeline.
 */
export async function fetchAllRitualsCosmeticsJobs({ existingJobs = [], _fetchHtml = fetchHtml } = {}) {
  const published = indexPublishedRitualsJobs(existingJobs);
  console.log(`🏭 Fetching ${RITUALS_COSMETICS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${RITUALS_COSMETICS_CAREER_URL}\n`);

  const listingResult = await fetchJobListings({ fetchHtmlImpl: _fetchHtml });
  const { listings, discoveredCount, fetchOutcome } = listingResult;
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Rituals job links were observed on the official careers source.');
    return attachFetchMetadata([], { discoveredCount, fetchOutcome });
  }

  console.log(`  📋 Swiss listings found: ${listings.length}`);

  const jobs = [];
  let withoutBody = 0;
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = normalizeSpace(listing.locationRaw || '');
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    const publicUrl = listing.url || RITUALS_COSMETICS_CAREER_URL;
    let detailHtml;
    try {
      detailHtml = await _fetchHtml(publicUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        validateRedirectUrl: isTrustedDomain,
      });
    } catch (cause) {
      const error = new Error(
        `Rituals careers detail could not be read: ${publicUrl}`,
        { cause },
      );
      error.specDetailDrop = { candidates: listings.length, gone: 0, rejected: 1 };
      error.specDiscoveredCount = listings.length;
      throw error;
    }
    const detail = parseRitualsDetailPage(detailHtml, listing);
    const detailDescription = detail.description;
    const location = detail.location || cleanRitualsLocation(rawLocation);
    const canton = location
      ? (RITUALS_STORE_LOCALITY_CANTONS.get(normalize(location).normalize('NFC'))
        || inferSwissTargetCanton(location)
        || inferSwissTargetCanton(rawLocation))
      : '';
    if (!canton) {
      console.log(`  ⏭️  Skipped location without a Swiss canton: ${rawLocation || '(none)'} — ${title}`);
      continue;
    }
    const employmentType = detectEmploymentType(
      `${listing.timeType || ''} ${detail.employmentType || ''}`,
      title,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Only the posting's own text is published (issue 5253). A detail page
    // without a source body stays out of this run; the standard pipeline keeps
    // any valid stored body under its normal miss-grace rules.
    if (!meetsSourceBodyFloor(detailDescription)) {
      console.log(`  ⏭️  No vacancy text in the Rituals detail, not published: ${title}`);
      withoutBody += 1;
      continue;
    }
    const baseDescription = detailDescription;

    const sourceLang = detectLang(baseDescription || title, 'de');

    const jobRefId = listing.jobReqId || publicUrl.split('_').pop() || publicUrl.slice(-10);
    const storeLine = detailDescription.length >= 100
      ? `Store: ${rawLocation}${canton ? `, ${canton}` : ''}, Switzerland. Job ID: ${jobRefId}.\n\n`
      : '';
    const descriptionText = `${storeLine}${baseDescription}`;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    // Same role in the same city is the normal case on this board, so an
    // unpublished req is minted with its own suffix; a published one keeps
    // its indexed route (see ritualsSlugDisambiguator).
    const publishedJob = published.byReqId.get(normalizeReqId(listing.jobReqId))
      || published.byId.get(`${RITUALS_COSMETICS_KEY}-${urlHash}`);
    const id = publishedJob?.id || `${RITUALS_COSMETICS_KEY}-${urlHash}`;
    const slugDisambiguator = publishedJob
      ? String(publishedJob.slugDisambiguator || '').trim()
      : ritualsSlugDisambiguator(listing.jobReqId, publicUrl);
    const jobSlug = appendSlugDisambiguator(
      slugify(`${title} ${RITUALS_COSMETICS_KEY} ch`),
      slugDisambiguator,
    );

    const job = {
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      ...(slugDisambiguator ? { slugDisambiguator } : {}),
      company: RITUALS_COSMETICS_COMPANY_NAME,
      companyKey: RITUALS_COSMETICS_KEY,
      companyDomain: RITUALS_COSMETICS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, translate-pending.yml picks the job up.
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: `${RITUALS_COSMETICS_COMPANY_NAME} Dedicated Parser (official careers)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Cosmetica / Retail',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates(listing, detail),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.jobReqId) job.jobReqId = listing.jobReqId;

    jobs.push(job);
  }

  if (withoutBody > 0) {
    console.log(`  ⏭️  ${withoutBody} req(s) without vacancy text in the Rituals detail — not published.`);
  }
  console.log(`\n📋 Total ${RITUALS_COSMETICS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return attachFetchMetadata(jobs, { discoveredCount, fetchOutcome });
}

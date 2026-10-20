#!/usr/bin/env node
/**
 * Implenia job parser — Fetcher and job builder.
 *
 * Source: https://jobs.implenia.com/search-results
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllImpleniaJobs()  — Fetch and parse all jobs
 *   - isImpleniaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import {
  addPreviousSlugForLocale,
  decodeHtmlEntitiesOnce,
  detectLang,
  promotePreviousSlugToLegacy,
} from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { extractMicrodataDescription, extractJobPostingField } from './jobposting-jsonld.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const IMPLENIA_KEY = 'implenia';
export const IMPLENIA_COMPANY_NAME = 'Implenia';
export const IMPLENIA_COMPANY_DOMAIN = 'implenia.com';

const CAREER_URL = 'https://jobs.implenia.com/search-results';
const JOBS_API_URL = 'https://jobs.implenia.com/services/recruiting/v1/jobs';
const JOB_HOST = 'jobs.implenia.com';

// Browser-like UA: the SuccessFactors RMK (jobs2web) front-end gates the
// CSRF-token bootstrap and the JSON endpoint behind a realistic UA.
const BROWSER_UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PAGE_SIZE = 10; // RMK listing page size (confirmed live)

// Known HQ metadata (recon): Implenia HQ — Glattpark (Opfikon), ZH, 8152.
// It completes the address only when the source itself names this locality;
// streetAddress is confirmed in RMK jobLocationShort address-form samples.
const HQ = {
  city: 'Glattpark (Opfikon)',
  canton: 'ZH',
  postalCode: '8152',
  addressRegion: 'Zürich',
  streetAddress: 'Thurgauerstrasse 101A',
};

const SECTOR =
  'Construction & Construction Services (civil engineering, building construction, real estate)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Build the RMK detail URL from the API's URL title exactly once.
 *
 * The API sometimes serializes the title as an HTML attribute value even
 * though it is returned in JSON (`&apos;`, `&#39;`, `&quot;`, `&amp;`). Decode the
 * original URL once here; never feed the result through a second decoder.
 */
export function buildImpleniaJobUrl(urlTitle = '', id = '') {
  const reqId = String(id || '').trim();
  if (!reqId) return '';
  const title = String(urlTitle || '');
  const rawUrl = title
    ? `https://${JOB_HOST}/job/${title}/${reqId}-de_DE`
    : `https://${JOB_HOST}/job/${reqId}-de_DE`;
  return decodeHtmlEntitiesOnce(rawUrl);
}

const IMPLENIA_REQUISITION_PATH_RE = /^https?:\/\/jobs\.implenia\.com\/job\/(?:[^/?#]+\/)?(\d+)-de_de$/i;

/** Merge key used before detail fetching, on the stable requisition id. */
export function impleniaJobMatchKey(jobOrUrl = '') {
  const url = String(typeof jobOrUrl === 'string' ? jobOrUrl : jobOrUrl?.url || '');
  // `/job/<titolo>/<req>-de_DE`: il titolo e' testo di presentazione (puo'
  // differire solo per come e' scritta un'entita' HTML), il numero finale e'
  // la posizione. La chiave resta in questo parser: la chiave URL comune
  // (`job-url-key.mjs`) non cambia per gli altri crawler.
  const match = IMPLENIA_REQUISITION_PATH_RE.exec(url.split(/[?#]/)[0]);
  return match ? `req:${JOB_HOST}:${match[1]}` : '';
}

const IMPLENIA_LOCALE_MAP_FIELDS = [
  'titleByLocale',
  'descriptionByLocale',
  'requirementsByLocale',
];

function mergeImpleniaLocaleMaps(older = {}, newer = {}) {
  const merged = { ...(newer || {}) };
  for (const [locale, oldValue] of Object.entries(older || {})) {
    const newValue = merged[locale];
    if (Array.isArray(oldValue) || Array.isArray(newValue)) {
      merged[locale] = [...new Set([
        ...(Array.isArray(oldValue) ? oldValue : []),
        ...(Array.isArray(newValue) ? newValue : []),
      ])];
    } else if (oldValue !== undefined && oldValue !== null && oldValue !== '') {
      merged[locale] = oldValue;
    }
  }
  return merged;
}

function jobTimestamp(job, field) {
  const value = Date.parse(String(job?.[field] || ''));
  return Number.isFinite(value) ? value : null;
}

function impleniaRecordAge(job) {
  return jobTimestamp(job, 'firstSeenAt')
    ?? jobTimestamp(job, 'crawledAt')
    ?? Number.POSITIVE_INFINITY;
}

function normalizeStoredImpleniaJob(job) {
  const copy = { ...job };
  for (const field of ['url', 'applyUrl']) {
    if (copy[field]) copy[field] = decodeHtmlEntitiesOnce(copy[field]);
  }
  return copy;
}

function addImpleniaDuplicateSlugHistory(merged, older, newer) {
  for (const [locale, slugs] of Object.entries(newer.previousSlugsByLocale || {})) {
    if (!Array.isArray(slugs)) continue;
    for (const slug of slugs) {
      addPreviousSlugForLocale(merged, locale, slug, undefined, 'implenia-duplicate-history');
    }
  }

  const hasLocaleHistory = (slug) => Object.values(merged.previousSlugsByLocale || {})
    .some((slugs) => Array.isArray(slugs) && slugs.includes(slug));
  for (const slug of Array.isArray(newer.previousSlugs) ? newer.previousSlugs : []) {
    if (!merged.previousSlugs?.includes(slug) && !hasLocaleHistory(slug)) {
      promotePreviousSlugToLegacy(merged, slug, undefined, 'implenia-duplicate-history');
    }
  }

  const olderSlugsByLocale = older.slugByLocale || {};
  for (const [locale, slug] of Object.entries(newer.slugByLocale || {})) {
    if (slug && normalizeSpace(slug) !== normalizeSpace(olderSlugsByLocale[locale] || '')) {
      addPreviousSlugForLocale(merged, locale, slug, undefined, 'implenia-duplicate-active-bridge');
    }
  }

  if (newer.slug && normalizeSpace(newer.slug) !== normalizeSpace(older.slug || '')) {
    addPreviousSlugForLocale(merged, 'it', newer.slug, undefined, 'implenia-duplicate-active-bridge');
  }
}

function mergeImpleniaDuplicateRecords(first, second) {
  const older = impleniaRecordAge(first) <= impleniaRecordAge(second) ? first : second;
  const newer = older === first ? second : first;
  const merged = structuredClone({ ...newer, ...older });

  for (const field of IMPLENIA_LOCALE_MAP_FIELDS) {
    merged[field] = mergeImpleniaLocaleMaps(older[field], newer[field]);
  }
  addImpleniaDuplicateSlugHistory(merged, older, newer);

  const firstSeen = [jobTimestamp(first, 'firstSeenAt'), jobTimestamp(second, 'firstSeenAt')]
    .filter((value) => value !== null)
    .sort((a, b) => a - b)[0];
  if (firstSeen !== undefined) merged.firstSeenAt = new Date(firstSeen).toISOString();

  const crawled = [jobTimestamp(first, 'crawledAt'), jobTimestamp(second, 'crawledAt')]
    .filter((value) => value !== null)
    .sort((a, b) => b - a)[0];
  if (crawled !== undefined) merged.crawledAt = new Date(crawled).toISOString();

  return merged;
}

/**
 * Collapse Implenia records on the stable requisition key. normalizeUrls is
 * intended for stored rows only: fresh parser URLs have already gone through
 * the one-pass decoder and must not be decoded a second time.
 */
export function dedupeImpleniaJobsByStableId(items = [], { normalizeUrls = false } = {}) {
  const result = [];
  const indexByKey = new Map();

  for (const rawJob of Array.isArray(items) ? items : []) {
    const job = normalizeUrls ? normalizeStoredImpleniaJob(rawJob) : rawJob;
    const key = impleniaJobMatchKey(job);
    if (!key || !indexByKey.has(key)) {
      if (key) indexByKey.set(key, result.length);
      result.push(job);
      continue;
    }
    const index = indexByKey.get(key);
    result[index] = mergeImpleniaDuplicateRecords(result[index], job);
  }

  return result;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Implenia.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isImpleniaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === IMPLENIA_KEY ||
    key.startsWith('implenia') ||
    company.includes('implenia') ||
    url.includes('implenia.com')
  );
}

/**
 * Validate that a URL belongs to Implenia's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'implenia.com' ||
      host.endsWith('.implenia.com') || // covers jobs.implenia.com (the real job-posting host)
      host === 'career2.successfactors.eu' ||
      host.endsWith('.successfactors.eu') // SF RMK tenant backing the front-end
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

// JS `\b` is ASCII-only: a diacritic (ü, é, …) counts as a non-word char, so a
// short token like `hr` falsely word-boundary-matches inside "Bauführer"
// (ba-ü|hr-er). Fold diacritics to ASCII first so boundaries align with real
// word edges — otherwise German/French construction titles mis-route to HR/IT.
function foldForMatch(text = '') {
  return normalize(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function detectCategory(title = '') {
  const t = foldForMatch(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = foldForMatch(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bootstrap the SuccessFactors RMK (jobs2web) session:
 * GET /search-results → capture the JSESSIONID cookie + the inline CSRFToken.
 * Both are required for the POST /services/recruiting/v1/jobs endpoint
 * (without the X-CSRF-Token header the POST returns HTTP 400).
 */
async function bootstrapSession() {
  const res = await fetchWithTimeout(CAREER_URL, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bootstrapping ${CAREER_URL}`);

  // Collect Set-Cookie values into a single Cookie header.
  const rawCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const cookie = rawCookies
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');

  const html = await res.text();
  const tokenMatch = html.match(/CSRFToken\s*=\s*["']([0-9a-fA-F-]{20,})["']/);
  if (!tokenMatch) throw new Error('CSRF token not found in search-results HTML');

  return { cookie, csrfToken: tokenMatch[1] };
}

/**
 * Fetch all CH job listings via the documented RMK JSON endpoint,
 * filtering strictly by facetFilters.jobLocationCountry = ['Schweiz']
 * (do NOT filter by legalEntity — that mixes in DE GmbHs).
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  const { cookie, csrfToken } = await bootstrapSession();
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    Referer: CAREER_URL,
    Origin: 'https://jobs.implenia.com',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const listings = [];
  let pageNumber = 0;
  let totalJobs = Infinity;

  while (pageNumber * PAGE_SIZE < totalJobs) {
    const body = JSON.stringify({
      locale: 'de_DE',
      pageNumber, // 0-based
      keywords: '',
      location: '',
      facetFilters: { jobLocationCountry: ['Schweiz'] },
      brand: '',
      skills: [],
      categoryId: 0,
      sortBy: '',
      alertId: '',
      rcmCandidateId: '',
    });

    const res = await fetchWithTimeout(JOBS_API_URL, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`HTTP ${res.status} from jobs API (page ${pageNumber})`);

    const data = await res.json();
    if (Number.isFinite(data.totalJobs)) totalJobs = data.totalJobs;

    const results = assertJsonListShape(data, { key: 'jobSearchResult', source: 'implenia' });
    if (results.length === 0) break;

    for (const item of results) {
      const r = item?.response || {};
      const id = String(r.id || '');
      const title = normalizeSpace(r.unifiedStandardTitle || '');
      if (!id || !title) continue;

      const urlTitle = r.unifiedUrlTitle || r.urlTitle || '';
      const url = buildImpleniaJobUrl(urlTitle, id);

      const { location, postalCode, streetAddress } = parseLocation(r.jobLocationShort);
      const jobFunction = Array.isArray(r.cust_JobFunction) ? r.cust_JobFunction[0] : '';
      const contractType = Array.isArray(r.cust_contractType) ? r.cust_contractType[0] : '';

      listings.push({
        jobReqId: id,
        title,
        url,
        location,
        postalCode,
        streetAddress,
        jobFunction: normalizeSpace(jobFunction || ''),
        contractType: normalizeSpace(contractType || ''),

      });
    }

    pageNumber += 1;
    if (pageNumber > 50) break; // hard safety cap
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return listings;
}

/**
 * Parse the RMK jobLocationShort field into a clean city + postalCode.
 * Observed formats (all CH):
 *   "Gisikon, CHE, 6038<br/>"                              → city, plz
 *   "Glattpark (Opfikon), CHE, 8152<br/>"                  → city, plz
 *   "Aarau, AG, CHE, 5000<br/>"                            → city, region, country, plz
 *   "Thurgauerstrasse 101A 8152 Glattpark (Opfikon) "      → street plz city
 *   "Thurgauerstrasse 101A "                               → street only (no plz/city)
 *   "Zihlmattweg 46 Postfach-6002 Luzern "                 → street pobox city (no real plz)
 *   "CHE, " / ""                                            → empty
 * Multiple locations may be present (array); take the first.
 */
function parseLocation(jobLocationShort) {
  const arr = Array.isArray(jobLocationShort) ? jobLocationShort : [jobLocationShort];
  const raw = normalizeSpace(stripHtml(String(arr[0] || '')));
  if (!raw || /^CHE,?\s*$/i.test(raw)) return { location: '', postalCode: '', streetAddress: '' };

  // Comma-delimited form: "City[, REGION], CHE[, PLZ]". The first segment is the
  // city; CHE / 2-letter region codes are noise; a trailing 4-digit group is the plz.
  // No street is present in this form.
  if (raw.includes(',')) {
    const segs = raw.split(',').map((s) => normalizeSpace(s)).filter(Boolean);
    const plz = (raw.match(/\b(\d{4})\b/) || [])[1] || '';
    const city = segs.find((s) => !/^CHE$/i.test(s) && !/^[A-Z]{2}$/.test(s) && !/^\d{4}$/.test(s)) || '';
    if (city) return { location: city, postalCode: plz, streetAddress: '' };
  }

  // Address form: "Street 8152 City" — a 4-digit postal code followed by the city
  // name, with a real street address preceding it. Guard against "Postfach-6002"
  // (PO box): require the plz to be preceded by a space.
  const inline = raw.match(/(?:^|\s)(\d{4})\s+([^\d].*?)\s*$/);
  if (inline) {
    const streetAddress = normalizeSpace(raw.slice(0, inline.index));
    return { location: normalizeSpace(inline[2]), postalCode: inline[1], streetAddress };
  }

  // Bare 4-digit postal code anywhere, city unknown → keep raw as location.
  const plzOnly = raw.match(/(?:^|\s)(\d{4})(?:\s|$)/);
  return { location: raw, postalCode: plzOnly ? plzOnly[1] : '', streetAddress: '' };
}

/**
 * Plain text of the detail body with its structure kept: headings as `##`
 * lines, `<li>` as `• ` bullets, paragraphs on their own lines. Collapsing
 * every newline (the former `normalizeSpace(stripHtml(…))`) turned each
 * posting into one paragraph with inline bullets.
 */
export function impleniaDetailText(html = '') {
  const withHeadings = String(html || '').replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, heading) => {
    const text = normalizeSpace(stripHtml(heading));
    return text ? `\n\n## ${text}\n` : '';
  });
  return stripHtml(withHeadings)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch the full job-body description from an Implenia jobs2web detail page.
 * The RMK list endpoint carries no body; the detail page is server-rendered
 * plain HTML with the body in `itemprop="description"` schema.org/JobPosting
 * microdata — one span for the company intro, one per section after it
 * (verified live 2026-09-29), all read by `extractMicrodataDescription`.
 * fetchHtml follows the 302 to the canonical `/job/{slug}/{seq}-de_DE/` URL.
 * Returns the description and publication date from the same response.
 * RMK unifiedStandardStart is not used: its publication semantics are unverified.
 */
async function fetchImpleniaDetail(url) {
  if (!url || !/^https?:\/\//.test(url)) return { description: '', ...sourcePostingDateFields('') };
  try {
    const html = await fetchHtml(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': BROWSER_UA },
    });
    return {
      description: extractMicrodataDescription(html),
      ...sourcePostingDateFields(extractJobPostingField(html, 'datePosted')),
    };
  } catch {
    return { description: '', ...sourcePostingDateFields('') }; // network/timeout → metadata lede only
  }
}

/**
 * Fetch all Implenia jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllImpleniaJobs() {
  console.log(`🔍 Fetching Implenia jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;
    // Un URL fuori dal formato delle posizioni non ha chiave: resta distinto
    // per URL, come prima, invece di collassare su una chiave vuota.
    const matchKey = impleniaJobMatchKey(publicUrl) || publicUrl;
    if (seen.has(matchKey)) continue;
    seen.add(matchKey);

    const geography = resolveSourceBackedSwissGeography(listing.location);
    if (!geography) continue;
    const { location, canton } = geography;
    const postalCode = listing.postalCode || (location === HQ.city ? HQ.postalCode : '');
    const streetAddress = listing.streetAddress || (location === HQ.city ? HQ.streetAddress : '');
    const addressRegion = canton;

    // The RMK listing API carries no description body. Fetch the REAL job body
    // from the server-rendered detail page's itemprop="description" microdata
    // so jobs aren't thin → boilerplate-padded → boilerplate-guard failure
    // (#1723). Fall back to a concise metadata lede on any fetch failure
    // (fail-per-record, never fake content).
    const detail = await fetchImpleniaDetail(publicUrl);
    const detailDescHtml = detail.description;
    const detailDescText = detailDescHtml
      ? impleniaDetailText(detailDescHtml)
      : '';
    const descParts = [title];
    if (listing.jobFunction) descParts.push(listing.jobFunction);
    if (location) descParts.push(location);
    const descriptionText = detailDescText
      || `${descParts.join(' — ')}. ${IMPLENIA_COMPANY_NAME}, ${SECTOR.split('(')[0].trim()}.`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} implenia ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `implenia-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: IMPLENIA_COMPANY_NAME,
      companyKey: IMPLENIA_KEY,
      companyDomain: IMPLENIA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Implenia Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      streetAddress,
      addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(`${title} ${listing.jobFunction || ''}`),
      contract: 'full-time',
      employmentType: detectEmploymentType(`${listing.contractType || ''} ${title}`),
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(detail.datePosted),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Implenia jobs discovered: ${jobs.length}`);
  return jobs;
}

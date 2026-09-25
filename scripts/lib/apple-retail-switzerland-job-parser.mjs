#!/usr/bin/env node
/**
 * Apple Retail Switzerland job parser — Fetcher and job builder.
 *
 * Source: https://jobs.apple.com/en-us/search (Location filter = Switzerland)
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAppleRetailSwitzerlandJobs()  — Fetch and parse all jobs
 *   - isAppleRetailSwitzerlandJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const APPLE_RETAIL_SWITZERLAND_KEY = 'apple-retail-switzerland';
export const APPLE_RETAIL_SWITZERLAND_COMPANY_NAME = 'Apple Retail Switzerland';
export const APPLE_RETAIL_SWITZERLAND_COMPANY_DOMAIN = 'jobs.apple.com';

const CAREER_URL = 'https://jobs.apple.com/en-us/search';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Apple Retail Switzerland.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAppleRetailSwitzerlandJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === APPLE_RETAIL_SWITZERLAND_KEY ||
    key.startsWith('apple-retail-switzerland') ||
    company.includes('apple retail switzerland') ||
    url.includes('jobs.apple.com')
  );
}

/**
 * Validate that a URL belongs to Apple Retail Switzerland's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.apple.com' || host.endsWith('.jobs.apple.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
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
  const t = normalize(title);
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

/**
 * Resolve the canton for a retail listing's location. A bare `'Switzerland'`
 * location (no source city — company-wide retail pipeline roles) carries no
 * local evidence, so it gets an empty canton instead of guessing a specific
 * one: mirrors `resolveSwissLocation()` in microsoft-job-parser.mjs for the
 * same "country-only posting" case, avoiding a silent HQ (Zürich) route.
 */
export function resolveAppleRetailSwitzerlandCanton(location = '') {
  if (location === 'Switzerland') return '';
  return inferSwissTargetCanton(location) || 'ZH';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

// Apple's own bespoke jobsite platform (jobs.apple.com) — NOT Workday
// despite the marquee-list ATS hint. It exposes a JSON search API guarded by
// a per-session CSRF token:
//   1. GET  /api/v1/CSRFToken → `x-apple-csrf-token` response header + `jobs` session cookie
//   2. POST /api/v1/search    → { query, filters:{ locations:[postLocationId] }, page, locale, sort }
// The `locations` filter value is NOT a free-text country name — it's the
// opaque `postLocationId` resolved via the typeahead endpoint
// `/api/v1/refData/postlocation?input=Switzerland`, confirmed live to be
// `postLocation-CHEC`. Posting a plain "switzerland" string (or omitting the
// CSRF header) returns HTTP 200 with an EMPTY result set — Apple fails soft,
// not with an error, so the CSRF + resolved postLocationId dance is
// mandatory to get real data, not optional hardening.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const CSRF_URL = 'https://jobs.apple.com/api/v1/CSRFToken';
const SEARCH_URL = 'https://jobs.apple.com/api/v1/search';
const SWITZERLAND_LOCATION_ID = 'postLocation-CHEC';
const PAGE_SAFETY_CAP = 25; // pages; well above Apple's current ~1-page CH volume

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
 * Bootstrap an Apple jobsite session: GET /api/v1/CSRFToken to obtain the
 * `x-apple-csrf-token` response header + the `jobs` session cookie. Both are
 * required on the subsequent POST /api/v1/search (missing either yields an
 * empty-but-200 response, not an HTTP error).
 */
async function bootstrapSession() {
  const res = await fetchWithTimeout(CSRF_URL, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bootstrapping ${CSRF_URL}`);

  const rawCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  const cookie = rawCookies
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');

  const csrfToken = res.headers.get('x-apple-csrf-token') || '';
  if (!csrfToken) throw new Error('x-apple-csrf-token header not found in CSRFToken response');

  return { cookie, csrfToken };
}

/**
 * Fetch all Switzerland job listings from jobs.apple.com's JSON search API,
 * paginating until a page returns fewer results than the first page's size
 * or the cumulative count reaches `totalRecords`.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  const { cookie, csrfToken } = await bootstrapSession();
  const headers = {
    'User-Agent': BROWSER_UA,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Cookie: cookie,
    'X-Apple-CSRF-Token': csrfToken,
    Referer: CAREER_URL,
    Origin: 'https://jobs.apple.com',
  };

  const listings = [];
  let page = 1;
  let totalRecords = Infinity;
  let pageSize = 0;

  while (listings.length < totalRecords && page <= PAGE_SAFETY_CAP) {
    const res = await fetchWithTimeout(SEARCH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: '',
        filters: { locations: [SWITZERLAND_LOCATION_ID] },
        page,
        locale: 'en-us',
        sort: 'newest',
        format: { longDate: 'MMMM D, YYYY', mediumDate: 'MMM D, YYYY' },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on search page ${page}`);

    const payload = await res.json();
    if (payload?.error) throw new Error(`Apple search API error: ${payload.error}`);

    const pageResults = payload?.res?.searchResults || [];
    totalRecords = Number(payload?.res?.totalRecords ?? pageResults.length);
    if (page === 1) pageSize = pageResults.length;

    listings.push(...pageResults);

    if (pageResults.length === 0 || (pageSize > 0 && pageResults.length < pageSize)) break;
    page += 1;
    await new Promise((r) => setTimeout(r, 250)); // Rate limiting between pages
  }

  return listings;
}

/**
 * Build the canonical public job URL:
 * https://jobs.apple.com/en-us/details/{positionId}/{transformedPostingTitle}?team={teamID}
 * (verified live: HTTP 200, matches the anchor href generated by the site's
 * own search-result links).
 */
function buildJobUrl(listing) {
  const positionId = String(listing?.positionId || '').trim();
  const slugPart = String(listing?.transformedPostingTitle || '').trim();
  const teamId = String(listing?.team?.teamID || '').replace(/^teamsAndSubTeams-/, '');
  if (!positionId) return CAREER_URL;
  const base = `https://jobs.apple.com/en-us/details/${positionId}${slugPart ? `/${slugPart}` : ''}`;
  return teamId ? `${base}?team=${encodeURIComponent(teamId)}` : base;
}

/**
 * Fetch all Apple Retail Switzerland jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllAppleRetailSwitzerlandJobs() {
  console.log(`🔍 Fetching Apple Retail Switzerland jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seenIds = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.postingTitle || '');
    const positionId = String(listing.positionId || listing.jobPositionId || '').trim();
    if (!title || title.length < 3 || !positionId || seenIds.has(positionId)) continue;
    seenIds.add(positionId);

    // Apple's own location entries carry a `name` (city, or bare "Switzerland"
    // for company-wide retail pipeline roles) — never a street/canton string.
    const locationEntry = Array.isArray(listing.locations) ? listing.locations[0] : null;
    const location = normalizeSpace(locationEntry?.name || 'Switzerland');
    const canton = resolveAppleRetailSwitzerlandCanton(location);
    const descriptionSource = listing.jobSummary || '';
    const descriptionText =
      stripHtml(descriptionSource) || `${title} — Apple Retail Switzerland`;
    const publicUrl = buildJobUrl(listing);

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} apple-retail-switzerland ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = listing.postDateInGMT
      ? String(listing.postDateInGMT).slice(0, 10)
      : new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `apple-retail-switzerland-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: APPLE_RETAIL_SWITZERLAND_COMPANY_NAME,
      companyKey: APPLE_RETAIL_SWITZERLAND_KEY,
      companyDomain: APPLE_RETAIL_SWITZERLAND_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Apple Retail Switzerland Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: listing?.team?.teamName === 'Apple Retail' ? 'Commerciale' : detectCategory(title),
      contract: 'full-time',
      employmentType:
        Number(listing.standardWeeklyHours) > 0
          ? Number(listing.standardWeeklyHours) < 35
            ? 'PART_TIME'
            : 'FULL_TIME'
          : detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Retail',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Apple Retail Switzerland jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Marriott International job parser — Paradox AI careers API.
 *
 * The Marriott career portal (careers.marriott.com) runs on the Paradox AI
 * platform. The public search API requires a session cookie obtained from
 * the initial page load, then returns paginated JSON filtered by country.
 *
 * API flow:
 *   1. GET  https://careers.marriott.com/jobs → sets session cookie
 *   2. POST https://careers.marriott.com/api/get-jobs?filter[country]=Switzerland
 *        Body: {"site_available_languages":["en"]}
 *        Pagination: page_number (1-based), 10 results per page
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMarriottJobs()  — Fetch and parse all Swiss jobs
 *   - isMarriottJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 *
 * Source: https://careers.marriott.com/jobs?country=Switzerland
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MARRIOTT_KEY = 'marriott';
export const MARRIOTT_COMPANY_NAME = 'Marriott International';
export const MARRIOTT_COMPANY_DOMAIN = 'marriott.com';

const BASE_URL = 'https://careers.marriott.com';
const JOBS_PAGE_URL = `${BASE_URL}/jobs`;
const API_URL = `${BASE_URL}/api/get-jobs`;
const PAGE_SIZE = 10; // Paradox API max per page

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ── Valais postal code lookup ────────────────────────────── */

const VS_POSTAL_CODES = {
  verbier: '1936',
  zermatt: '3920',
  'crans-montana': '3963',
  sion: '1950',
  sierre: '3960',
  brig: '3900',
  visp: '3930',
  martigny: '1920',
  monthey: '1870',
  naters: '3904',
  saas: '3906',
  leukerbad: '3954',
};

/* ── Helpers ───────────────────────────────────────────────── */

/**
 * Extract a named custom field value from the Paradox API response.
 */
function getCustomField(customFields = [], key) {
  const cf = customFields.find(
    (f) => f.cfKey === key || f.key === key,
  );
  return cf?.value || '';
}

/**
 * Infer the Marriott brand display name from the API brandName field.
 * Some listings embed the brand in the title (e.g., "W VERBIER").
 */
function cleanBrandName(brandName = '') {
  return normalizeSpace(brandName) || 'Marriott';
}

/**
 * Build the public-facing job detail URL from the originalURL slug.
 */
function buildJobUrl(originalUrl = '', uniqueId = '') {
  if (originalUrl) return `${BASE_URL}/${originalUrl}`;
  if (uniqueId) return `${JOBS_PAGE_URL}?id=${uniqueId}`;
  return JOBS_PAGE_URL;
}

/**
 * Infer postal code from city name. Falls back to the zipCode from the API
 * or '1936' (Verbier) as default since most Marriott Valais jobs are there.
 */
function inferPostalCode(city = '', apiZipCode = '') {
  if (apiZipCode && apiZipCode.trim()) return apiZipCode.trim();
  const key = String(city || '').toLowerCase().replace(/[^a-z-]/g, '');
  return VS_POSTAL_CODES[key] || '1936';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Marriott International (any brand).
 */
export function isMarriottJob(job) {
  const key = String(job?.companyKey || job?.company || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === MARRIOTT_KEY ||
    key.startsWith('marriott') ||
    company.includes('marriott international') ||
    company.includes('marriott') ||
    url.includes('careers.marriott.com') ||
    url.includes('marriott.com')
  );
}

/**
 * Validate that a URL belongs to Marriott's domains.
 * Includes Oracle Cloud HCM (used for apply URLs).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'marriott.com' ||
      host.endsWith('.marriott.com') ||
      host.endsWith('.oraclecloud.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection (hospitality-focused) ─────────────── */

function detectCategory(title = '', jobField = '') {
  const t = (title + ' ' + jobField).toLowerCase();
  if (/\b(food|beverage|f&b|bar|chef|cuis|cook|kitchen|baker|pastry|patisserie|sommelier|barman|barista)/.test(t)) return 'hospitality-food-beverage';
  if (/\b(front.?desk|reception|welcome|concierge|guest.?service|guest.?relation|bellboy|bellman|porter)/.test(t)) return 'hospitality-front-office';
  if (/\b(housekeeper|housekeep|room.?attendant|laundry|linen|style.?agent|style.?director)/.test(t)) return 'hospitality-housekeeping';
  if (/\b(spa|wellness|therapist|massage|fitness)/.test(t)) return 'hospitality-spa';
  if (/\b(event|banquet|conference|meeting|convention)/.test(t)) return 'hospitality-events';
  if (/\b(revenue|reservat|yield|pricing)/.test(t)) return 'finance';
  if (/\b(mainten|engineer|techni|hvac|plumb|electri|facilit)/.test(t)) return 'maintenance';
  if (/\b(market|communicat|brand|digital|social)/.test(t)) return 'marketing';
  if (/\b(hr|human.?resource|talent|recruit|personal)/.test(t)) return 'human-resources';
  if (/\b(finance|account|controll|audit|budget|payroll)/.test(t)) return 'finance';
  if (/\b(sales|commercial|business.?develop)/.test(t)) return 'sales';
  if (/\b(it|software|system|tech|data|cyber)/.test(t)) return 'technology';
  if (/\b(admin|secretary|office|clerk)/.test(t)) return 'administration';
  if (/\b(security|safety|loss.?prevention)/.test(t)) return 'security';
  if (/\b(store|purchas|procur|warehouse|logist)/.test(t)) return 'logistics';
  return 'hospitality';
}

function detectExperienceLevel(title = '', accountName = '') {
  const t = (title + ' ' + accountName).toLowerCase();
  if (/\b(stagiaire|intern|stage|apprenti|voyage.?program|praktik|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(director|head|chef.?de|manager|supervisor|lead|senior|sr|verantwort|responsab)/.test(t)) return 'senior';
  if (/\b(management)/.test(t) && !/non-management/i.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(employmentTypeArr = []) {
  if (!Array.isArray(employmentTypeArr) || employmentTypeArr.length === 0) return 'OTHER';
  const types = employmentTypeArr.map((t) => String(t).toUpperCase());
  if (types.includes('FULL_TIME')) return 'FULL_TIME';
  if (types.includes('PART_TIME')) return 'PART_TIME';
  if (types.includes('TEMPORARY')) return 'TEMPORARY';
  if (types.includes('CONTRACT')) return 'CONTRACT';
  return 'OTHER';
}

/* ── Cookie-based API client ──────────────────────────────── */

/**
 * Obtain a session cookie by fetching the main jobs page.
 * Returns the Set-Cookie header values as a cookie string.
 */
async function obtainSessionCookie() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(JOBS_PAGE_URL, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching jobs page for cookie`);
    }

    // Extract Set-Cookie headers
    const cookies = [];
    const setCookieHeaders = res.headers.getSetCookie?.() || [];
    for (const header of setCookieHeaders) {
      const nameValue = header.split(';')[0];
      if (nameValue) cookies.push(nameValue);
    }

    // Consume body to complete the request
    await res.text();

    return cookies.join('; ');
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Call the Paradox search API with cookie authentication.
 */
async function callSearchApi(cookie, pageNumber = 1) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${API_URL}?filter%5Bcountry%5D=Switzerland&page_number=${pageNumber}&page_size=${PAGE_SIZE}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Referer: `${JOBS_PAGE_URL}?country=Switzerland`,
        Origin: BASE_URL,
        Cookie: cookie,
      },
      body: JSON.stringify({
        site_available_languages: ['en'],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from Paradox search API (page ${pageNumber})`);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch all Swiss job listings from the Paradox API.
 * Paginates through all pages (10 per page, 1-based page_number).
 */
async function fetchJobListings() {
  console.log('  🍪 Obtaining session cookie...');
  const cookie = await obtainSessionCookie();
  if (!cookie) {
    console.warn('  ⚠️ No session cookie obtained — API may reject requests.');
  } else {
    console.log('  ✅ Session cookie obtained.');
  }

  const allListings = [];
  let pageNumber = 1;
  let totalJob = 0;

  while (true) {
    console.log(`  📄 Fetching page ${pageNumber}...`);
    const data = await callSearchApi(cookie, pageNumber);
    totalJob = data.totalJob || totalJob;
    const jobs = data.jobs || [];

    if (jobs.length === 0) break;
    allListings.push(...jobs);

    console.log(`     → ${jobs.length} jobs (total so far: ${allListings.length}/${totalJob})`);

    if (allListings.length >= totalJob) break;
    if (jobs.length < PAGE_SIZE) break;

    pageNumber++;
    await new Promise((r) => setTimeout(r, 500)); // Rate limiting
  }

  return allListings;
}

/* ── Build job from API data ──────────────────────────────── */

function buildJobFromApi(listing) {
  const title = normalizeSpace(listing.title || '');
  if (!title || title.length < 3) return null;

  const loc = listing.locations?.[0] || {};
  const city = normalizeSpace(loc.city || '');
  const state = normalizeSpace(loc.state || '');
  const stateAbbr = normalizeSpace(loc.stateAbbr || '');
  const streetAddress = normalizeSpace(loc.streetAddress || '');
  const locationName = normalizeSpace(loc.locationName || '');
  const apiZipCode = String(loc.zipCode || loc.postalCode || '').trim();

  // Use the state abbreviation if available (e.g., "VS" for Valais)
  const canton = stateAbbr || inferSwissTargetCanton(city + ' ' + state) || 'VS';
  const postalCode = inferPostalCode(city, apiZipCode);
  const location = city || state || 'Verbier';

  // Description: strip HTML from the rich description
  const descriptionHtml = listing.description || '';
  const descriptionText = stripHtml(descriptionHtml);

  // Job field from custom fields
  const jobField = getCustomField(listing.customFields, 'cf_jobfield') ||
    getCustomField(listing.customFields, 'Job Field');
  const brandName = cleanBrandName(listing.brandName);
  const accountName = normalizeSpace(listing.accountName || '');

  // Build the public URL
  const publicUrl = buildJobUrl(listing.originalURL, listing.uniqueID);

  // Source language detection
  const sourceLang = detectLang(descriptionText || title, 'en');

  // Build slug with brand for uniqueness
  const locationForSlug = city || 'switzerland';
  const jobSlug = slugify(`${title} ${MARRIOTT_KEY} ${locationForSlug}`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

  // Posted date from custom field or fallback to today
  const publishEndDate = getCustomField(listing.customFields, 'cf_publish_job_end_date') ||
    getCustomField(listing.customFields, 'Publish Job End Date');

  return {
    // ── Required fields ──
    id: `${MARRIOTT_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: MARRIOTT_COMPANY_NAME,
    companyKey: MARRIOTT_KEY,
    companyDomain: MARRIOTT_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText || `${title} — ${MARRIOTT_COMPANY_NAME}`,
    descriptionByLocale: {
      [sourceLang]: descriptionText || `${title} — ${MARRIOTT_COMPANY_NAME}`,
    },
    location,
    canton,
    url: publicUrl,
    source: 'Marriott International Dedicated Parser (Paradox API)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: location,
    streetAddress: streetAddress || locationName || location,
    postalCode,
    addressCountry: 'CH',
    country: 'CH',
    category: detectCategory(title, jobField),
    contract: detectEmploymentType(listing.employmentType).includes('PART')
      ? 'part-time'
      : 'full-time',
    employmentType: detectEmploymentType(listing.employmentType),
    experienceLevel: detectExperienceLevel(title, accountName),
    sector: 'Hôtellerie / Hospitality',
    currency: 'CHF',
    featured: false,
    postedDate: new Date().toISOString().split('T')[0],
    applyUrl: listing.applyURL || publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },

    // ── Marriott-specific metadata ──
    _marriottMeta: {
      requisitionID: listing.requisitionID || '',
      uniqueID: listing.uniqueID || '',
      brandName,
      locationName,
      jobField,
      accountName,
      publishEndDate: publishEndDate || '',
    },
  };
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Marriott International jobs in Switzerland.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllMarriottJobs() {
  console.log(`🏨 Fetching Marriott International jobs (Switzerland)`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Portal: ${JOBS_PAGE_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned from Paradox API.');
    return [];
  }

  console.log(`\n  📋 Raw listings fetched: ${listings.length}\n`);

  const jobs = [];
  for (const listing of listings) {
    const job = buildJobFromApi(listing);
    if (!job) {
      console.warn(`  ⚠️ Skipping listing — title too short or missing.`);
      continue;
    }
    jobs.push(job);
    console.log(`  ✅ ${job.title} | ${job.location}, ${job.canton} (${job._marriottMeta.brandName})`);
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total unique Marriott Switzerland jobs: ${deduped.length}`);
  return deduped;
}

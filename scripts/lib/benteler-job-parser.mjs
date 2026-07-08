#!/usr/bin/env node
/**
 * Benteler job parser — Fetcher and job builder.
 *
 * Source: https://career.benteler.jobs/search/?locale=en_US
 *
 * ISSUE #3797 FALSE-NEGATIVE FIX: the previous parser targeted
 * `career.benteler.com` (a TYPO3 marketing site, not a job board at all)
 * with invented SuccessFactors API URLs that never existed. Benteler's
 * real job board lives on a completely different domain: a SAP
 * SuccessFactors "Jobs2Web" career site at `career.benteler.jobs`. It is
 * fully server-rendered HTML (no JS/API needed) — listing rows are
 * `<tr class="data-row">` blocks with `jobTitle-link`/`jobLocation`
 * spans, paginated via `?startrow=N` (25 rows/page), and detail pages
 * carry schema.org `JobPosting` microdata.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBentelerJobs()  — Fetch and parse all jobs
 *   - isBentelerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BENTELER_KEY = 'benteler';
export const BENTELER_COMPANY_NAME = 'Benteler';
export const BENTELER_COMPANY_DOMAIN = 'benteler.com';

const CAREER_HOST = 'career.benteler.jobs';
const CAREER_URL = `https://${CAREER_HOST}/search/?locale=en_US`;
const HQ = getCompanyDefaults('benteler');

const PAGE_SIZE = 25;
const MAX_PAGES = 40; // safety cap (40 * 25 = 1000 rows)

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Benteler.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBentelerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BENTELER_KEY ||
    key.startsWith('benteler') ||
    company.includes('benteler') ||
    url.includes('benteler.com') ||
    url.includes('benteler.jobs')
  );
}

/**
 * Validate that a URL belongs to Benteler's domain (marketing site or the
 * SuccessFactors Jobs2Web career board, which lives on `benteler.jobs`).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'benteler.com' ||
      host.endsWith('.benteler.com') ||
      host === 'benteler.jobs' ||
      host.endsWith('.benteler.jobs')
    );
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/* ── Jobs2Web listing + detail (server-rendered HTML) ─────── */

/**
 * Check if a location string indicates a Swiss target location.
 *
 * Jobs2Web location text is formatted "City, RegionCode, CountryCode" (e.g.
 * "Paderborn, NW, DE" or "Sierre, VS, CH"). A trailing 2/3-letter country
 * code, when present, is authoritative and MUST be checked before falling
 * back to fuzzy canton/city matching: Swiss canton abbreviations collide
 * with foreign region codes (e.g. "NW" = Nidwalden in Switzerland, but also
 * Nordrhein-Westfalen in Germany) — without this guard, `isTargetSwissLocation()`
 * false-positives on every German posting whose region code happens to
 * match a Swiss canton code.
 */
function isSwissLocation(location = '') {
  const loc = String(location || '').trim();
  if (!loc) return false;
  if (/\b(schweiz|switzerland|suisse|svizzera)\b/i.test(loc)) return true;
  const parts = loc.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].toUpperCase();
    if (/^[A-Z]{2,3}$/.test(last)) {
      return last === 'CH';
    }
  }
  return isTargetSwissLocation(loc);
}

/**
 * Parse one Jobs2Web search-results page (server-rendered `<tr class="data-row">`
 * table). Returns `{ rows, total }` where `total` is the "Results X to Y of
 * TOTAL" count parsed from the page (0 if not found).
 */
function parseSearchPage(html = '') {
  const rows = [];
  const blocks = String(html || '').split('<tr class="data-row">').slice(1);
  for (const block of blocks) {
    const titleM = block.match(/class="jobTitle-link">([^<]*)</);
    const hrefM = block.match(/href="([^"]+)"\s*class="jobTitle-link"/);
    const locM = block.match(/<span class="jobLocation">\s*([^<]*?)\s*<\/span>/);
    const facM = block.match(/class="jobFacility">([^<]*)</);
    if (!titleM || !hrefM) continue;
    rows.push({
      title: normalizeSpace(titleM[1]),
      href: hrefM[1],
      locationText: locM ? normalizeSpace(locM[1]) : '',
      facility: facM ? normalizeSpace(facM[1]) : '',
    });
  }
  const totalM = html.match(/Results\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i);
  return { rows, total: totalM ? Number(totalM[1]) : 0 };
}

/**
 * Fetch every Jobs2Web search-results page, then filter client-side for
 * Swiss locations. Note: on this tenant `jobFacility` holds a business-unit
 * name (e.g. "BENTELER Steel/Tube"), not a country, so filtering relies on
 * the `jobLocation` text via `isSwissLocation()`.
 */
async function listSwissJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const allRows = [];
  let startrow = 0;
  let expectedTotal = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${CAREER_URL}&startrow=${startrow}`;
    let html;
    try {
      html = await fetchHtml(url, { timeoutMs });
    } catch (err) {
      if (startrow === 0) console.warn(`⚠️ Failed to fetch Jobs2Web listing: ${err.message}`);
      break;
    }
    const { rows, total } = parseSearchPage(html);
    if (page === 0) expectedTotal = total;
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (expectedTotal > 0 && allRows.length >= expectedTotal) break;
    startrow += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  const swissRows = allRows.filter((r) => isSwissLocation(r.locationText));
  console.log(`  🎯 Filtered ${allRows.length} total → ${swissRows.length} Swiss jobs`);
  return swissRows;
}

/**
 * Fetch and parse a job detail page (schema.org `JobPosting` microdata,
 * server-rendered — no JS needed).
 */
async function fetchJobDetail(href) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const url = href.startsWith('http') ? href : `https://${CAREER_HOST}${href}`;
  let html;
  try {
    html = await fetchHtml(url, { timeoutMs });
  } catch (err) {
    console.warn(`⚠️ Detail fetch failed for ${url}: ${err.message}`);
    return null;
  }

  const addrM = html.match(
    /itemprop="addressLocality" content="([^"]*)"[\s\S]{0,200}?itemprop="addressRegion" content="([^"]*)"[\s\S]{0,200}?itemprop="postalCode" content="([^"]*)"[\s\S]{0,200}?itemprop="addressCountry" content="([^"]*)"/,
  );
  const dateM = html.match(/itemprop="datePosted" content="([^"]*)"/);

  let descriptionHtml = '';
  const startMarker = '<span class="jobdescription">';
  const start = html.indexOf(startMarker);
  if (start !== -1) {
    const from = start + startMarker.length;
    const endMarker = '<p class="job-location">';
    const end = html.indexOf(endMarker, from);
    descriptionHtml = html.slice(from, end !== -1 ? end : from + 20000);
  }

  let postedDate = '';
  if (dateM) {
    const d = new Date(dateM[1]);
    if (!Number.isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
  }

  return {
    addressLocality: addrM ? addrM[1] : '',
    addressRegion: addrM ? addrM[2] : '',
    postalCode: addrM ? addrM[3] : '',
    addressCountry: addrM ? addrM[4] : '',
    postedDate,
    descriptionHtml,
    url,
  };
}

/**
 * Fetch all Benteler jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export async function fetchAllBentelerJobs() {
  console.log(`🔍 Fetching Benteler jobs from ${CAREER_URL}`);
  console.log(`   Filter: Switzerland (jobLocation text)\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings found on the Jobs2Web board.');
    return [];
  }

  console.log(`  📋 Swiss job listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    if (!listing.href) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(listing.href);
    if (!detail) continue;

    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = normalizeSpace(detail.addressLocality || listing.locationText || '') || HQ?.city || 'Manno';
    const canton = inferAnyCanton(`${location} ${detail.addressRegion || ''}`) || HQ?.canton || '';
    const descriptionText = stripHtml(detail.descriptionHtml || '');
    const publicUrl = detail.url;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} benteler ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);

    const desc = descriptionText || `${title} — Stelle bei Benteler in ${location}, Schweiz. Benteler ist ein globaler Automobil- und Stahlzulieferer mit einem Standort in Manno (Tessin).`;

    const job = {
      id: `benteler-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BENTELER_COMPANY_NAME,
      companyKey: BENTELER_KEY,
      companyDomain: BENTELER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Benteler Dedicated Parser (Jobs2Web)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: detail.postalCode || HQ?.postalCode || '6928',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Automotive / Industria siderurgica',
      currency: 'CHF',
      featured: false,
      postedDate: detail.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Benteler jobs discovered: ${jobs.length}`);
  return jobs;
}

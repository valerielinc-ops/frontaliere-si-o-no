#!/usr/bin/env node
/**
 * Oerlikon job parser — Fetcher and job builder.
 *
 * Source: https://careers.oerlikon.com/search/
 *
 * ISSUE #3797 FALSE-NEGATIVE FIX: the previous parser guessed a
 * SuccessFactors REST URL (`/api/apply/v2/jobs`) that doesn't exist (returns
 * the search page's own HTML, not JSON), then fell back to a generic
 * JSDOM link-scrape that found 0 results — Oerlikon's SAP SuccessFactors
 * "Career Site Builder" (CSB) search page renders results via a client-side
 * AJAX POST, so there is no static HTML to scrape at all.
 *
 * Reverse-engineered from the page's own `j2w.searchManager.min.js`: the
 * search widget itself calls `POST /services/recruiting/v1/jobs` (relative
 * to `careers.oerlikon.com`) with a small JSON body
 * `{ keywords, locale, location, pageNumber, sortBy }` and gets back
 * `{ totalJobs, jobSearchResult: [{ response: {...} }] }` — plain JSON, no
 * auth needed, and the `location` field can be set server-side to
 * `"Switzerland"` to get a pre-filtered result set directly (confirmed:
 * unfiltered `totalJobs` is 144, matching evidence; CH-filtered is 8,
 * including the Riri/Mendrisio TI subsidiary).
 *
 * Detail pages are server-rendered at `/job/{urlTitle}/{id}-{locale}` (the
 * exact link format the search-results widget itself builds) and carry the
 * job description split across up to 3 `itemprop="description"` blocks
 * (intro image, main body, company footer) — no schema.org address
 * microdata is present, so location/date come from the search API instead.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllOerlikonJobs()  — Fetch and parse all jobs
 *   - isOerlikonJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml, fetchJson } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OERLIKON_KEY = 'oerlikon';
export const OERLIKON_COMPANY_NAME = 'Oerlikon';
export const OERLIKON_COMPANY_DOMAIN = 'oerlikon.com';

const CAREER_HOST = 'careers.oerlikon.com';
const CAREER_URL = `https://${CAREER_HOST}/search/`;
const SEARCH_API_URL = `https://${CAREER_HOST}/services/recruiting/v1/jobs`;
const LOCALE = 'en_US';
const PAGE_SIZE = 10;
const MAX_PAGES = 20; // safety cap (20 * 10 = 200 rows)

const HQ = getCompanyDefaults('oerlikon');

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Oerlikon.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isOerlikonJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === OERLIKON_KEY ||
    key.startsWith('oerlikon') ||
    company.includes('oerlikon') ||
    url.includes('oerlikon.com')
  );
}

/**
 * Validate that a URL belongs to Oerlikon's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'oerlikon.com' || host.endsWith('.oerlikon.com');
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|lehrstelle)/.test(t)) return 'intern';
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
 * Parse a US-style "M/D/YY" posting-date string (e.g. "6/1/26", "4/10/26")
 * as returned by the search API's `unifiedStandardStart` field.
 */
function parsePostedDate(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return '';
  const [, mo, day, yy] = m;
  const year = 2000 + Number(yy);
  const d = new Date(Date.UTC(year, Number(mo) - 1, Number(day)));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/* ── Search API + detail page ─────────────────────────────── */

/**
 * Fetch one page of Swiss-filtered search results from the recruiting
 * search servlet the site's own JS calls (`j2w.SearchManager.search`).
 */
async function fetchSearchPage(pageNumber) {
  const body = {
    keywords: '',
    locale: LOCALE,
    location: 'Switzerland',
    pageNumber,
    sortBy: 'recent',
  };
  const data = await fetchJson(SEARCH_API_URL, {
    method: 'POST',
    timeoutMs: 20000,
    body,
  });
  const rows = Array.isArray(data?.jobSearchResult)
    ? data.jobSearchResult.map((item) => item?.response).filter(Boolean)
    : [];
  return { rows, total: Number(data?.totalJobs) || 0 };
}

/**
 * Fetch every page of Swiss-filtered search results.
 */
async function listSwissJobs() {
  const allRows = [];
  let expectedTotal = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result;
    try {
      result = await fetchSearchPage(page);
    } catch (err) {
      if (page === 0) console.warn(`⚠️ Failed to fetch Oerlikon search API: ${err.message}`);
      break;
    }
    if (page === 0) expectedTotal = result.total;
    if (result.rows.length === 0) break;
    allRows.push(...result.rows);
    if (result.rows.length < PAGE_SIZE) break;
    if (expectedTotal > 0 && allRows.length >= expectedTotal) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`  🎯 Swiss-filtered jobs found: ${allRows.length}`);
  return allRows;
}

/**
 * Fetch and parse a job detail page. Description is spread across up to 3
 * `itemprop="description"` blocks (intro image, main body, company footer);
 * concatenate and strip them. No address microdata on this tenant — location
 * comes from the search API result instead.
 */
async function fetchJobDetail(detailUrl) {
  let html;
  try {
    html = await fetchHtml(detailUrl, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`⚠️ Detail fetch failed for ${detailUrl}: ${err.message}`);
    return null;
  }

  const blockRx = /itemprop="description"[^>]*>([\s\S]*?)<\/span>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g;
  const parts = [];
  let m;
  while ((m = blockRx.exec(html)) !== null) {
    parts.push(m[1]);
  }
  const descriptionHtml = parts.join('\n');

  return { descriptionHtml };
}

/**
 * Fetch all Oerlikon jobs (Switzerland-filtered via the search API).
 * Returns an array of ParsedJob objects (source-locale only).
 */
export async function fetchAllOerlikonJobs() {
  console.log(`🔍 Fetching Oerlikon jobs`);
  console.log(`   Source: ${SEARCH_API_URL} (location=Switzerland)\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Oerlikon Swiss job listings found.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.unifiedStandardTitle || '');
    const urlTitle = listing.urlTitle || '';
    const id = listing.id || '';
    if (!title || !id) continue;

    const publicUrl = `https://${CAREER_HOST}/job/${urlTitle}/${id}-${LOCALE}`;
    console.log(`  📄 Fetching detail: ${title}`);
    const detail = await fetchJobDetail(publicUrl);

    const rawLocation = Array.isArray(listing.jobLocationShort) ? listing.jobLocationShort[0] : '';
    const location = normalizeSpace(String(rawLocation || '').replace(/,?\s*(CHE|CH)\s*$/i, '')) || HQ?.city || 'Balzers';
    // The API returns bare city names with no canton for most listings (e.g.
    // "Wohlen, CHE"), and "Wohlen" alone is ambiguous (exists in both Aargau
    // and Bern) so the generic inferAnyCanton() helper won't guess. Oerlikon's
    // real site is Wohlen, Aargau (confirmed via this API's own per-job
    // coordinates: 47.35°N 8.29°E), so disambiguate known bare city names here
    // before falling back to the HQ default.
    const KNOWN_CITY_CANTON = { wohlen: 'AG' };
    const canton = inferAnyCanton(location) || KNOWN_CITY_CANTON[normalize(location)] || HQ?.canton || 'GR';
    const descriptionText = detail ? stripHtml(detail.descriptionHtml || '') : '';
    const desc = descriptionText || `${title} — Position at Oerlikon in ${location}, Switzerland. OC Oerlikon is a global technology group specializing in surface solutions, polymer processing, and additive manufacturing.`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} oerlikon ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);

    const job = {
      id: `oerlikon-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OERLIKON_COMPANY_NAME,
      companyKey: OERLIKON_KEY,
      companyDomain: OERLIKON_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Oerlikon Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'GR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '9496',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Tecnologia / Ingegneria di superficie',
      currency: 'CHF',
      featured: false,
      postedDate: parsePostedDate(listing.unifiedStandardStart) || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Oerlikon jobs discovered: ${jobs.length}`);
  return jobs;
}
